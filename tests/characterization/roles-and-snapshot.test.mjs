/**
 * Who sees what, as it behaves today.
 *
 * Two separate boundaries are recorded here, and they are enforced in two
 * different files:
 *
 *   - `commands.ts` decides who may DO a thing, with `requireRole`.
 *   - `snapshot.ts` decides who may SEE a thing, by choosing a different query
 *     per role rather than filtering afterwards.
 *
 * The second is the one that matters for Slice 5. Clinical images will need a
 * privacy boundary that holds under test, and there is no point building it on
 * top of a snapshot that quietly ships every patient's phone number to the
 * pharmacy counter. This file establishes that it does not.
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { snapshot } from '../support/backend.mjs'
import { as, clinicDate, closeClinic, makeStaff, resetClinic, rows, scalar, sessionFor } from '../support/clinic.mjs'

after(async () => { await closeClinic() })

/** One staff member per role, plus a doctor who is also an admin. */
async function everyRole() {
  await resetClinic()
  const staff = {
    admin: await makeStaff({ name: 'Admin', roles: ['admin'], username: 'admin', pin: '482913' }),
    doctor: await makeStaff({ name: 'Doctor', roles: ['doctor'], username: 'doc', pin: '573104' }),
    nurse: await makeStaff({ name: 'Nurse', roles: ['nurse'], username: 'nur', pin: '618205' }),
    pharmacy: await makeStaff({ name: 'Pharmacist', roles: ['pharmacy'], username: 'pharm', pin: '704816' }),
    adminDoctor: await makeStaff({ name: 'Owner', roles: ['admin', 'doctor'], username: 'owner', pin: '815927' }),
  }

  await as(staff.nurse, 'create_patient', {
    name: 'Kamala Test', age: 52, sex: 'female', phone: '+915550000001', address: '12 Test Street',
  })
  const patientId = String(await scalar('select id from jmc.patients'))

  await as(staff.admin, 'add_medicine', {
    code: 'PCM500', name: 'Paracetamol', strength: '500 mg', dosageForm: 'tablet',
    unit: 'tablet', saleClass: 'otc', schedule: 'OTC', reorderLevel: 20, targetStock: 200,
    initialQuantity: 100, batchNumber: 'PCM-A', expiry: await clinicDate(400),
    mrp: 30, purchasePrice: 18, sellingPrice: 30,
  })

  await as(staff.doctor, 'save_consultation', {
    patientId, diagnosis: 'Fever', notes: 'Private clinical note', advice: 'Rest', consultationFee: 300,
  })

  return { ...staff, patientId }
}

describe('the snapshot is scoped by role, at the query rather than after it', () => {
  test('the pharmacy counter receives patient ids and no patient details', async () => {
    const staff = await everyRole()

    const counter = await snapshot.readSnapshot(sessionFor(staff.pharmacy))

    assert.equal(counter.patients.length, 1, 'the count still has to be right — Overview prints it')
    const [patient] = counter.patients
    assert.ok(patient.id)
    assert.equal(patient.name, '', 'no name reaches the counter')
    assert.equal(patient.phone, '', 'no phone number reaches the counter')
    assert.equal(patient.address, '', 'no address reaches the counter')

    // Worth recording rather than asserting away: `sex` is typed
    // 'female' | 'male' | 'other' and arrives as the empty string, which the
    // mapper reaches by an `as` cast. The scoping is right; the type is a
    // promise the code does not keep.
    assert.equal(patient.sex, '')
  })

  test('doctor, nurse and admin all receive the care register in full', async () => {
    const staff = await everyRole()

    for (const role of ['admin', 'doctor', 'nurse']) {
      const seen = await snapshot.readSnapshot(sessionFor(staff[role]))
      assert.equal(seen.patients[0].name, 'Kamala Test', `${role} must see the patient's name`)
      assert.equal(seen.patients[0].phone, '+915550000001', `${role} must see the phone`)
    }
  })

  test('a patient’s home address reaches nobody through the snapshot', async () => {
    const staff = await everyRole()

    // Not a role rule — the column is simply not selected for anyone. The one
    // document that legally needs it, the Schedule H1 register, reads the
    // database directly.
    for (const role of ['admin', 'doctor', 'nurse', 'pharmacy']) {
      const seen = await snapshot.readSnapshot(sessionFor(staff[role]))
      assert.equal(seen.patients[0].address, '', `${role} must not receive an address`)
    }
    assert.equal(await scalar('select address from jmc.patients'), '12 Test Street')
  })

  test('only an admin receives the staff roster with phone numbers and last sign-in', async () => {
    const staff = await everyRole()

    const asAdmin = await snapshot.readSnapshot(sessionFor(staff.admin))
    assert.ok(asAdmin.staff.length >= 5)

    for (const role of ['doctor', 'nurse', 'pharmacy']) {
      const seen = await snapshot.readSnapshot(sessionFor(staff[role]))
      assert.deepEqual(seen.staff, [], `${role} must not receive the staff roster`)
    }
  })

  test('clinical encounters go to the doctor, not to the counter', async () => {
    const staff = await everyRole()

    assert.equal((await snapshot.readSnapshot(sessionFor(staff.doctor))).encounters.length, 1)
    assert.deepEqual((await snapshot.readSnapshot(sessionFor(staff.pharmacy))).encounters, [])
  })

  test('holding two roles gets the union, not the intersection', async () => {
    const staff = await everyRole()

    const owner = await snapshot.readSnapshot(sessionFor(staff.adminDoctor))

    assert.ok(owner.staff.length >= 5, 'the admin half brings the roster')
    assert.equal(owner.encounters.length, 1, 'the doctor half brings the clinical record')
  })

  test('the whole-clinic snapshot never carries a patient’s history', async () => {
    const staff = await everyRole()
    const seen = await snapshot.readSnapshot(sessionFor(staff.doctor))

    // Slice 5 must keep it this way for images. History is fetched per patient
    // by `record`, so a clinic open for two years does not make every tap
    // slower — and image bytes must never be added to this object.
    assert.equal('patientRecord' in seen, false)
    assert.equal('images' in seen, false)
    assert.equal('payments' in seen, false)
    assert.equal('stockMovements' in seen, false)
  })

  test('one patient’s record is fetched on demand, and only then', async () => {
    const staff = await everyRole()

    const record = await snapshot.readPatientRecord(staff.patientId)
    assert.equal(record.patientId, staff.patientId)
    assert.equal(record.encounters.length, 1)
    assert.equal(record.encounters[0].notes, 'Private clinical note')
  })
})

describe('who may do what', () => {
  const forbidden = [
    ['doctor', 'dispense_rx', 'the doctor cannot dispense'],
    ['doctor', 'pay_bill', 'the doctor cannot collect payment'],
    ['nurse', 'save_consultation', 'the nurse cannot sign a consultation'],
    ['nurse', 'add_medicine', 'the nurse cannot change the formulary'],
    ['pharmacy', 'create_patient', 'the counter cannot register a patient'],
    ['pharmacy', 'add_vitals', 'the counter cannot record vitals'],
    ['pharmacy', 'create_staff', 'the counter cannot create staff'],
  ]

  for (const [role, action, why] of forbidden) {
    test(why, async () => {
      const staff = await everyRole()
      await assert.rejects(as(staff[role], action, {}), /role cannot perform/)
    })
  }

  test('the doctor can run the whole check-in alone, on a day with no nurse', async () => {
    const staff = await everyRole()

    // The brief's Slice 1 gate, end to end and in one account: find or
    // register the patient, create today's visit, record what vitals he can,
    // and open the consultation. Creating the visit was the missing third of
    // it — before Slice 1 the doctor had to borrow the nurse's login, which
    // then attributed every write for the rest of that visit to her.
    await as(staff.doctor, 'create_patient', {
      name: 'Walk In', age: 30, sex: 'male', phone: '+915550000009',
    })
    const walkIn = String(await scalar(`select id from jmc.patients where name='Walk In'`))

    await as(staff.doctor, 'create_appointment', {
      patientId: walkIn, reason: 'Fever', scheduledAt: new Date().toISOString(),
    })
    const appointmentId = String(await scalar('select id from jmc.appointments where patient_id=$1', [walkIn]))
    assert.ok(appointmentId)
    assert.equal(await scalar('select status from jmc.appointments where id=$1', [appointmentId]), 'waiting')

    // No pulse oximeter to hand, because the nurse has it. Recording four of
    // five is allowed; inventing the fifth is what this exists to prevent.
    await as(staff.doctor, 'add_vitals', {
      patientId: walkIn, bp: '120/80', temperature: 37.2, pulse: 76, weight: 64,
      notMeasuredNote: 'No oximeter in the cabin',
    })

    await as(staff.doctor, 'save_consultation', {
      patientId: walkIn, appointmentId, diagnosis: 'Viral fever', consultationFee: 0,
    })

    assert.equal(await scalar('select status from jmc.appointments where id=$1', [appointmentId]), 'done')

    // And every one of those writes is attributed to the doctor himself.
    const actors = await scalar(
      `select count(distinct actor_id)::int from jmc.audit_events where actor_id=$1`, [staff.doctor.id],
    )
    assert.equal(actors, 1)
  })

  test('the doctor still cannot dispense or take payment', async () => {
    const staff = await everyRole()

    // Widening check-in does not widen anything else. The pharmacy counter
    // and the cash drawer are somebody else's job, and the capability matrix
    // in PRODUCT_UX_PLAN.md §5.5 says so.
    await assert.rejects(as(staff.doctor, 'dispense_rx', { prescriptionId: 'x' }), /role cannot perform/)
    await assert.rejects(as(staff.doctor, 'pay_bill', { billId: 'x' }), /role cannot perform/)
  })

  test('the nurse and admin can still start a visit', async () => {
    const staff = await everyRole()

    for (const role of ['nurse', 'admin']) {
      await as(staff[role], 'create_appointment', {
        patientId: staff.patientId, reason: 'Review', scheduledAt: new Date().toISOString(),
      })
    }
    assert.equal(await scalar('select count(*)::int from jmc.appointments'), 2)
  })

  test('the pharmacy counter still cannot start a visit', async () => {
    const staff = await everyRole()

    await assert.rejects(
      as(staff.pharmacy, 'create_appointment', {
        patientId: staff.patientId, reason: 'Fever', scheduledAt: new Date().toISOString(),
      }),
      /role cannot perform/,
    )
  })

  test('an admin who is not a doctor cannot sign a consultation', async () => {
    const staff = await everyRole()

    // Authority follows the clinical role, not the level of access. An admin
    // account must not be a way around a prescriber's registration.
    await assert.rejects(
      as(staff.admin, 'save_consultation', { patientId: staff.patientId, diagnosis: 'Fever', consultationFee: 0 }),
      /role cannot perform/,
    )
    await as(staff.adminDoctor, 'save_consultation', {
      patientId: staff.patientId, diagnosis: 'Fever', consultationFee: 0,
    })
  })
})

describe('a reading nobody took is recorded as not taken', () => {
  test('a partial set saves, and the missing readings come back absent — not zero', async () => {
    const staff = await everyRole()

    // Every field was required until Slice 1, so a doctor with no pulse
    // oximeter could save all five or none. What people do then is type 98,
    // because it usually is — and the record acquires a measurement nobody
    // took, indistinguishable from a real one forever.
    await as(staff.doctor, 'add_vitals', {
      patientId: staff.patientId, bp: '120/80', temperature: 37.2, pulse: 76, weight: 64,
      notMeasuredNote: 'No oximeter in the cabin',
    })

    const [row] = await rows('select bp, temperature, pulse, spo2, weight, not_measured_note from jmc.vitals')
    assert.equal(row.bp, '120/80')
    assert.equal(Number(row.pulse), 76)
    assert.equal(row.spo2, null, 'not measured is NULL, never 0')
    assert.equal(row.not_measured_note, 'No oximeter in the cabin')

    // And it survives the trip to the tablet as absence. `num()` would have
    // read the null as 0, and a SpO2 of 0 on a screen reads as a patient who
    // is not breathing.
    const seen = (await snapshot.readSnapshot(sessionFor(staff.doctor))).vitals[0]
    assert.equal(seen.spo2, undefined)
    assert.equal(seen.pulse, 76)
    assert.equal(seen.notMeasuredNote, 'No oximeter in the cabin')
  })

  test('a single reading is enough', async () => {
    const staff = await everyRole()

    await as(staff.doctor, 'add_vitals', { patientId: staff.patientId, temperature: 38.4 })

    const seen = (await snapshot.readSnapshot(sessionFor(staff.doctor))).vitals[0]
    assert.equal(seen.temperature, 38.4)
    assert.equal(seen.bp, undefined)
    assert.equal(seen.weight, undefined)
  })

  test('a row of nothing at all is refused', async () => {
    const staff = await everyRole()

    // "Not measured" must not become a way to save an empty record. The
    // database enforces this too; the command says so first, so the tablet is
    // told what to do rather than shown a constraint violation.
    await assert.rejects(
      as(staff.doctor, 'add_vitals', { patientId: staff.patientId }),
      /at least one reading/,
    )
    await assert.rejects(
      as(staff.doctor, 'add_vitals', { patientId: staff.patientId, bp: '', notMeasuredNote: 'nothing to hand' }),
      /at least one reading/,
    )
    assert.equal(await scalar('select count(*)::int from jmc.vitals'), 0)
  })

  test('a reading that IS given is still range-checked', async () => {
    const staff = await everyRole()

    // Allowing a blank is not the same as no longer checking the numbers.
    await assert.rejects(
      as(staff.doctor, 'add_vitals', { patientId: staff.patientId, temperature: 12 }),
      /temperature must be at least/,
    )
  })

  test('what was not measured is named in the audit trail', async () => {
    const staff = await everyRole()

    await as(staff.doctor, 'add_vitals', { patientId: staff.patientId, bp: '118/76' })

    const summary = String(await scalar(
      `select summary from jmc.audit_events where action='vitals.recorded'`,
    ))
    assert.match(summary, /not measured: temperature, pulse, SpO2, weight/)
  })

  test('a repeated reading is retained rather than replacing the first', async () => {
    const staff = await everyRole()

    for (const pulse of [72, 88]) {
      await as(staff.nurse, 'add_vitals', {
        patientId: staff.patientId, bp: '120/80', temperature: 37, pulse, spo2: 98, weight: 60,
      })
    }

    assert.equal(await scalar('select count(*)::int from jmc.vitals'), 2)
  })
})
