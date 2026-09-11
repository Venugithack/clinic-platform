/**
 * The consultation, the fee, and the bill, as they behave today.
 *
 * Slice 4 rebuilds all of this, so the point of the file is to be exact about
 * the starting position. Three things recorded here are defects rather than
 * merely simple designs, and each is asserted so that the slice that fixes it
 * has to change a test on purpose:
 *
 *   1. The consultation fee charged does not come from clinic settings. It
 *      comes from the browser, defaulted to a literal 300 in the doctor's
 *      form. An admin who changes the fee on the Clinic screen changes
 *      nothing that is billed.
 *   2. Dispensing a prescription creates no bill line. Medicines handed over
 *      are never charged. The only bill the application can produce is the
 *      consultation fee.
 *   3. A bill is unpaid or paid. There is no part payment, no split, no
 *      balance, and the payment method lives on the bill rather than on a
 *      payment.
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
    assert.equal(await scalar('select count(*)::int from jmc.bills'), 1)

    const [bill] = await rows('select label, amount, status, payment_method, paid_at from jmc.bills')
    assert.equal(bill.label, 'Consultation')
    assert.equal(Number(bill.amount), 300)
    assert.equal(bill.status, 'unpaid')
    assert.equal(bill.payment_method, null)
    assert.equal(bill.paid_at, null)
  })

  test('the diagnosis stays free text, with structured clinical context beside it', async () => {
    const { doctor } = await clinic()
    const patientId = await addPatient(doctor)

    await assert.rejects(
      as(doctor, 'save_consultation', { patientId, diagnosis: '', consultationFee: 0 }),
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
      consultationFee: 0,
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
      'complaint_duration_unit', 'complaint_duration_value', 'created_at', 'diagnosis',
      'diagnosis_status', 'doctor_id', 'examination', 'follow_up_date', 'id', 'notes', 'patient_id',
    ])
  })

  test('no prescription row is written when the doctor prescribes nothing', async () => {
    const { doctor } = await clinic()
    const patientId = await addPatient(doctor)

    await as(doctor, 'save_consultation', { patientId, diagnosis: 'Advice only', consultationFee: 300 })

    assert.equal(await scalar('select count(*)::int from jmc.encounters'), 1)
    assert.equal(await scalar('select count(*)::int from jmc.prescriptions'), 0)
    // The fee still reaches the counter, which is the behaviour the owner
    // confirmed and which Slice 4 must preserve.
    assert.equal(await scalar('select count(*)::int from jmc.bills'), 1)
  })

  test('a zero fee produces no bill at all, so a waiver is indistinguishable from an omission', async () => {
    const { doctor } = await clinic()
    const patientId = await addPatient(doctor)

    await as(doctor, 'save_consultation', { patientId, diagnosis: 'Follow-up', consultationFee: 0 })

    // Nothing records that this consultation was deliberately free. There is
    // no waiver, no approver and no zero-value line — only an absence.
    assert.equal(await scalar('select count(*)::int from jmc.bills'), 0)
  })

  test('only a doctor may sign a consultation — an admin alone may not', async () => {
    const { admin, nurse, pharmacy, doctor } = await clinic()
    const patientId = await addPatient(doctor)
    const payload = { patientId, diagnosis: 'Fever', consultationFee: 0 }

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

    await as(doctor, 'save_consultation', { patientId, appointmentId, diagnosis: 'Fever', consultationFee: 0 })

    assert.equal(await scalar('select status from jmc.appointments where id=$1', [appointmentId]), 'done')
  })
})

describe('the consultation fee does not come from clinic settings', () => {
  test('changing the configured fee changes nothing that is billed', async () => {
    const { admin, doctor } = await clinic()

    await as(admin, 'update_clinic_settings', {
      name: 'Jayamurugan Clinic', address: 'Somewhere', phone: '+915550000000', email: '',
      drugLicenceNumber: 'DL-1', doctorRegistrationNumber: 'REG-1', gstin: '', footerNote: '',
      consultationFee: 450,
    })
    assert.equal(Number(await scalar('select consultation_fee from jmc.clinic_settings')), 450)

    const patientId = await addPatient(doctor)
    // What the doctor's browser actually sends. components/care-workspaces.tsx
    // hardcodes defaultValue="300" on this field; it has never read the
    // configured fee.
    await as(doctor, 'save_consultation', { patientId, diagnosis: 'Fever', consultationFee: 300 })

    assert.equal(
      Number(await scalar('select amount from jmc.bills')),
      300,
      'the bill follows the browser, not the clinic settings',
    )
  })

  test('the fee is whatever the client sends, including a fee nobody approved', async () => {
    const { doctor } = await clinic()
    const patientId = await addPatient(doctor)

    // There is no server-side check against the configured fee, no waiver
    // rule, and no approval. Slice 4 replaces this with a snapshot of the fee
    // that applied to the encounter.
    await as(doctor, 'save_consultation', { patientId, diagnosis: 'Fever', consultationFee: 7 })
    assert.equal(Number(await scalar('select amount from jmc.bills')), 7)
  })
})

describe('dispensing never charges for the medicine', () => {
  test('a full dispense moves stock and creates no bill line', async () => {
    const { admin, doctor, pharmacy } = await clinic()
    const medicineId = await stockedMedicine(admin)
    const patientId = await addPatient(doctor)

    await as(doctor, 'save_consultation', {
      patientId, diagnosis: 'Fever', consultationFee: 300,
      prescriptionItems: [
        { medicineId, medicineName: 'Paracetamol 500 mg', dosage: '1-0-1', instructions: '', quantity: 10 },
      ],
    })
    const prescriptionId = String(await scalar('select id from jmc.prescriptions'))

    const billsBefore = await scalar('select count(*)::int from jmc.bills')
    await as(pharmacy, 'dispense_rx', { prescriptionId })
    const billsAfter = await scalar('select count(*)::int from jmc.bills')

    assert.equal(Number(await scalar('select available_quantity from jmc.batches')), 90, 'stock moved')
    assert.equal(billsAfter, billsBefore, 'and nothing was charged for it')
    assert.equal(Number(await scalar(`select sum(amount) from jmc.bills`)), 300)
  })
})

describe('paying a bill', () => {
  async function unpaidBill() {
    const staff = await clinic()
    const patientId = await addPatient(staff.doctor)
    await as(staff.doctor, 'save_consultation', { patientId, diagnosis: 'Fever', consultationFee: 300 })
    return { ...staff, billId: String(await scalar('select id from jmc.bills')) }
  }

  test('payment is a state change on the bill, not a record of money received', async () => {
    const { pharmacy, billId } = await unpaidBill()

    await as(pharmacy, 'pay_bill', { billId, paymentMethod: 'upi' })

    const [bill] = await rows('select status, payment_method, amount, paid_at from jmc.bills')
    assert.equal(bill.status, 'paid')
    assert.equal(bill.payment_method, 'upi')
    assert.ok(bill.paid_at)

    // There is no payments table. Amount received, collecting staff member and
    // UPI reference are all absent; the actor survives only in audit_events.
    assert.equal(
      await scalar(
        `select count(*)::int from information_schema.tables
          where table_schema='jmc' and table_name in ('payments','payment_allocations')`,
      ),
      0,
    )
  })

  test('there is no part payment: the whole bill flips, or nothing does', async () => {
    const { pharmacy, billId } = await unpaidBill()

    // The command takes a method and no amount. 300 either is or is not paid.
    await as(pharmacy, 'pay_bill', { billId, paymentMethod: 'cash' })
    await assert.rejects(
      as(pharmacy, 'pay_bill', { billId, paymentMethod: 'cash' }),
      /already paid or no longer exists/,
    )
    assert.equal(Number(await scalar('select amount from jmc.bills')), 300)
  })

  test('cash, UPI and card are the three methods, and nothing else is accepted', async () => {
    for (const method of ['cash', 'upi', 'card']) {
      const { pharmacy, billId } = await unpaidBill()
      await as(pharmacy, 'pay_bill', { billId, paymentMethod: method })
      assert.equal(await scalar('select payment_method from jmc.bills'), method)
    }

    const { pharmacy, billId } = await unpaidBill()
    await assert.rejects(as(pharmacy, 'pay_bill', { billId, paymentMethod: 'gpay' }), /not valid/)
  })

  test('a doctor cannot collect payment; admin, nurse and pharmacy can', async () => {
    const first = await unpaidBill()
    await assert.rejects(as(first.doctor, 'pay_bill', { billId: first.billId, paymentMethod: 'cash' }), /role cannot perform/)

    for (const role of ['admin', 'nurse', 'pharmacy']) {
      const next = await unpaidBill()
      await as(next[role], 'pay_bill', { billId: next.billId, paymentMethod: 'cash' })
      assert.equal(await scalar('select status from jmc.bills'), 'paid')
    }
  })
})

describe('money is stored as float, which is a rounding bug waiting for volume', () => {
  test('bills.amount is `real`, and a sum of realistic fees is already wrong', async () => {
    await resetClinic()

    assert.equal(
      await scalar(
        `select data_type from information_schema.columns
          where table_schema='jmc' and table_name='bills' and column_name='amount'`,
      ),
      'real',
    )

    // Not a hypothetical. sum(real) is real in Postgres, so the error is not
    // even promoted away by aggregating: a hundred bills of 33.33 do not add
    // up to 3333.00, and this is the exact shape of the day-book total.
    const summed = Number(await scalar(
      `select sum(v)::real from (select 33.33::real as v from generate_series(1,100)) t`,
    ))
    assert.notEqual(summed, 3333)
    assert.ok(Math.abs(summed - 3333) > 0.0001, `expected drift, got ${summed}`)
  })
})
