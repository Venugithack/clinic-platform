/**
 * Stock, FEFO and dispensing, as they behave today.
 *
 * This is the file Slices 3 and 4 will rewrite, so it is worth being precise
 * now about what the current code guarantees and what it merely happens to do.
 *
 * The guarantees worth keeping: the ledger and the batch balance agree, stock
 * never goes negative, expired batches are excluded rather than flagged, and
 * allocation is by earliest expiry across as many batches as it takes.
 *
 * The behaviours Slices 3 and 4 exist to change, recorded here so the change
 * is visible as a diff rather than a surprise: `dispense_rx` is all-or-nothing
 * and takes no quantity at all, `prescriptions.dispensed_at` is one timestamp,
 * the prescription's lines live only inside `items_json`, and nothing charges
 * for what was actually handed over.
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { as, clinicDate, closeClinic, makeStaff, resetClinic, rows, scalar } from '../support/clinic.mjs'

after(async () => { await closeClinic() })

/** An admin plus a pharmacist — the two roles inventory work needs. */
async function inventoryStaff() {
  await resetClinic()
  return {
    admin: await makeStaff({ name: 'Admin', roles: ['admin'], username: 'admin', pin: '482913' }),
    pharmacy: await makeStaff({ name: 'Pharmacist', roles: ['pharmacy'], username: 'pharm', pin: '573104' }),
  }
}

/**
 * A medicine with one opening batch. `add_medicine` is the only command that
 * creates a batch without a purchase order, which makes it the shortest route
 * to a known shelf in a test.
 */
async function addMedicine(staff, overrides = {}) {
  const spec = {
    code: 'PCM500',
    name: 'Paracetamol',
    strength: '500 mg',
    dosageForm: 'tablet',
    unit: 'tablet',
    saleClass: 'otc',
    schedule: 'OTC',
    reorderLevel: 20,
    targetStock: 200,
    initialQuantity: 0,
    ...overrides,
  }
  await as(staff, 'add_medicine', spec)
  return String(await scalar('select id from jmc.medicines where code=$1', [spec.code]))
}

/** A second, third, nth batch of an existing medicine, inserted like a receipt. */
async function addBatch(medicineId, { batchNumber, expiry, quantity, sellingPrice = 2, purchasePrice = 1, mrp = 3 }) {
  const [batch] = await rows(
    `insert into jmc.batches
       (id, medicine_id, batch_number, expiry, available_quantity, mrp, purchase_price,
        selling_price, received_at)
     values (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7,
             to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
     returning id`,
    [medicineId, batchNumber, expiry, quantity, mrp, purchasePrice, sellingPrice],
  )
  await rows(
    `insert into jmc.stock_movements
       (id, medicine_id, batch_id, movement_type, quantity_delta, reference_type,
        reference_id, actor_id, created_at)
     values (gen_random_uuid()::text, $1, $2, 'opening_stock', $3, 'medicine', $1,
             (select id from jmc.staff order by id limit 1),
             to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'))`,
    [medicineId, batch.id, quantity],
  )
  return String(batch.id)
}

/** What the ledger says this batch holds, independent of the cached column. */
async function ledgerBalance(batchId) {
  return Number(
    await scalar('select coalesce(sum(quantity_delta),0)::int from jmc.stock_movements where batch_id=$1', [batchId]),
  )
}

async function cachedBalance(batchId) {
  return Number(await scalar('select available_quantity from jmc.batches where id=$1', [batchId]))
}

describe('the stock ledger', () => {
  test('an opening quantity posts one positive movement that matches the batch', async () => {
    const { admin } = await inventoryStaff()
    const medicineId = await addMedicine(admin, {
      initialQuantity: 150, batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, purchasePrice: 18, sellingPrice: 30,
    })

    const [batch] = await rows('select id, available_quantity from jmc.batches where medicine_id=$1', [medicineId])
    assert.equal(Number(batch.available_quantity), 150)
    assert.equal(await ledgerBalance(batch.id), 150)

    const [movement] = await rows('select movement_type, quantity_delta from jmc.stock_movements')
    assert.equal(movement.movement_type, 'opening_stock')
    assert.equal(Number(movement.quantity_delta), 150)
  })

  test('every dispatch writes a negative movement, so the ledger reconstructs the shelf', async () => {
    const { admin, pharmacy } = await inventoryStaff()
    const medicineId = await addMedicine(admin, {
      initialQuantity: 40, batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, purchasePrice: 18, sellingPrice: 30,
    })
    const [batch] = await rows('select id from jmc.batches where medicine_id=$1', [medicineId])

    await as(pharmacy, 'otc_sale', { lines: [{ medicineId, quantity: 6 }], paymentMethod: 'cash' })

    assert.equal(await cachedBalance(batch.id), 34)
    assert.equal(await ledgerBalance(batch.id), 34, 'the ledger and the cached balance must agree')
  })

  test('stock cannot go negative — the sale is refused, not clamped', async () => {
    const { admin, pharmacy } = await inventoryStaff()
    const medicineId = await addMedicine(admin, {
      initialQuantity: 5, batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, purchasePrice: 18, sellingPrice: 30,
    })

    await assert.rejects(
      as(pharmacy, 'otc_sale', { lines: [{ medicineId, quantity: 6 }], paymentMethod: 'cash' }),
      /Only 5 unit\(s\) are available/,
    )

    // And nothing partial was left behind: no sale, no movement beyond opening.
    assert.equal(await scalar('select count(*)::int from jmc.otc_sales'), 0)
    assert.equal(await scalar('select count(*)::int from jmc.stock_movements'), 1)
  })
})

describe('FEFO allocation', () => {
  test('the earliest expiry goes first, and a shortfall splits across batches', async () => {
    const { admin, pharmacy } = await inventoryStaff()
    const medicineId = await addMedicine(admin, { initialQuantity: 0 })

    // Deliberately inserted late-expiry first, so passing cannot be an accident
    // of insertion order.
    const late = await addBatch(medicineId, { batchNumber: 'LATE', expiry: await clinicDate(400), quantity: 50, sellingPrice: 4 })
    const early = await addBatch(medicineId, { batchNumber: 'EARLY', expiry: await clinicDate(30), quantity: 20, sellingPrice: 2 })

    await as(pharmacy, 'otc_sale', { lines: [{ medicineId, quantity: 25 }], paymentMethod: 'cash' })

    assert.equal(await cachedBalance(early), 0, 'the earliest-expiry batch is emptied first')
    assert.equal(await cachedBalance(late), 45, 'the remainder comes from the later batch')

    // Both allocations are in the ledger, each naming its own batch — this is
    // what makes a recall traceable.
    const movements = await rows(
      `select batch_id, quantity_delta from jmc.stock_movements
        where movement_type='otc_sale' order by quantity_delta`,
    )
    assert.equal(movements.length, 2)
    assert.deepEqual(movements.map((m) => Number(m.quantity_delta)).sort((a, b) => a - b), [-20, -5])
  })

  test('the price charged is the batch’s, so two MRPs in one sale stay distinct', async () => {
    const { admin, pharmacy } = await inventoryStaff()
    const medicineId = await addMedicine(admin, { initialQuantity: 0 })
    await addBatch(medicineId, { batchNumber: 'EARLY', expiry: await clinicDate(30), quantity: 20, sellingPrice: 2 })
    await addBatch(medicineId, { batchNumber: 'LATE', expiry: await clinicDate(400), quantity: 50, sellingPrice: 4 })

    await as(pharmacy, 'otc_sale', { lines: [{ medicineId, quantity: 25 }], paymentMethod: 'cash' })

    // 20 at 2 plus 5 at 4.
    assert.equal(Number(await scalar('select total from jmc.otc_sales')), 60)
  })

  test('an expired batch is excluded from availability, not merely flagged', async () => {
    const { admin, pharmacy } = await inventoryStaff()
    const medicineId = await addMedicine(admin, { initialQuantity: 0 })
    const expired = await addBatch(medicineId, { batchNumber: 'GONE', expiry: await clinicDate(-1), quantity: 100 })
    const good = await addBatch(medicineId, { batchNumber: 'GOOD', expiry: await clinicDate(200), quantity: 10 })

    // 100 expired units are on the shelf and none of them count.
    await assert.rejects(
      as(pharmacy, 'otc_sale', { lines: [{ medicineId, quantity: 11 }], paymentMethod: 'cash' }),
      /Only 10 unit\(s\) are available/,
    )

    await as(pharmacy, 'otc_sale', { lines: [{ medicineId, quantity: 10 }], paymentMethod: 'cash' })
    assert.equal(await cachedBalance(expired), 100, 'the expired batch is untouched')
    assert.equal(await cachedBalance(good), 0)
  })

  test('expiry is compared against the clinic’s day, not the server’s', async () => {
    // The server runs UTC, five and a half hours behind the clinic. A batch
    // expiring "today" in Kolkata must still be dispensable for the whole
    // clinic day, including the stretch after 18:30 UTC when Greenwich has not
    // yet turned over. commands.ts uses (now() at time zone 'Asia/Kolkata').
    const { admin, pharmacy } = await inventoryStaff()
    const medicineId = await addMedicine(admin, { initialQuantity: 0 })
    await addBatch(medicineId, { batchNumber: 'TODAY', expiry: await clinicDate(0), quantity: 10 })

    await as(pharmacy, 'otc_sale', { lines: [{ medicineId, quantity: 3 }], paymentMethod: 'cash' })
    assert.equal(Number(await scalar('select count(*)::int from jmc.otc_sales')), 1)
  })

  test('only OTC-classed medicines may leave on a counter sale', async () => {
    const { admin, pharmacy } = await inventoryStaff()
    const medicineId = await addMedicine(admin, {
      code: 'AMX500', name: 'Amoxicillin', saleClass: 'prescription', schedule: 'H1',
      initialQuantity: 50, batchNumber: 'AMX-A', expiry: await clinicDate(400),
      mrp: 60, purchasePrice: 40, sellingPrice: 60,
    })

    await assert.rejects(
      as(pharmacy, 'otc_sale', { lines: [{ medicineId, quantity: 1 }], paymentMethod: 'cash' }),
      /Only medicines marked OTC/,
    )
  })
})

describe('dispensing a prescription — all-or-nothing today; Slice 4 makes it partial', () => {
  /** A patient with a signed prescription for `quantity` of `medicineId`. */
  async function prescribe(doctor, medicineId, quantity, { consultationFee = 0 } = {}) {
    await as(doctor, 'create_patient', { name: 'Test Patient', age: 40, sex: 'female', phone: '+915550000001' })
    const patientId = String(await scalar('select id from jmc.patients limit 1'))
    await as(doctor, 'save_consultation', {
      patientId,
      diagnosis: 'Fever',
      notes: '',
      advice: 'Rest',
      consultationFee,
      prescriptionItems: [
        { medicineId, medicineName: 'Paracetamol 500 mg', dosage: '1-0-1', instructions: 'After food', quantity },
      ],
    })
    return {
      patientId,
      prescriptionId: String(await scalar('select id from jmc.prescriptions limit 1')),
    }
  }

  async function clinic() {
    await resetClinic()
    return {
      admin: await makeStaff({ name: 'Admin', roles: ['admin'], username: 'admin', pin: '482913' }),
      doctor: await makeStaff({ name: 'Doctor', roles: ['doctor'], username: 'doc', pin: '573104' }),
      pharmacy: await makeStaff({ name: 'Pharmacist', roles: ['pharmacy'], username: 'pharm', pin: '618205' }),
    }
  }

  test('a signed prescription stores its lines as JSON and nothing else', async () => {
    const { admin, doctor } = await clinic()
    const medicineId = await addMedicine(admin, {
      initialQuantity: 100, batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, purchasePrice: 18, sellingPrice: 30,
    })
    await prescribe(doctor, medicineId, 10)

    // There is no prescription_lines table. Slice 4 adds one; until then the
    // remaining quantity cannot be enforced because there is nothing to
    // enforce it against.
    assert.equal(
      await scalar(
        `select count(*)::int from information_schema.tables
          where table_schema='jmc' and table_name='prescription_lines'`,
      ),
      0,
    )

    const items = JSON.parse(String(await scalar('select items_json from jmc.prescriptions')))
    assert.equal(items.length, 1)
    assert.equal(items[0].quantity, 10)
  })

  test('dispensing takes the whole prescription and accepts no quantity', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await addMedicine(admin, {
      initialQuantity: 100, batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, purchasePrice: 18, sellingPrice: 30,
    })
    const { prescriptionId } = await prescribe(doctor, medicineId, 10)

    // The command's whole payload is a prescription id. There is no way to
    // say "give six now" — that is exactly what Slice 4 adds.
    await as(pharmacy, 'dispense_rx', { prescriptionId })

    const [batch] = await rows('select id, available_quantity from jmc.batches')
    assert.equal(Number(batch.available_quantity), 90)
    assert.equal(await ledgerBalance(batch.id), 90)
    assert.ok(await scalar('select dispensed_at from jmc.prescriptions where id=$1', [prescriptionId]))
  })

  test('dispensing twice is refused by the single dispensed_at timestamp', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await addMedicine(admin, {
      initialQuantity: 100, batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, purchasePrice: 18, sellingPrice: 30,
    })
    const { prescriptionId } = await prescribe(doctor, medicineId, 10)

    await as(pharmacy, 'dispense_rx', { prescriptionId })
    await assert.rejects(as(pharmacy, 'dispense_rx', { prescriptionId }), /already dispensed/)

    // Stock moved exactly once. This is the property Slice 4 has to preserve
    // through an idempotency key once "dispensed" stops being one boolean.
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 90)
  })

  test('an out-of-stock line rolls the whole dispense back, stock and status together', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await addMedicine(admin, {
      initialQuantity: 4, batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, purchasePrice: 18, sellingPrice: 30,
    })
    const { prescriptionId } = await prescribe(doctor, medicineId, 10)

    await assert.rejects(as(pharmacy, 'dispense_rx', { prescriptionId }), /Only 4 unit\(s\) are available/)

    // The refusal is complete. An earlier version of this code did not await
    // allocateStock, so the prescription was marked dispensed, nothing left the
    // shelf, and the H1 register lost the entry.
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 4)
    assert.equal(await scalar('select dispensed_at from jmc.prescriptions where id=$1', [prescriptionId]), null)
    assert.equal(await scalar(`select count(*)::int from jmc.stock_movements where movement_type='prescription'`), 0)
  })

  test('the patient can be given nothing at all, and the clinic has no record of that', async () => {
    const { admin, doctor } = await clinic()
    const medicineId = await addMedicine(admin, {
      initialQuantity: 100, batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, purchasePrice: 18, sellingPrice: 30,
    })
    const { prescriptionId } = await prescribe(doctor, medicineId, 10)

    // Nothing is dispensed. `dispensed_at` stays null, which is also what
    // "waiting", "partially dispensed", "patient declined" and "cancelled" all
    // look like. The five states the plan needs are one nullable timestamp.
    assert.equal(await scalar('select dispensed_at from jmc.prescriptions where id=$1', [prescriptionId]), null)
  })

  test('a pharmacist may dispense; a doctor may not', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await addMedicine(admin, {
      initialQuantity: 100, batchNumber: 'PCM-A', expiry: await clinicDate(400),
      mrp: 30, purchasePrice: 18, sellingPrice: 30,
    })
    const { prescriptionId } = await prescribe(doctor, medicineId, 10)

    await assert.rejects(as(doctor, 'dispense_rx', { prescriptionId }), /role cannot perform/)
    await as(pharmacy, 'dispense_rx', { prescriptionId })
  })
})
