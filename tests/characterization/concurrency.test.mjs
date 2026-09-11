/**
 * What happens when two tablets do the same thing at the same time.
 *
 * The clinic runs on four tablets polling one database, and the brief's gate
 * for Slice 4 is that "concurrent/retried commands cannot over-dispense or
 * reduce stock below zero". This file establishes which half of that is
 * already true.
 *
 * When this file was written the answer was: the stock ledger holds, and the
 * prescription does not. `allocateStock` guards every decrement with
 * `available_quantity >= ?` in the UPDATE itself, so a losing writer takes
 * nothing. `dispense_rx` guarded its completion with `dispensed_at is null`
 * in the UPDATE and then never looked at whether that update changed a row —
 * so two concurrent dispenses of the same prescription both allocated, and a
 * prescription for ten tablets moved twenty off the shelf.
 *
 * That was recorded here as a failing `{ todo: ... }` test rather than
 * described in a comment, and the fix in commands.ts — a `for update` on the
 * prescription row taken before any stock moves, plus a checked row count on
 * the completing UPDATE — turned it green without the assertion being edited.
 * The assertion is unchanged; only the test's name and the todo marker went.
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { as, clinicDate, closeClinic, makeStaff, resetClinic, rows, scalar } from '../support/clinic.mjs'

after(async () => { await closeClinic() })

async function clinic() {
  await resetClinic()
  return {
    admin: await makeStaff({ name: 'Admin', roles: ['admin'], username: 'admin', pin: '482913' }),
    doctor: await makeStaff({ name: 'Doctor', roles: ['doctor'], username: 'doc', pin: '573104' }),
    counterA: await makeStaff({ name: 'Counter A', roles: ['pharmacy'], username: 'pa', pin: '618205' }),
    counterB: await makeStaff({ name: 'Counter B', roles: ['pharmacy'], username: 'pb', pin: '704816' }),
  }
}

async function stockedMedicine(admin, quantity) {
  await as(admin, 'add_medicine', {
    code: 'PCM500', name: 'Paracetamol', strength: '500 mg', dosageForm: 'tablet',
    unit: 'tablet', saleClass: 'otc', schedule: 'OTC', reorderLevel: 5, targetStock: 200,
    initialQuantity: quantity, batchNumber: 'PCM-A', expiry: await clinicDate(400),
    mrp: 30, purchasePrice: 18, sellingPrice: 30,
  })
  return String(await scalar(`select id from jmc.medicines where code='PCM500'`))
}

/**
 * A counter sale of `quantity`, paid in full in cash.
 *
 * Slice 4 requires the payment: policy register 46 says an anonymous sale is
 * settled at the time. ₹30 a tablet throughout this file, so the amount is the
 * quantity times thirty — written out rather than computed, because a test
 * that derives its expectation from the code under test proves nothing.
 */
const sell = (staff, medicineId, quantity) =>
  as(staff, 'otc_sale', {
    lines: [{ medicineId, quantity }],
    parts: [{ method: 'cash', amount: (quantity * 30).toFixed(2) }],
  })

/** Ledger truth, which is the only balance worth asserting on. */
async function ledgerTotal() {
  return Number(await scalar('select coalesce(sum(quantity_delta),0)::int from jmc.stock_movements'))
}

describe('two counters, one batch', () => {
  test('the last ten tablets cannot be sold twice', async () => {
    const { admin, counterA, counterB } = await clinic()
    const medicineId = await stockedMedicine(admin, 10)

    const both = await Promise.allSettled([
      sell(counterA, medicineId, 10),
      sell(counterB, medicineId, 10),
    ])

    const won = both.filter((r) => r.status === 'fulfilled')
    assert.equal(won.length, 1, `exactly one sale must win, got ${JSON.stringify(both.map((r) => r.status))}`)

    // The loser is told something a person at a counter can act on.
    const lost = both.find((r) => r.status === 'rejected')
    assert.match(String(lost.reason.message), /available|another tablet/i)

    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 0)
    assert.equal(await ledgerTotal(), 0, 'the ledger cannot go below zero either')
    assert.equal(await scalar('select count(*)::int from jmc.otc_sales'), 1)
  })

  test('a losing sale leaves no partial row behind', async () => {
    const { admin, counterA, counterB } = await clinic()
    const medicineId = await stockedMedicine(admin, 10)

    await Promise.allSettled([
      sell(counterA, medicineId, 10),
      sell(counterB, medicineId, 10),
    ])

    // One sale, one movement, and no orphaned receipt number in otc_sales.
    assert.equal(await scalar('select count(*)::int from jmc.otc_sales'), 1)
    assert.equal(await scalar(`select count(*)::int from jmc.stock_movements where movement_type='otc_sale'`), 1)
  })

  test('a burnt receipt number leaves a gap rather than a duplicate', async () => {
    const { admin, counterA, counterB } = await clinic()
    const medicineId = await stockedMedicine(admin, 10)

    await Promise.allSettled([
      sell(counterA, medicineId, 10),
      sell(counterB, medicineId, 10),
    ])

    // nextval() is outside the transaction on purpose: the rolled-back sale
    // consumed a number and did not reuse it. A gap is a question somebody
    // asks; a repeated receipt number is two documents nobody can tell apart.
    // GST expects a consecutive series, which is an open decision, not a bug.
    const receipts = (await rows('select receipt_number from jmc.otc_sales')).map((r) => r.receipt_number)
    assert.equal(receipts.length, 1)
    assert.equal(Number(await scalar(`select last_value from jmc.otc_receipt_seq`)), 2)
  })
})

describe('a prescription dispensed twice at once', () => {
  async function signedPrescription({ stock, prescribed }) {
    const staff = await clinic()
    const medicineId = await stockedMedicine(staff.admin, stock)
    await as(staff.doctor, 'create_patient', {
      name: 'Test Patient', age: 40, sex: 'female', phone: '+915550000001',
    })
    const patientId = String(await scalar('select id from jmc.patients'))
    await as(staff.doctor, 'save_consultation', {
      patientId, diagnosis: 'Fever', feeWaived: true, feeReason: 'Not what this test is about',
      prescriptionItems: [
        { medicineId, medicineName: 'Paracetamol 500 mg', dosage: '1-0-1', instructions: '', quantity: prescribed },
      ],
    })
    return { ...staff, prescriptionId: String(await scalar('select id from jmc.prescriptions')) }
  }

  test('when stock is tight, the batch guard saves it', async () => {
    const { counterA, counterB, prescriptionId } = await signedPrescription({ stock: 10, prescribed: 10 })

    const both = await Promise.allSettled([
      as(counterA, 'dispense_rx', { prescriptionId }),
      as(counterB, 'dispense_rx', { prescriptionId }),
    ])

    assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(await ledgerTotal(), 0)
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 0)
  })

  test('when stock is plentiful, the prescription is still dispensed exactly once', async () => {
    const { counterA, counterB, prescriptionId } = await signedPrescription({ stock: 100, prescribed: 10 })

    await Promise.allSettled([
      as(counterA, 'dispense_rx', { prescriptionId }),
      as(counterB, 'dispense_rx', { prescriptionId }),
    ])

    // The assertion that used to fail, unchanged. Before the row lock this
    // read 80: both counters passed the `dispensed_at is null` check and both
    // allocated, so a prescription for ten took twenty off the shelf. Stock
    // being plentiful is what made it possible — with only ten on hand the
    // batch guard caught it by accident, which is the test above.
    assert.equal(
      Number(await scalar('select available_quantity from jmc.batches')),
      90,
      'a prescription for 10 must never move more than 10',
    )
  })

  test('two simultaneous submissions: one dispense, one rejection, ten tablets', async () => {
    const { counterA, counterB, prescriptionId } = await signedPrescription({ stock: 100, prescribed: 10 })

    const both = await Promise.allSettled([
      as(counterA, 'dispense_rx', { prescriptionId }),
      as(counterB, 'dispense_rx', { prescriptionId }),
    ])

    // One dispense.
    const won = both.filter((result) => result.status === 'fulfilled')
    assert.equal(won.length, 1, `exactly one submission may succeed, got ${won.length}`)

    // One rejection, and one a person at a counter can act on: the second
    // pharmacist is told there is nothing left to hand over, not that
    // something went wrong with the database.
    //
    // The wording changed with Slice 4 and the property did not. "Already
    // dispensed" was a statement about a boolean; "nothing left to hand over"
    // is a statement about the quantity remaining, which is the thing that is
    // actually true once a prescription can be supplied in parts.
    const lost = both.filter((result) => result.status === 'rejected')
    assert.equal(lost.length, 1)
    assert.match(String(lost[0].reason.message), /nothing left to hand over/)

    // Exactly ten tablets, in the batch, in the ledger, and once in the
    // movement history — a losing transaction that rolled back must leave no
    // allocation behind.
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 90)
    assert.equal(await ledgerTotal(), 90, 'the ledger and the shelf never disagree')
    assert.equal(
      Number(await scalar(
        `select coalesce(sum(quantity_delta),0)::int from jmc.stock_movements
          where movement_type='prescription'`,
      )),
      -10,
    )
    assert.equal(
      await scalar(`select count(*)::int from jmc.stock_movements where movement_type='prescription'`),
      1,
    )

    // And the prescription is marked dispensed once, by whoever won.
    assert.ok(await scalar('select dispensed_at from jmc.prescriptions where id=$1', [prescriptionId]))
    assert.equal(
      await scalar(`select count(*)::int from jmc.audit_events where action='prescription.dispensed'`),
      1,
      'the audit trail must not record a dispense that rolled back',
    )
  })

  test('the losing counter can retry once stock is restocked, and is still refused', async () => {
    const { counterA, counterB, prescriptionId } = await signedPrescription({ stock: 100, prescribed: 10 })

    await Promise.allSettled([
      as(counterA, 'dispense_rx', { prescriptionId }),
      as(counterB, 'dispense_rx', { prescriptionId }),
    ])

    // A pharmacist who saw the refusal and taps again does not get a second
    // supply out of it. The refusal is about the prescription, not the shelf.
    await assert.rejects(as(counterB, 'dispense_rx', { prescriptionId }), /nothing left to hand over/)
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 90)
  })

  test('a sequential retry is refused, which is why this is not noticed', async () => {
    const { counterA, counterB, prescriptionId } = await signedPrescription({ stock: 100, prescribed: 10 })

    await as(counterA, 'dispense_rx', { prescriptionId })
    await assert.rejects(as(counterB, 'dispense_rx', { prescriptionId }), /nothing left to hand over/)

    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 90)
  })
})

describe('the revision counter', () => {
  test('every committed command bumps it exactly once', async () => {
    const { admin } = await clinic()
    const before = Number(await scalar('select revision from jmc.clinic_revision'))

    await as(admin, 'create_patient', { name: 'A Patient', age: 30, sex: 'male', phone: '+915550000002' })

    assert.equal(Number(await scalar('select revision from jmc.clinic_revision')), before + 1)
  })

  test('a rolled-back command does not bump it, so no tablet skips a change', async () => {
    const { admin } = await clinic()
    const before = Number(await scalar('select revision from jmc.clinic_revision'))

    await assert.rejects(as(admin, 'create_patient', { name: '', age: 30, sex: 'male', phone: '+91555' }))

    assert.equal(
      Number(await scalar('select revision from jmc.clinic_revision')),
      before,
      'the counter must never claim a write that rolled back',
    )
  })
})
