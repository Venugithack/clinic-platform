/**
 * The consultation, the fee, and the bill.
 *
 * This file was written before Slice 4 to be exact about the starting
 * position, and it asserted three defects so that the slice fixing them had to
 * change a test on purpose. It has, and the assertions are now the other way
 * round:
 *
 *   1. The fee comes from the clinic's settings, snapshotted onto the
 *      encounter with the default that applied at the time. It used to come
 *      from a literal 300 in the doctor's browser form, so an admin who
 *      changed the fee on the Clinic screen changed nothing that was billed.
 *   2. Medicine handed over is charged for, at the price of the batch it came
 *      out of. Dispensing used to move stock and bill nothing.
 *   3. A bill is lines plus payments. Part payment, split payment, pay-later,
 *      refund and reversal all exist because money is events rather than a
 *      status column — and "paid" is arithmetic, not a flag.
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
    nurse: await makeStaff({ name: 'Nurse', roles: ['nurse'], username: 'nur', pin: '618205' }),
    pharmacy: await makeStaff({ name: 'Pharmacist', roles: ['pharmacy'], username: 'pharm', pin: '704816' }),
  }
}

async function addPatient(staff, name = 'Test Patient') {
  await as(staff, 'create_patient', { name, age: 40, sex: 'female', phone: '+915550000001' })
  return String(await scalar('select id from jmc.patients where name=$1', [name]))
}

async function stockedMedicine(admin) {
  await as(admin, 'add_medicine', {
    code: 'PCM500', name: 'Paracetamol', strength: '500 mg', dosageForm: 'tablet',
    unit: 'tablet', saleClass: 'otc', schedule: 'OTC', reorderLevel: 20, targetStock: 200,
    initialQuantity: 100, batchNumber: 'PCM-A', expiry: await clinicDate(400),
    mrp: 30, purchasePrice: 18, sellingPrice: 30,
  })
  return String(await scalar(`select id from jmc.medicines where code='PCM500'`))
}

describe('saving a consultation', () => {
  test('writes one encounter, one prescription and at most one bill, in one transaction', async () => {
    const { admin, doctor } = await clinic()
    const medicineId = await stockedMedicine(admin)
    const patientId = await addPatient(doctor)

    await as(doctor, 'save_consultation', {
      patientId,
      diagnosis: 'Acute pharyngitis',
      notes: 'Throat inflamed',
      advice: 'Warm fluids',
      consultationFee: 300,
      prescriptionItems: [
        { medicineId, medicineName: 'Paracetamol 500 mg', dosage: '1-0-1', instructions: 'After food', quantity: 10 },
      ],
    })

    assert.equal(await scalar('select count(*)::int from jmc.encounters'), 1)
    assert.equal(await scalar('select count(*)::int from jmc.prescriptions'), 1)
    assert.equal(await scalar('select count(*)::int from jmc.invoices'), 1)

    const [bill] = await rows(
      'select invoice_number, total, paid, due, payment_state from jmc.invoice_balances',
    )
    assert.match(bill.invoice_number, /^INV-\d{6}$/)
    assert.equal(bill.total, '300.00')
    assert.equal(bill.paid, '0.00')
    assert.equal(bill.due, '300.00')
    assert.equal(bill.payment_state, 'unpaid')

    // One line, and it says what authorized it. `source_key` is uniquely
    // indexed clinic-wide, which is what makes "at most one fee per encounter"
    // a property of the database rather than a promise.
    const [line] = await rows('select source, description, amount, source_key from jmc.invoice_lines')
    assert.equal(line.source, 'consultation_fee')
    assert.equal(line.description, 'Consultation')
    assert.equal(line.amount, '300.00')
    assert.match(line.source_key, /^consultation:/)
  })

  test('the diagnosis stays free text, with structured clinical context beside it', async () => {
    const { doctor } = await clinic()
    const patientId = await addPatient(doctor)

    await assert.rejects(
      as(doctor, 'save_consultation', { patientId, diagnosis: '', feeWaived: true, feeReason: 'Not what this test is about' }),
      /diagnosis is required/,
    )

    await as(doctor, 'save_consultation', {
      patientId,
      complaint: 'Fever and body pain',
      complaintDurationValue: 3,
      complaintDurationUnit: 'day',
      examination: 'Chest clear',
      diagnosis: 'Viral fever',
      diagnosisStatus: 'provisional',
      aetiology: 'Likely viral',
      aetiologyCertainty: 'suspected',
      feeWaived: true, feeReason: 'Not what this test is about',
    })
    const [encounter] = await rows(`select diagnosis,complaint,complaint_duration_value,
      complaint_duration_unit,examination,diagnosis_status,aetiology,aetiology_certainty
      from jmc.encounters`)
    assert.equal(encounter.diagnosis, 'Viral fever')
    assert.equal(encounter.complaint, 'Fever and body pain')
    assert.equal(Number(encounter.complaint_duration_value), 3)
    assert.equal(encounter.complaint_duration_unit, 'day')
    assert.equal(encounter.examination, 'Chest clear')
    assert.equal(encounter.diagnosis_status, 'provisional')
    assert.equal(encounter.aetiology, 'Likely viral')
    assert.equal(encounter.aetiology_certainty, 'suspected')

    // The owner's English wording remains the recorded identity in this slice;
    // status and cause add structure without pretending an unreviewed coding
    // system is ready for clinical use.
    const columns = (await rows(
      `select column_name from information_schema.columns
        where table_schema='jmc' and table_name='encounters' order by column_name`,
    )).map((r) => r.column_name)
    assert.deepEqual(columns, [
      'advice', 'aetiology', 'aetiology_certainty', 'appointment_id', 'complaint',
      'complaint_duration_unit', 'complaint_duration_value',
      // Slice 4. What was charged, what the clinic default was at the time,
      // whether it was waived, why, by whom and when — so "was this a
      // discount?" is answerable a month later.
      'consultation_fee', 'consultation_fee_default',
      'created_at', 'diagnosis', 'diagnosis_status', 'doctor_id', 'examination',
      'fee_reason', 'fee_set_at', 'fee_set_by', 'fee_waived',
      'follow_up_date', 'id', 'notes', 'patient_id',
    ])
  })

  test('no prescription row is written when the doctor prescribes nothing', async () => {
    const { doctor } = await clinic()
    const patientId = await addPatient(doctor)

    await as(doctor, 'save_consultation', { patientId, diagnosis: 'Advice only', consultationFee: 300 })

    assert.equal(await scalar('select count(*)::int from jmc.encounters'), 1)
    assert.equal(await scalar('select count(*)::int from jmc.prescriptions'), 0)
    // The fee still reaches the counter even with nothing prescribed, which is
    // the behaviour the owner confirmed: a consultation-only visit is payable.
    assert.equal(await scalar('select count(*)::int from jmc.invoices'), 1)
    assert.equal(String(await scalar('select due from jmc.invoice_balances')), '300.00')
  })

  test('a waived consultation is an explicit zero with a reason, not an absence', async () => {
    const { doctor } = await clinic()
    const patientId = await addPatient(doctor)

    // A waiver needs a reason. Policy register 33 says a free consultation is
    // recorded as an explicit ₹0 charge with a reason and an actor; an absent
    // line cannot say who decided, and used to be indistinguishable from a
    // visit somebody simply forgot to bill.
    await assert.rejects(
      as(doctor, 'save_consultation', { patientId, diagnosis: 'Follow-up', feeWaived: true }),
      /Say why this consultation is being waived/,
    )

    await as(doctor, 'save_consultation', {
      patientId, diagnosis: 'Follow-up',
      feeWaived: true, feeReason: 'Review after yesterday, no new complaint',
    })

    const [encounter] = await rows(
      'select consultation_fee, consultation_fee_default, fee_waived, fee_reason, fee_set_by from jmc.encounters',
    )
    assert.equal(encounter.consultation_fee, '0.00')
    assert.equal(encounter.consultation_fee_default, '300.00', 'what it would have been')
    assert.equal(encounter.fee_waived, true)
    assert.match(encounter.fee_reason, /no new complaint/)
    assert.ok(encounter.fee_set_by)

    // And the bill exists, at zero, so the visit reads as free rather than as
    // unbilled.
    const [bill] = await rows('select total, due, payment_state from jmc.invoice_balances')
    assert.equal(bill.total, '0.00')
    assert.equal(bill.payment_state, 'paid', 'nothing is owed on a waived visit')
    assert.equal(
      await scalar(`select description from jmc.invoice_lines`),
      'Consultation (waived)',
    )
  })

  test('an override below or above the clinic fee has to say why', async () => {
    const { doctor } = await clinic()
    const patientId = await addPatient(doctor)

    await assert.rejects(
      as(doctor, 'save_consultation', { patientId, diagnosis: 'Fever', consultationFee: 150 }),
      /The clinic fee is ₹300.00. Say why this visit is being charged ₹150.00/,
    )

    await as(doctor, 'save_consultation', {
      patientId, diagnosis: 'Fever', consultationFee: 150,
      feeReason: 'Second visit for the same complaint this week',
    })
    const [encounter] = await rows(
      'select consultation_fee, consultation_fee_default, fee_waived from jmc.encounters',
    )
    assert.equal(encounter.consultation_fee, '150.00')
    assert.equal(encounter.consultation_fee_default, '300.00')
    assert.equal(encounter.fee_waived, false)
    assert.equal(String(await scalar('select amount from jmc.invoice_lines')), '150.00')

    // The override is audited, because it is a decision rather than a default.
    assert.equal(
      await scalar(`select count(*)::int from jmc.audit_events
        where action='consultation.fee_overridden'`),
      1,
    )
  })

  test('only a doctor may sign a consultation — an admin alone may not', async () => {
    const { admin, nurse, pharmacy, doctor } = await clinic()
    const patientId = await addPatient(doctor)
    const payload = { patientId, diagnosis: 'Fever', feeWaived: true, feeReason: 'Not what this test is about' }

    for (const staff of [admin, nurse, pharmacy]) {
      await assert.rejects(as(staff, 'save_consultation', payload), /role cannot perform/)
    }
    await as(doctor, 'save_consultation', payload)
  })

  test('completing the consultation closes the appointment it names', async () => {
    const { nurse, doctor } = await clinic()
    const patientId = await addPatient(nurse)
    await as(nurse, 'create_appointment', {
      patientId, reason: 'Fever', scheduledAt: new Date().toISOString(),
    })
    const appointmentId = String(await scalar('select id from jmc.appointments'))

    await as(doctor, 'save_consultation', { patientId, appointmentId, diagnosis: 'Fever', feeWaived: true, feeReason: 'Not what this test is about' })

    assert.equal(await scalar('select status from jmc.appointments where id=$1', [appointmentId]), 'done')
  })
})

describe('the consultation fee comes from the clinic, not the browser', () => {
  test('changing the configured fee changes what the next visit is billed', async () => {
    const { admin, doctor } = await clinic()

    await as(admin, 'update_clinic_settings', {
      name: 'Jayamurugan Clinic', address: 'Somewhere', phone: '+915550000000', email: '',
      drugLicenceNumber: 'DL-1', doctorRegistrationNumber: 'REG-1', gstin: '', footerNote: '',
      consultationFee: 450,
    })
    assert.equal(String(await scalar('select consultation_fee from jmc.clinic_settings')), '450.00')

    const patientId = await addPatient(doctor)
    // Nothing about the fee is sent. The server reads the clinic's own figure,
    // which is the whole change: the browser used to send a hardcoded 300 and
    // the configured fee was decoration.
    await as(doctor, 'save_consultation', { patientId, diagnosis: 'Fever' })

    assert.equal(String(await scalar('select amount from jmc.invoice_lines')), '450.00')
    assert.equal(
      String(await scalar('select consultation_fee_default from jmc.encounters')),
      '450.00',
      'and the default in force is snapshotted beside what was charged',
    )
  })

  test('a later change to the default does not rewrite an old visit', async () => {
    const { admin, doctor } = await clinic()
    const patientId = await addPatient(doctor)

    await as(doctor, 'save_consultation', { patientId, diagnosis: 'Fever' })
    assert.equal(String(await scalar('select amount from jmc.invoice_lines')), '300.00')

    await as(admin, 'update_clinic_settings', {
      name: 'Jayamurugan Clinic', address: 'Somewhere', phone: '+915550000000', email: '',
      drugLicenceNumber: 'DL-1', doctorRegistrationNumber: 'REG-1', gstin: '', footerNote: '',
      consultationFee: 500,
    })

    // Policy register 15. The bill already raised is what it was.
    assert.equal(String(await scalar('select amount from jmc.invoice_lines')), '300.00')
    assert.equal(String(await scalar('select consultation_fee from jmc.encounters')), '300.00')
  })

  test('a retried consultation cannot charge the fee twice', async () => {
    const { doctor } = await clinic()
    const patientId = await addPatient(doctor)

    await as(doctor, 'save_consultation', { patientId, diagnosis: 'Fever' })
    const encounterId = String(await scalar('select id from jmc.encounters'))

    /*
     * The retry that matters is not a repeated command — each of those makes
     * its own encounter, which is a second visit and a second fee, correctly.
     * It is a second fee line against the SAME encounter, which is what a
     * half-committed transaction or a repair script would produce. The unique
     * index on `source_key` refuses it clinic-wide, so it cannot even be done
     * by creating a second invoice first.
     */
    await assert.rejects(
      rows(
        `insert into jmc.invoice_lines
           (id,invoice_id,line_number,source,encounter_id,description,quantity,unit_amount,amount,source_key)
         values ('dup', (select id from jmc.invoices limit 1), 99, 'consultation_fee', $1,
                 'Consultation', 1, 300, 300, $2)`,
        [encounterId, `consultation:${encounterId}`],
      ),
      /invoice_lines_source_key|duplicate key/,
    )
    assert.equal(await scalar(`select count(*)::int from jmc.invoice_lines`), 1)
  })
})

describe('medicine handed over is charged for', () => {
  test('a full dispense moves stock and puts the medicine on the bill', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await stockedMedicine(admin)
    const patientId = await addPatient(doctor)

    await as(doctor, 'save_consultation', {
      patientId, diagnosis: 'Fever',
      prescriptionItems: [
        { medicineId, medicineName: 'Paracetamol 500 mg', dosage: '1-0-1', instructions: '', quantity: 10 },
      ],
    })
    const prescriptionId = String(await scalar('select id from jmc.prescriptions'))

    await as(pharmacy, 'dispense_rx', { prescriptionId })

    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 90, 'stock moved')

    // ₹30 a tablet from the batch it came out of, ten tablets, on the same
    // bill as the consultation. Before Slice 4 this line did not exist and the
    // clinic gave the medicine away.
    const lines = await rows('select source, description, quantity, amount from jmc.invoice_lines order by line_number')
    assert.deepEqual(lines.map((line) => `${line.source} ${line.amount}`), [
      'consultation_fee 300.00', 'prescription 300.00',
    ])
    assert.equal(Number(lines[1].quantity), 10)
    assert.equal(String(await scalar('select due from jmc.invoice_balances')), '600.00')
    assert.equal(
      await scalar('select count(*)::int from jmc.invoices'),
      1,
      'one visit, one bill — the fee and the medicine are not two checkouts',
    )
  })

  test('a later supply of the remainder adds only that supply', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await stockedMedicine(admin)
    const patientId = await addPatient(doctor)

    await as(doctor, 'save_consultation', {
      patientId, diagnosis: 'Fever',
      prescriptionItems: [
        { medicineId, medicineName: 'Paracetamol 500 mg', dosage: '1-0-1', instructions: '', quantity: 10 },
      ],
    })
    const prescriptionId = String(await scalar('select id from jmc.prescriptions'))
    const lineId = String(await scalar('select id from jmc.prescription_lines'))

    await as(pharmacy, 'dispense_rx', {
      prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 6 }],
    })
    assert.equal(String(await scalar('select due from jmc.invoice_balances')), '480.00')

    await as(pharmacy, 'dispense_rx', {
      prescriptionId, lines: [{ prescriptionLineId: lineId, quantity: 4 }],
    })

    // Two medicine lines, one per supply, and the consultation fee charged
    // once. The remainder never re-charges the visit.
    const sources = (await rows('select source from jmc.invoice_lines order by line_number'))
      .map((line) => line.source)
    assert.deepEqual(sources, ['consultation_fee', 'prescription', 'prescription'])
    assert.equal(String(await scalar('select due from jmc.invoice_balances')), '600.00')
  })
})

describe('paying a bill', () => {
  async function unpaidBill() {
    const staff = await clinic()
    const patientId = await addPatient(staff.doctor)
    await as(staff.doctor, 'save_consultation', { patientId, diagnosis: 'Fever' })
    return {
      ...staff,
      patientId,
      invoiceId: String(await scalar('select id from jmc.invoices')),
    }
  }

  test('a payment is a record of money received, with its own receipt number', async () => {
    const { pharmacy, invoiceId } = await unpaidBill()

    const result = await as(pharmacy, 'take_payment', {
      invoiceId, parts: [{ method: 'upi', amount: 300, reference: 'UPI-99887766' }],
    })

    const [payment] = await rows('select * from jmc.payments')
    assert.match(payment.receipt_number, /^RCP-\d{6}$/)
    assert.equal(payment.kind, 'payment')
    assert.equal(payment.method, 'upi')
    assert.equal(payment.reference, 'UPI-99887766')
    assert.equal(payment.amount, '300.00')
    assert.equal(payment.received_by, pharmacy.id, 'who took it, not only an audit line')
    assert.deepEqual(result.data.receipts, [payment.receipt_number])

    const [bill] = await rows('select paid, due, payment_state from jmc.invoice_balances')
    assert.equal(bill.paid, '300.00')
    assert.equal(bill.due, '0.00')
    assert.equal(bill.payment_state, 'paid')
  })

  test('part payment leaves a balance, and the rest can be taken later', async () => {
    const { pharmacy, invoiceId } = await unpaidBill()

    const first = await as(pharmacy, 'take_payment', {
      invoiceId, parts: [{ method: 'cash', amount: 100 }],
    })
    assert.match(first.message, /₹100.00 taken. ₹200.00 still due/)
    assert.equal(String(await scalar('select payment_state from jmc.invoice_balances')), 'part_paid')

    await as(pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'upi', amount: 200 }] })
    assert.equal(String(await scalar('select payment_state from jmc.invoice_balances')), 'paid')
    assert.equal(await scalar('select count(*)::int from jmc.payments'), 2)

    // And the bill total never moved. It is what was charged.
    assert.equal(String(await scalar('select total from jmc.invoice_balances')), '300.00')
  })

  test('a split across two methods is two receipts in one transaction', async () => {
    const { pharmacy, invoiceId } = await unpaidBill()

    const result = await as(pharmacy, 'take_payment', {
      invoiceId,
      parts: [
        { method: 'cash', amount: 120 },
        { method: 'card', amount: 180, reference: 'XXXX-4471' },
      ],
    })

    assert.equal(result.data.receipts.length, 2)
    const methods = (await rows('select method, amount from jmc.payments order by method'))
      .map((row) => `${row.method} ${row.amount}`)
    assert.deepEqual(methods, ['card 180.00', 'cash 120.00'])
    assert.equal(String(await scalar('select payment_state from jmc.invoice_balances')), 'paid')
  })

  test('more than is due is refused, and a retry takes nothing twice', async () => {
    const { pharmacy, invoiceId } = await unpaidBill()

    await assert.rejects(
      as(pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'cash', amount: 500 }] }),
      /₹300.00 is due .* and ₹500.00 was offered/,
    )
    assert.equal(await scalar('select count(*)::int from jmc.payments'), 0)

    const key = 'one-tap-two-requests'
    await as(pharmacy, 'take_payment', {
      invoiceId, idempotencyKey: key, parts: [{ method: 'cash', amount: 300 }],
    })
    const again = await as(pharmacy, 'take_payment', {
      invoiceId, idempotencyKey: key, parts: [{ method: 'cash', amount: 300 }],
    })
    assert.equal(again.data.duplicate, true)
    assert.equal(await scalar('select count(*)::int from jmc.payments'), 1)
  })

  test('pay later is simply not paying, and the balance follows the patient', async () => {
    const { patientId, invoiceId } = await unpaidBill()
    void invoiceId

    const [balance] = await rows('select * from jmc.patient_balances where patient_id=$1', [patientId])
    assert.equal(balance.billed, '300.00')
    assert.equal(balance.paid, '0.00')
    assert.equal(balance.outstanding, '300.00')
    assert.equal(Number(balance.open_invoices), 1)
  })

  test('cash, UPI and card are the three methods, and nothing else is accepted', async () => {
    for (const method of ['cash', 'upi', 'card']) {
      const { pharmacy, invoiceId } = await unpaidBill()
      await as(pharmacy, 'take_payment', { invoiceId, parts: [{ method, amount: 300 }] })
      assert.equal(await scalar('select method from jmc.payments'), method)
    }

    const { pharmacy, invoiceId } = await unpaidBill()
    await assert.rejects(
      as(pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'gpay', amount: 300 }] }),
      /not valid/,
    )
  })

  test('the payment counter is admin and pharmacy; a doctor and a nurse are refused', async () => {
    // Policy register item 17, settled 12 September 2026. The nurse was here
    // until then, inherited from the retired application rather than decided.
    for (const role of ['doctor', 'nurse']) {
      const refused = await unpaidBill()
      await assert.rejects(
        as(refused[role], 'take_payment', {
          invoiceId: refused.invoiceId, parts: [{ method: 'cash', amount: 300 }],
        }),
        /role cannot perform/,
        `${role} must not be able to collect`,
      )
      // And the refusal left the bill exactly as it was.
      assert.equal(String(await scalar('select payment_state from jmc.invoice_balances')), 'unpaid')
    }

    for (const role of ['admin', 'pharmacy']) {
      const next = await unpaidBill()
      await as(next[role], 'take_payment', {
        invoiceId: next.invoiceId, parts: [{ method: 'cash', amount: 300 }],
      })
      assert.equal(String(await scalar('select payment_state from jmc.invoice_balances')), 'paid')
    }
  })

  test('a refund is money going the other way; a reversal says it never arrived', async () => {
    const { admin, pharmacy, invoiceId } = await unpaidBill()
    await as(pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'cash', amount: 300 }] })

    await as(admin, 'refund_payment', {
      invoiceId, reason: 'Charged for a visit that did not happen',
      refund: [{ method: 'cash', amount: 100 }],
    })
    const afterRefund = await rows('select paid, due, payment_state from jmc.invoice_balances')
    assert.equal(afterRefund[0].paid, '200.00', 'a refund reduces what has been paid')
    assert.equal(afterRefund[0].due, '100.00')
    assert.equal(afterRefund[0].payment_state, 'part_paid')

    // The reversal removes a payment from the arithmetic entirely, which is a
    // different statement from refunding it: one says the money came back, the
    // other says it never arrived.
    const paymentId = String(await scalar(
      `select id from jmc.payments where kind='payment' limit 1`,
    ))
    await as(admin, 'reverse_payment', { paymentId, reason: 'The UPI failed after the receipt printed' })
    const afterReversal = await rows('select paid, due from jmc.invoice_balances')
    assert.equal(afterReversal[0].paid, '-100.00', 'the refund stands; the payment does not')

    // Both keep their receipt numbers and stay on the record.
    assert.equal(await scalar('select count(*)::int from jmc.payments'), 2)
    assert.equal(
      await scalar(`select status from jmc.payments where id=$1`, [paymentId]),
      'reversed',
    )
  })

  test('financial history cannot be edited, only added to', async () => {
    const { pharmacy, invoiceId } = await unpaidBill()
    await as(pharmacy, 'take_payment', { invoiceId, parts: [{ method: 'cash', amount: 100 }] })

    await assert.rejects(
      rows(`update jmc.invoice_lines set amount = 1`),
      /append-only/,
    )
    await assert.rejects(rows(`delete from jmc.invoice_lines`), /append-only/)
    await assert.rejects(
      rows(`update jmc.payment_allocations set amount = 1`),
      /append-only/,
    )
  })
})

describe('money is exact, because a rupee is not a measurement', () => {
  // This began as a characterization of a defect: every money column was
  // `real`, and the test asserted the drift rather than the fix, because the
  // fix belonged with the code that does money arithmetic. Slice 3 made the
  // conversion, so the assertion is now the other way round. The float
  // arithmetic is still exercised below, because the reason to leave the type
  // does not stop being true once you have left it.
  test('every money column is numeric, and none is float', async () => {
    await resetClinic()

    const floats = await rows(
      `select table_name||'.'||column_name as column
         from information_schema.columns
        where table_schema='jmc'
          and data_type in ('real','double precision')
          and column_name not in ('temperature','weight')
        order by 1`,
    )
    assert.deepEqual(floats.map((row) => row.column), [])

    // The ones that carry rupees, named rather than counted, so a money column
    // added later as `real` fails here instead of passing by absence.
    for (const [table, column] of [
      ['invoice_lines', 'amount'],
      ['payments', 'amount'],
      ['payment_allocations', 'amount'],
      ['encounters', 'consultation_fee'],
      ['batches', 'mrp'],
      ['batches', 'purchase_price'],
      ['batches', 'selling_price'],
      ['otc_sales', 'total'],
      ['clinic_settings', 'consultation_fee'],
      ['cash_movements', 'amount'],
      ['till_sessions', 'expected_cash'],
      ['stock_writeoffs', 'cost_value'],
      ['supplier_returns', 'expected_credit'],
    ]) {
      assert.equal(
        await scalar(
          `select data_type from information_schema.columns
            where table_schema='jmc' and table_name=$1 and column_name=$2`,
          [table, column],
        ),
        'numeric',
        `${table}.${column} must hold exact decimal rupees`,
      )
    }
  })

  test('a hundred bills of 33.33 now add up to exactly 3333.00', async () => {
    await resetClinic()

    // The same sum that drifted while the column was `real`. sum(real) is real
    // in Postgres, so aggregating did not promote the error away — a hundred
    // fees of ₹33.33 came to 3332.9995 and that is the shape of the day-book
    // total.
    const asFloat = Number(await scalar(
      `select sum(v)::real from (select 33.33::real as v from generate_series(1,100)) t`,
    ))
    assert.ok(Math.abs(asFloat - 3333) > 0.0001, `float drift is the reason; got ${asFloat}`)

    const asNumeric = String(await scalar(
      `select sum(v) from (select 33.33::numeric(12,2) as v from generate_series(1,100)) t`,
    ))
    assert.equal(asNumeric, '3333.00')
  })

  test('and a bill written through the application comes back to the paisa', async () => {
    const { doctor } = await clinic()
    const patientId = await addPatient(doctor)

    await as(doctor, 'sign_consultation', {
      patientId, complaint: 'Fever', diagnosis: 'Acute viral febrile illness',
      diagnosisStatus: 'provisional',
      consultationFee: 33.33, feeReason: 'An awkward number, deliberately',
    })

    assert.equal(
      String(await scalar(`select amount from jmc.invoice_lines order by id desc limit 1`)),
      '33.33',
    )
  })
})
