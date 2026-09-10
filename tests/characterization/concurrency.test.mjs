/**
 * What happens when two tablets do the same thing at the same time.
 *
 * The clinic runs on four tablets polling one database, and the brief's gate
 * for Slice 4 is that "concurrent/retried commands cannot over-dispense or
 * reduce stock below zero". This file establishes which half of that is
 * already true.
 *
 * The answer is: the stock ledger holds, and the prescription does not.
 * `allocateStock` guards every decrement with `available_quantity >= ?` in the
 * UPDATE itself, so a losing writer takes nothing and is told to retry.
 * `dispense_rx` guards its own completion with `dispensed_at is null` in the
 * UPDATE — and then does not look at whether that update changed a row. Two
 * concurrent dispenses of the same prescription both allocate.
 *
 * The failing case is marked `{ todo: ... }` rather than deleted or inverted.
 * It documents a real defect, it does not fail the suite today, and Slice 4
 * turns it green by fixing the code rather than by editing the test.
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

/** Ledger truth, which is the only balance worth asserting on. */
async function ledgerTotal() {
  return Number(await scalar('select coalesce(sum(quantity_delta),0)::int from jmc.stock_movements'))
}

describe('two counters, one batch', () => {
  test('the last ten tablets cannot be sold twice', async () => {
    const { admin, counterA, counterB } = await clinic()
    const medicineId = await stockedMedicine(admin, 10)

    const both = await Promise.allSettled([
      as(counterA, 'otc_sale', { lines: [{ medicineId, quantity: 10 }], paymentMethod: 'cash' }),
      as(counterB, 'otc_sale', { lines: [{ medicineId, quantity: 10 }], paymentMethod: 'cash' }),
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
      as(counterA, 'otc_sale', { lines: [{ medicineId, quantity: 10 }], paymentMethod: 'cash' }),
      as(counterB, 'otc_sale', { lines: [{ medicineId, quantity: 10 }], paymentMethod: 'cash' }),
    ])

    // One sale, one movement, and no orphaned receipt number in otc_sales.
    assert.equal(await scalar('select count(*)::int from jmc.otc_sales'), 1)
    assert.equal(await scalar(`select count(*)::int from jmc.stock_movements where movement_type='otc_sale'`), 1)
  })

  test('a burnt receipt number leaves a gap rather than a duplicate', async () => {
    const { admin, counterA, counterB } = await clinic()
    const medicineId = await stockedMedicine(admin, 10)

    await Promise.allSettled([
      as(counterA, 'otc_sale', { lines: [{ medicineId, quantity: 10 }], paymentMethod: 'cash' }),
      as(counterB, 'otc_sale', { lines: [{ medicineId, quantity: 10 }], paymentMethod: 'cash' }),
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
      patientId, diagnosis: 'Fever', consultationFee: 0,
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

  test(
    'when stock is plentiful, the same prescription is dispensed twice',
    {
      todo:
        'Defect, not a design. dispense_rx guards completion with `dispensed_at is null` ' +
        'in the UPDATE but never checks that the update changed a row, so two concurrent ' +
        'calls both pass the read, both allocate, and 20 tablets leave the shelf against ' +
        'a prescription for 10. Slice 4 fixes this with an idempotency key and a row lock ' +
        'taken before allocation; this test then passes without being edited.',
    },
    async () => {
      const { counterA, counterB, prescriptionId } = await signedPrescription({ stock: 100, prescribed: 10 })

      await Promise.allSettled([
        as(counterA, 'dispense_rx', { prescriptionId }),
        as(counterB, 'dispense_rx', { prescriptionId }),
      ])

      assert.equal(
        Number(await scalar('select available_quantity from jmc.batches')),
        90,
        'a prescription for 10 must never move more than 10',
      )
    },
  )

  test('the double dispense is real — this records it until Slice 4 removes it', async () => {
    const { counterA, counterB, prescriptionId } = await signedPrescription({ stock: 100, prescribed: 10 })

    const both = await Promise.allSettled([
      as(counterA, 'dispense_rx', { prescriptionId }),
      as(counterB, 'dispense_rx', { prescriptionId }),
    ])
    const succeeded = both.filter((r) => r.status === 'fulfilled').length
    const remaining = Number(await scalar('select available_quantity from jmc.batches'))

    // Whether both win is a race, so this asserts the invariant that actually
    // holds today rather than a specific losing outcome: the shelf always
    // agrees with the ledger, and 10 tablets left per successful call.
    assert.equal(remaining, await ledgerTotal(), 'the ledger and the shelf never disagree')
    assert.equal(remaining, 100 - 10 * succeeded)
    assert.ok(succeeded >= 1)
  })

  test('a sequential retry is refused, which is why this is not noticed', async () => {
    const { counterA, counterB, prescriptionId } = await signedPrescription({ stock: 100, prescribed: 10 })

    await as(counterA, 'dispense_rx', { prescriptionId })
    await assert.rejects(as(counterB, 'dispense_rx', { prescriptionId }), /already dispensed/)

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
