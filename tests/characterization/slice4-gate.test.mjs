/**
 * Slice 4's exit gate: dispensing, OTC, fees, billing and payments.
 *
 * The list this file works through is the one the brief sets for Slice 4 —
 * full dispense, partial and later remainder, multi-visit collection, declined,
 * doctor cancelled, out of stock, consultation only, anonymous OTC, registered
 * pay-later, mixed checkout, cash/UPI/card, split, part-paid, later repayment,
 * void/refund/return-to-quarantine, retry and concurrency, sequential
 * numbering, and exact reconciliation of stock, bill lines, payments and
 * patient dues.
 *
 * Everything is built through the real commands. The one thing asserted
 * directly against the tables is that history cannot be edited, which is the
 * point of asserting it there.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, test } from 'node:test'
import {
  as, clinicDate, closeClinic, makeStaff, resetClinic, rows, scalar,
} from '../support/clinic.mjs'

after(async () => { await closeClinic() })

async function clinic() {
  await resetClinic()
  return {
    admin: await makeStaff({ name: 'Owner', username: 's4-admin', roles: ['admin'], pin: '4829' }),
    doctor: await makeStaff({ name: 'Doctor', username: 's4-doc', roles: ['doctor'], pin: '5731' }),
    pharmacy: await makeStaff({ name: 'Pharmacist', username: 's4-pharm', roles: ['pharmacy'], pin: '7048' }),
    counterB: await makeStaff({ name: 'Counter B', username: 's4-pharm2', roles: ['pharmacy'], pin: '6182' }),
  }
}

/** A stocked, classified OTC medicine at ₹30 a tablet. */
async function medicine(staff, overrides = {}) {
  const spec = {
    code: 'PCM500', name: 'Paracetamol', genericName: 'Paracetamol', strength: '500 mg',
    dosageForm: 'tablet', route: 'Oral', unit: 'tablet', baseUnit: 'tablet',
    saleClass: 'otc', schedule: 'OTC', reorderLevel: 10, targetStock: 1000,
    initialQuantity: 500, batchNumber: 'PCM-A', expiry: await clinicDate(400),
    mrp: 30, purchasePrice: 18, sellingPrice: 30,
    ...overrides,
  }
  await as(staff, 'add_medicine', spec)
  return String(await scalar('select id from jmc.medicines where code=$1', [spec.code]))
}

async function patient(staff, name = 'Counter Patient', phone = '+919000000101') {
  await as(staff, 'create_patient', { name, age: 44, sex: 'female', phone })
  return String(await scalar('select id from jmc.patients where name=$1', [name]))
}

/** A signed prescription for one medicine. */
async function prescribe(doctor, patientId, medicineId, quantity, extra = {}) {
  await as(doctor, 'sign_consultation', {
    patientId, complaint: 'Fever', diagnosis: 'Acute viral febrile illness',
    diagnosisStatus: 'provisional',
    prescriptionItems: [{ medicineId, instructions: 'After food', quantity }],
    ...extra,
  })
  // The prescription just signed, and ITS first line. Ordering the lines
  // globally picks whichever prescription id happens to sort last, which is a
  // different prescription about one time in two.
  const prescriptionId = String(await scalar(
    'select id from jmc.prescriptions order by signed_at desc, prescription_number desc limit 1',
  ))
  return {
    prescriptionId,
    lineId: String(await scalar(
      'select id from jmc.prescription_lines where prescription_id=$1 order by line_number limit 1',
      [prescriptionId],
    )),
  }
}

const balance = async (invoiceId) =>
  (await rows('select * from jmc.invoice_balances where id=$1', [invoiceId]))[0]

// ═══════════════════════════════════════════════════════════════════════════

describe('handing medicine over', () => {
  test('full, partial, the remainder later, and the arithmetic on every line', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await medicine(admin)
    const patientId = await patient(doctor)
    const { prescriptionId, lineId } = await prescribe(doctor, patientId, medicineId, 10)

    // Opening it moves nothing. This is the property the whole slice rests on.
    const [beforeLine] = await rows('select * from jmc.prescription_line_supply where id=$1', [lineId])
    assert.equal(Number(beforeLine.supplied), 0)
    assert.equal(Number(beforeLine.remaining), 10)
    assert.equal(beforeLine.supply_state, 'waiting')
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 500)

    await as(pharmacy, 'dispense_rx', {
      prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 6 }],
    })

    const [afterSix] = await rows('select * from jmc.prescription_line_supply where id=$1', [lineId])
    assert.equal(Number(afterSix.supplied), 6)
    assert.equal(Number(afterSix.remaining), 4)
    assert.equal(afterSix.supply_state, 'part_supplied')
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 494)
    assert.equal(
      await scalar('select dispensed_at from jmc.prescriptions where id=$1', [prescriptionId]),
      null,
      'a prescription with a remainder is not finished',
    )

    // More than is left is refused, and says what is left.
    await assert.rejects(
      as(pharmacy, 'dispense_rx', { prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 5 }] }),
      /has 4 left of 10 prescribed/,
    )

    await as(pharmacy, 'dispense_rx', {
      prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 4 }],
    })
    const [done] = await rows('select * from jmc.prescription_line_supply where id=$1', [lineId])
    assert.equal(Number(done.remaining), 0)
    assert.equal(done.supply_state, 'supplied')
    assert.ok(await scalar('select dispensed_at from jmc.prescriptions where id=$1', [prescriptionId]))

    // Two hand-overs, two medicine charges, one consultation fee.
    const lines = await rows('select source, quantity, amount from jmc.invoice_lines order by line_number')
    assert.deepEqual(lines.map((line) => `${line.source}:${line.amount}`), [
      'consultation_fee:300.00', 'prescription:180.00', 'prescription:120.00',
    ])
    assert.equal(String(await scalar('select due from jmc.invoice_balances')), '600.00')
  })

  test('the remainder can be collected on another visit, and the bill follows it', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await medicine(admin)
    const patientId = await patient(doctor)
    const { prescriptionId, lineId } = await prescribe(doctor, patientId, medicineId, 20)

    await as(pharmacy, 'dispense_rx', {
      prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 5 }], note: 'Visit one',
    })
    await as(pharmacy, 'dispense_rx', {
      prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 5 }], note: 'Visit two',
    })
    await as(pharmacy, 'dispense_rx', {
      prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 10 }], note: 'Visit three',
    })

    assert.equal(await scalar('select count(*)::int from jmc.dispenses'), 3)
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 480)
    assert.equal(String(await scalar('select due from jmc.invoice_balances')), '900.00')

    // Each hand-over has its own number, in order and never reused.
    const numbers = (await rows('select dispense_number from jmc.dispenses order by dispensed_at'))
      .map((row) => row.dispense_number)
    assert.deepEqual(numbers, ['DSP-000001', 'DSP-000002', 'DSP-000003'])
  })

  test('a prescription past its validity date cannot supply its remainder', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await medicine(admin)
    const patientId = await patient(doctor)
    const { prescriptionId, lineId } = await prescribe(doctor, patientId, medicineId, 10)

    await as(pharmacy, 'dispense_rx', {
      prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 4 }],
    })

    // Yesterday. Policy register 18: after expiry the pharmacy cannot supply
    // the remainder without a new or amended order.
    await rows(
      `update jmc.prescriptions set valid_until = current_date - 1 where id=$1`, [prescriptionId],
    )
    await assert.rejects(
      as(pharmacy, 'dispense_rx', { prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 6 }] }),
      /The remainder needs a new or amended order from the doctor/,
    )
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 496)

    // And only the doctor may extend it.
    await assert.rejects(
      as(pharmacy, 'set_prescription_validity', {
        prescriptionId, validUntil: await clinicDate(7), reason: 'Patient asked for more time',
      }),
      /role cannot perform/,
    )
    await as(doctor, 'set_prescription_validity', {
      prescriptionId, validUntil: await clinicDate(7), reason: 'Patient could not collect in time',
    })
    await as(pharmacy, 'dispense_rx', {
      prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 6 }],
    })
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 490)
  })

  test('supply in one go means one go', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await medicine(admin)
    const patientId = await patient(doctor)
    const { prescriptionId, lineId } = await prescribe(
      doctor, patientId, medicineId, 10,
      { supplyInParts: false, validityReason: 'A course that must not be split' },
    )

    await assert.rejects(
      as(pharmacy, 'dispense_rx', { prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 6 }] }),
      /supplied in one go/,
    )
    await as(pharmacy, 'dispense_rx', {
      prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 10 }],
    })
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 490)
  })

  test('Patient Declined and Doctor Cancelled are different facts about different people', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await medicine(admin)
    const patientId = await patient(doctor)
    const { prescriptionId, lineId } = await prescribe(doctor, patientId, medicineId, 10)

    // Only the doctor may withdraw the order.
    await assert.rejects(
      as(pharmacy, 'record_prescription_line_outcome', {
        prescriptionLineId: lineId, outcome: 'doctor_cancelled', reason: 'Changed my mind',
      }),
      /role cannot perform/,
    )
    // Only the counter records what the patient said.
    await assert.rejects(
      as(doctor, 'record_prescription_line_outcome', {
        prescriptionLineId: lineId, outcome: 'patient_declined', reason: 'Says she has some at home',
      }),
      /role cannot perform/,
    )

    await as(pharmacy, 'record_prescription_line_outcome', {
      prescriptionLineId: lineId, outcome: 'patient_declined', reason: 'Says she has some at home',
    })

    const [line] = await rows('select * from jmc.prescription_line_supply where id=$1', [lineId])
    assert.equal(line.supply_state, 'patient_declined')
    assert.equal(line.supplyable, false)
    assert.match(line.outcome_reason, /some at home/)

    await assert.rejects(
      as(pharmacy, 'dispense_rx', { prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 1 }] }),
      /recorded as patient declined/,
    )

    // One outcome per line: a declined line cannot also be cancelled, and the
    // record is append-only.
    await assert.rejects(
      as(doctor, 'record_prescription_line_outcome', {
        prescriptionLineId: lineId, outcome: 'doctor_cancelled', reason: 'Withdrawing it too',
      }),
      /already recorded as patient declined/,
    )
    await assert.rejects(rows('delete from jmc.prescription_line_outcomes'), /cannot be changed/)
  })

  test('a doctor cancelling a line after a partial supply stops the rest', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await medicine(admin)
    const patientId = await patient(doctor)
    const { prescriptionId, lineId } = await prescribe(doctor, patientId, medicineId, 10)

    await as(pharmacy, 'dispense_rx', {
      prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 3 }],
    })
    await as(doctor, 'record_prescription_line_outcome', {
      prescriptionLineId: lineId, outcome: 'doctor_cancelled',
      reason: 'Rash on day two; stopping the course',
    })

    const [line] = await rows('select * from jmc.prescription_line_supply where id=$1', [lineId])
    assert.equal(line.supply_state, 'doctor_cancelled')
    assert.equal(Number(line.supplied), 3, 'what was already handed over stands')
    await assert.rejects(
      as(pharmacy, 'dispense_rx', { prescriptionId }),
      /nothing left to hand over/,
    )
    // And the three already given are still charged for.
    assert.equal(String(await scalar('select due from jmc.invoice_balances')), '390.00')
  })

  test('out of stock is refused and moves nothing', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await medicine(admin, { initialQuantity: 4 })
    const patientId = await patient(doctor)
    const { prescriptionId, lineId } = await prescribe(doctor, patientId, medicineId, 10)

    await assert.rejects(
      as(pharmacy, 'dispense_rx', { prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 10 }] }),
      /Only 4 unit\(s\) can be supplied/,
    )
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 4)
    assert.equal(await scalar('select count(*)::int from jmc.dispenses'), 0)
    assert.equal(
      await scalar(`select count(*)::int from jmc.invoice_lines where source='prescription'`),
      0,
      'and nothing was charged for stock that never moved',
    )

    // What IS on the shelf can still be handed over.
    await as(pharmacy, 'dispense_rx', { prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 4 }] })
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 0)
  })

  test('a recalled batch is never picked, however early it expires', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await medicine(admin, { initialQuantity: 10, batchNumber: 'OLD', expiry: await clinicDate(30) })
    await as(admin, 'add_medicine', {
      code: 'PCM500B', name: 'Paracetamol', strength: '500 mg', dosageForm: 'tablet',
      unit: 'tablet', saleClass: 'otc', schedule: 'OTC', reorderLevel: 1, targetStock: 10,
    })
    // A second batch of the SAME medicine, later expiry.
    await rows(
      `insert into jmc.batches (id,medicine_id,batch_number,expiry,available_quantity,mrp,
         purchase_price,selling_price,received_at,base_unit)
       values ('late',$1,'LATE',$2,50,30,18,30,now()::text,'tablet')`,
      [medicineId, await clinicDate(300)],
    )
    await rows(
      `insert into jmc.stock_movements (id,medicine_id,batch_id,movement_type,quantity_delta,
         reference_type,reference_id,actor_id,created_at)
       values ('latem',$1,'late','opening_stock',50,'medicine',$1,$2,now()::text)`,
      [medicineId, admin.id],
    )

    const oldBatch = String(await scalar(`select id from jmc.batches where batch_number='OLD'`))
    await as(pharmacy, 'set_batch_status', {
      batchId: oldBatch, status: 'recalled', reason: 'Manufacturer recall 2026/114',
    })

    const patientId = await patient(doctor)
    const { prescriptionId, lineId } = await prescribe(doctor, patientId, medicineId, 10)
    await as(pharmacy, 'dispense_rx', { prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 10 }] })

    assert.equal(
      Number(await scalar(`select available_quantity from jmc.batches where batch_number='OLD'`)),
      10,
      'the recalled batch is untouched, though it expires first',
    )
    assert.equal(
      Number(await scalar(`select available_quantity from jmc.batches where batch_number='LATE'`)),
      40,
    )
  })
})

describe('substitution, and the narrow door policy leaves open', () => {
  async function genericAndBrand(admin, pharmacy) {
    const substance = await as(pharmacy, 'save_substance', { name: 'Paracetamol' })
    const drug = await as(pharmacy, 'save_clinical_drug', {
      dosageForm: 'tablet', route: 'Oral',
      ingredients: [{ substanceId: substance.data.substanceId, strengthValue: 500, strengthUnit: 'mg' }],
    })
    const other = await as(pharmacy, 'save_clinical_drug', {
      dosageForm: 'tablet', route: 'Oral',
      ingredients: [{ substanceId: substance.data.substanceId, strengthValue: 650, strengthUnit: 'mg' }],
    })

    const generic = await medicine(admin, { code: 'PCM-GEN', name: 'Paracetamol' })
    const branded = await medicine(admin, {
      code: 'PCM-CAL', name: 'Calpol', brandName: 'Calpol', batchNumber: 'CAL-A',
    })
    const stronger = await medicine(admin, {
      code: 'PCM-650', name: 'Paracetamol 650', batchNumber: 'PCM650-A',
    })

    await as(pharmacy, 'link_medicine_identity', { medicineId: generic, clinicalDrugId: drug.data.clinicalDrugId })
    await as(pharmacy, 'link_medicine_identity', {
      medicineId: branded, clinicalDrugId: drug.data.clinicalDrugId, brandName: 'Calpol',
    })
    await as(pharmacy, 'link_medicine_identity', { medicineId: stronger, clinicalDrugId: other.data.clinicalDrugId })
    return { generic, branded, stronger }
  }

  test('an exactly matching brand may be supplied against a generic order, with a reason', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const { generic, branded } = await genericAndBrand(admin, pharmacy)
    const patientId = await patient(doctor)
    const { prescriptionId, lineId } = await prescribe(doctor, patientId, generic, 10)

    await assert.rejects(
      as(pharmacy, 'dispense_rx', {
        prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 10, medicineId: branded }],
      }),
      /Say why a different product is being supplied/,
    )

    await as(pharmacy, 'dispense_rx', {
      prescriptionId,
      lines: [{
        prescriptionLineId: lineId, quantity: 10, medicineId: branded,
        substitutionReason: 'The unbranded stock is finished; same drug and strength',
      }],
    })

    const [line] = await rows('select * from jmc.dispense_lines')
    assert.equal(line.medicine_id, branded)
    assert.ok(line.substituted_for_clinical_drug_id, 'the substitution is visible, not inferable')
    assert.match(line.substitution_reason, /same drug and strength/)
  })

  test('a different strength, and a brand-specific order, are both refused', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const { generic, branded, stronger } = await genericAndBrand(admin, pharmacy)
    const patientId = await patient(doctor)

    const generic10 = await prescribe(doctor, patientId, generic, 10)
    await assert.rejects(
      as(pharmacy, 'dispense_rx', {
        prescriptionId: generic10.prescriptionId,
        lines: [{
          prescriptionLineId: generic10.lineId, quantity: 10, medicineId: stronger,
          substitutionReason: 'Close enough',
        }],
      }),
      /is not the same clinical drug as/,
    )

    const byBrand = await prescribe(doctor, patientId, branded, 10)
    await assert.rejects(
      as(pharmacy, 'dispense_rx', {
        prescriptionId: byBrand.prescriptionId,
        lines: [{
          prescriptionLineId: byBrand.lineId, quantity: 10, medicineId: generic,
          substitutionReason: 'Cheaper',
        }],
      }),
      /was prescribed by brand/,
    )

    assert.equal(await scalar('select count(*)::int from jmc.dispenses'), 0)
  })
})

describe('the counter sale', () => {
  test('an anonymous sale is paid in full, or it does not happen', async () => {
    const { admin, pharmacy } = await clinic()
    const medicineId = await medicine(admin)

    await assert.rejects(
      as(pharmacy, 'otc_sale', { lines: [{ medicineId, quantity: 4 }], parts: [] }),
      /An anonymous sale is paid in full at the counter/,
    )
    await assert.rejects(
      as(pharmacy, 'otc_sale', {
        lines: [{ medicineId, quantity: 4 }], parts: [{ method: 'cash', amount: 60 }],
      }),
      /₹120.00 is due and ₹60.00 was offered/,
    )
    assert.equal(await scalar('select count(*)::int from jmc.otc_sales'), 0)
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 500)

    const sale = await as(pharmacy, 'otc_sale', {
      lines: [{ medicineId, quantity: 4 }], parts: [{ method: 'cash', amount: 120 }],
    })
    assert.match(sale.data.receiptNumber, /^OTC-\d{4}$/)
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 496)
    assert.equal(String(await scalar('select payment_state from jmc.invoice_balances')), 'paid')
    assert.equal(await scalar('select patient_id from jmc.invoices'), null)
  })

  test('an unreviewed classification cannot leave anonymously, but may be sold to a patient', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    // No schedule given: Unknown / pharmacist review required, which is where
    // every medicine the clinic already had starts.
    await as(admin, 'add_medicine', {
      code: 'OLD1', name: 'Something old', unit: 'tablet', saleClass: 'otc',
      reorderLevel: 1, targetStock: 100, initialQuantity: 50, batchNumber: 'OLD-A',
      expiry: await clinicDate(200), mrp: 10, purchasePrice: 6, sellingPrice: 10,
    })
    const medicineId = String(await scalar(`select id from jmc.medicines where code='OLD1'`))
    const patientId = await patient(doctor)

    await assert.rejects(
      as(pharmacy, 'otc_sale', {
        lines: [{ medicineId, quantity: 2 }], parts: [{ method: 'cash', amount: 20 }],
      }),
      /has not had its regulatory class reviewed by a pharmacist/,
    )

    await as(pharmacy, 'otc_sale', {
      patientId, lines: [{ medicineId, quantity: 2 }], parts: [{ method: 'cash', amount: 20 }],
    })
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 48)
  })

  test('a registered patient may pay later, and repay in parts afterwards', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await medicine(admin)
    const patientId = await patient(doctor)

    await as(pharmacy, 'otc_sale', { patientId, lines: [{ medicineId, quantity: 10 }], parts: [] })
    const invoiceId = String(await scalar('select id from jmc.invoices'))
    assert.equal((await balance(invoiceId)).payment_state, 'unpaid')
    assert.equal(
      String(await scalar('select outstanding from jmc.patient_balances where patient_id=$1', [patientId])),
      '300.00',
    )

    await as(pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'cash', amount: 100 }] })
    assert.equal((await balance(invoiceId)).payment_state, 'part_paid')
    await as(pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'upi', amount: 200 }] })
    assert.equal((await balance(invoiceId)).payment_state, 'paid')
    assert.equal(
      String(await scalar('select outstanding from jmc.patient_balances where patient_id=$1', [patientId])),
      '0.00',
    )
  })

  test('a return puts the medicine in quarantine and refunds through the bill', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await medicine(admin)
    const patientId = await patient(doctor)

    await as(pharmacy, 'otc_sale', {
      patientId, lines: [{ medicineId, quantity: 10 }], parts: [{ method: 'cash', amount: 300 }],
    })
    const otcLineId = String(await scalar('select id from jmc.otc_lines'))

    await as(pharmacy, 'otc_return', {
      otcLineId, quantity: 4, reason: 'Wrong strength; unopened',
      refund: [{ method: 'cash', amount: 120 }],
    })

    // Not back on the shelf. Policy register 47.
    const [batch] = await rows('select available_quantity, quarantined_quantity from jmc.batches')
    assert.equal(Number(batch.available_quantity), 490)
    assert.equal(Number(batch.quarantined_quantity), 4)

    const [bill] = await rows('select paid, due from jmc.invoice_balances')
    assert.equal(bill.paid, '180.00', 'the refund reduces what has been paid')
    assert.equal(bill.due, '120.00')

    // More than was sold cannot come back.
    await assert.rejects(
      as(pharmacy, 'otc_return', { otcLineId, quantity: 7, reason: 'Changed her mind' }),
      /6 of 10 on OTC-0001 can still be returned/,
    )
  })

  test('a mixed visit is one bill: the fee, the prescription and a counter sale', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await medicine(admin)
    const patientId = await patient(doctor)
    const { prescriptionId, lineId } = await prescribe(doctor, patientId, medicineId, 10)
    const encounterId = String(await scalar('select encounter_id from jmc.prescriptions'))

    await as(pharmacy, 'dispense_rx', {
      prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 10 }],
    })
    await as(pharmacy, 'otc_sale', {
      patientId, encounterId, lines: [{ medicineId, quantity: 2 }], parts: [],
    })

    assert.equal(await scalar('select count(*)::int from jmc.invoices'), 1, 'one visit, one bill')
    const lines = await rows('select source, amount from jmc.invoice_lines order by line_number')
    assert.deepEqual(lines.map((line) => `${line.source}:${line.amount}`), [
      'consultation_fee:300.00', 'prescription:300.00', 'otc:60.00',
    ])

    const invoiceId = String(await scalar('select id from jmc.invoices'))
    await as(pharmacy, 'take_payment', {
      invoiceId,
      parts: [
        { method: 'cash', amount: 400 },
        { method: 'upi', amount: 260, reference: 'UPI-441' },
      ],
    })
    assert.equal((await balance(invoiceId)).payment_state, 'paid')
  })
})

describe('numbers, retries and two counters at once', () => {
  test('every document series is sequential and never reused', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await medicine(admin)
    const patientId = await patient(doctor)

    for (let visit = 0; visit < 3; visit += 1) {
      const { prescriptionId, lineId } = await prescribe(doctor, patientId, medicineId, 2)
      await as(pharmacy, 'dispense_rx', {
        prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 2 }],
      })
      const invoiceId = String(await scalar(
        'select id from jmc.invoices order by created_at desc limit 1',
      ))
      await as(pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'cash', amount: 360 }] })
    }

    assert.deepEqual(
      (await rows('select invoice_number from jmc.invoices order by invoice_number')).map((r) => r.invoice_number),
      ['INV-000001', 'INV-000002', 'INV-000003'],
    )
    assert.deepEqual(
      (await rows('select receipt_number from jmc.payments order by receipt_number')).map((r) => r.receipt_number),
      ['RCP-000001', 'RCP-000002', 'RCP-000003'],
    )
    assert.deepEqual(
      (await rows('select dispense_number from jmc.dispenses order by dispense_number')).map((r) => r.dispense_number),
      ['DSP-000001', 'DSP-000002', 'DSP-000003'],
    )
  })

  test('a voided bill keeps its number, and one that has been paid cannot be voided', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const patientId = await patient(doctor)
    await as(doctor, 'sign_consultation', {
      patientId, complaint: 'Fever', diagnosis: 'Acute viral febrile illness',
      diagnosisStatus: 'provisional',
    })
    const invoiceId = String(await scalar('select id from jmc.invoices'))

    await assert.rejects(
      as(pharmacy, 'void_invoice', { invoiceId, reason: 'Raised in error' }),
      /role cannot perform/,
    )
    await as(admin, 'void_invoice', { invoiceId, reason: 'Raised against the wrong patient' })
    const [voided] = await rows('select invoice_number, status, payment_state from jmc.invoice_balances')
    assert.equal(voided.invoice_number, 'INV-000001', 'the number is kept')
    assert.equal(voided.status, 'void')
    assert.equal(voided.payment_state, 'void')

    // And a paid bill is refunded rather than voided, so the money is not lost.
    const second = await patient(doctor, 'Second Patient', '+919000000202')
    await as(doctor, 'sign_consultation', {
      patientId: second, complaint: 'Cough', diagnosis: 'Acute bronchitis',
      diagnosisStatus: 'provisional',
    })
    const paidInvoice = String(await scalar(
      'select id from jmc.invoices order by created_at desc limit 1',
    ))
    await as(pharmacy, 'take_payment', { invoiceId: paidInvoice, parts: [{ method: 'cash', amount: 300 }] })
    await assert.rejects(
      as(admin, 'void_invoice', { invoiceId: paidInvoice, reason: 'Wrong patient' }),
      /Refund the payment first/,
    )
  })

  test('two counters handing over the same line supply it once', async () => {
    const { admin, doctor, pharmacy, counterB } = await clinic()
    const medicineId = await medicine(admin)
    const patientId = await patient(doctor)
    const { prescriptionId, lineId } = await prescribe(doctor, patientId, medicineId, 10)

    const both = await Promise.allSettled([
      as(pharmacy, 'dispense_rx', {
        prescriptionId, idempotencyKey: randomUUID(),
        lines: [{ prescriptionLineId: lineId, quantity: 10 }],
      }),
      as(counterB, 'dispense_rx', {
        prescriptionId, idempotencyKey: randomUUID(),
        lines: [{ prescriptionLineId: lineId, quantity: 10 }],
      }),
    ])

    assert.equal(both.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 490,
      'a prescription for ten must never move more than ten')
    assert.equal(Number(await scalar(
      `select coalesce(sum(quantity),0)::int from jmc.dispense_lines`,
    )), 10)
    assert.equal(
      await scalar(`select count(*)::int from jmc.invoice_lines where source='prescription'`),
      1,
      'and it is charged for once',
    )
  })

  test('two counters selling the last of a batch sell it once', async () => {
    const { admin, pharmacy, counterB } = await clinic()
    const medicineId = await medicine(admin, { initialQuantity: 10 })

    const both = await Promise.allSettled([
      as(pharmacy, 'otc_sale', {
        idempotencyKey: randomUUID(), lines: [{ medicineId, quantity: 10 }],
        parts: [{ method: 'cash', amount: 300 }],
      }),
      as(counterB, 'otc_sale', {
        idempotencyKey: randomUUID(), lines: [{ medicineId, quantity: 10 }],
        parts: [{ method: 'cash', amount: 300 }],
      }),
    ])

    assert.equal(both.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 0)
    assert.equal(
      Number(await scalar('select coalesce(sum(quantity_delta),0)::int from jmc.stock_movements')),
      0,
      'the ledger cannot go below zero either',
    )
    assert.equal(await scalar('select count(*)::int from jmc.otc_sales'), 1)
  })
})

describe('everything reconciles', () => {
  test('stock, bill lines, payments and the patient balance all agree after a full day', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await medicine(admin)
    const first = await patient(doctor, 'Reconcile One', '+919000000301')
    const second = await patient(doctor, 'Reconcile Two', '+919000000302')

    // A consultation-only visit, paid in full.
    await as(doctor, 'sign_consultation', {
      patientId: first, complaint: 'Review', diagnosis: 'Hypertension',
      diagnosisStatus: 'confirmed',
    })
    const firstInvoice = String(await scalar('select id from jmc.invoices'))
    await as(pharmacy, 'take_payment', { invoiceId: firstInvoice, parts: [{ method: 'upi', amount: 300 }] })

    // A visit with a partial hand-over, part paid.
    const { prescriptionId, lineId } = await prescribe(doctor, second, medicineId, 20)
    await as(pharmacy, 'dispense_rx', {
      prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 8 }],
    })
    const secondInvoice = String(await scalar(
      'select id from jmc.invoices order by created_at desc limit 1',
    ))
    await as(pharmacy, 'take_payment', { invoiceId: secondInvoice, parts: [{ method: 'cash', amount: 200 }] })

    // An anonymous counter sale, paid.
    await as(pharmacy, 'otc_sale', {
      lines: [{ medicineId, quantity: 5 }], parts: [{ method: 'card', amount: 150 }],
    })

    // ── stock ─────────────────────────────────────────────────────────────
    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 500 - 8 - 5)
    const drift = await rows(
      `select batch_id from jmc.batch_ledger_reconciliation
        where available_drift <> 0 or quarantine_drift <> 0 or blocked_drift <> 0`,
    )
    assert.deepEqual(drift.map((row) => row.batch_id), [])

    // ── every charge traces to something that authorized it ───────────────
    const orphans = await rows(`
      select source_key from jmc.invoice_lines
       where (source = 'consultation_fee' and encounter_id is null)
          or (source = 'prescription' and dispense_line_id is null)
          or (source = 'otc' and otc_line_id is null)`)
    assert.deepEqual(orphans.map((row) => row.source_key), [])

    // ── medicine charged equals medicine handed over ──────────────────────
    const handed = Number(await scalar('select coalesce(sum(quantity),0)::int from jmc.dispense_lines'))
    const charged = Number(await scalar(
      `select coalesce(sum(quantity),0)::int from jmc.invoice_lines where source='prescription'`,
    ))
    assert.equal(charged, handed)

    // ── money ─────────────────────────────────────────────────────────────
    const [totals] = await rows(`
      select sum(total) as billed, sum(paid) as paid, sum(due) as due
        from jmc.invoice_balances where status <> 'void'`)
    assert.equal(totals.billed, '990.00', '300 + (300 + 240) + 150')
    assert.equal(totals.paid, '650.00', '300 + 200 + 150')
    assert.equal(totals.due, '340.00', 'and 990 - 650 is what is still owed')

    const allocated = String(await scalar(`
      select coalesce(sum(case when y.kind='refund' then -a.amount else a.amount end), 0)
        from jmc.payment_allocations a join jmc.payments y on y.id=a.payment_id
       where y.status='received'`))
    assert.equal(allocated, totals.paid, 'every payment is allocated, and only to a real bill')

    // ── patient dues ──────────────────────────────────────────────────────
    const balances = await rows(
      `select name, outstanding from jmc.patient_balances where outstanding <> 0 order by name`,
    )
    assert.deepEqual(balances.map((row) => `${row.name} ${row.outstanding}`), ['Reconcile Two 340.00'])

    // The anonymous sale is owed by nobody, so it is not in anybody's balance.
    assert.equal(
      String(await scalar(
        `select coalesce(sum(due),0) from jmc.invoice_balances where patient_id is null`,
      )),
      '0.00',
    )
  })
})
