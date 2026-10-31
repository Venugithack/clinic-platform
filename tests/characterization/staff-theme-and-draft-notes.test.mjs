/**
 * Two things the screens were holding that the clinic was not.
 *
 * Both existed in the interface and nowhere else, and in both cases the
 * interface was quietly telling a staff member something untrue: a follow-up
 * reminder that a draft save silently destroyed under a green confirmation,
 * and an appearance that followed the tablet rather than the person who chose
 * it. Migration 20260917000000 gave each of them a column; these are the tests
 * that say the column is actually reached.
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { auth, snapshot } from '../support/backend.mjs'
import {
  as,
  clinicDate,
  closeClinic,
  makeStaff,
  resetClinic,
  rows,
  scalar,
  tokenFor,
} from '../support/clinic.mjs'

after(async () => { await closeClinic() })

async function clinic() {
  await resetClinic()
  const doctor = await makeStaff({ name: 'Draft Doctor', username: 'draft-doctor', roles: ['doctor'] })
  const nurse = await makeStaff({ name: 'Night Nurse', username: 'night-nurse', roles: ['nurse'] })

  await as(doctor, 'create_patient', {
    name: 'Follow Up Patient', age: 51, sex: 'male', phone: '+999700000501',
  })
  const patientId = String(await scalar(`select id from jmc.patients where name='Follow Up Patient'`))
  await as(doctor, 'create_appointment', {
    patientId, reason: 'Review', scheduledAt: new Date().toISOString(),
  })

  // A prescribable medicine, so a signed visit actually produces a
  // prescription to ask for a copy of.
  const admin = await makeStaff({ name: 'Stock Admin', username: 'stock-admin', roles: ['admin'] })
  await as(admin, 'add_medicine', {
    code: 'THEME-PCM-650', name: 'Relief', genericName: 'Paracetamol', strength: '650 mg',
    dosageForm: 'tablet', route: 'Oral', unit: 'tablet',
    saleClass: 'prescription', schedule: 'H', reorderLevel: 10, targetStock: 100,
    initialQuantity: 100, batchNumber: 'TH-PCM', expiry: await clinicDate(400),
    mrp: 40, purchasePrice: 20, sellingPrice: 35,
  })
  const medicineId = String(await scalar(`select id from jmc.medicines where code='THEME-PCM-650'`))

  return { doctor, nurse, admin, patientId, medicineId }
}

describe('the follow-up note survives a draft save', () => {
  test('it is stored, returned, and not quietly dropped', async () => {
    const { doctor, patientId } = await clinic()

    await as(doctor, 'save_consultation_draft', {
      patientId,
      complaint: 'Cough',
      advice: 'Rest and fluids',
      followUpNote: 'Check the chest again and repeat the sugar test',
    })

    /*
     * The column, first. Before this migration the field went into the command
     * payload, was read by `sign_consultation`, and had nowhere to live in
     * between — so it only ever survived a visit that was signed in one sitting.
     */
    assert.equal(
      await scalar('select follow_up_note from jmc.consultation_drafts where patient_id=$1', [patientId]),
      'Check the chest again and repeat the sugar test',
    )

    // And the way back out, which is what the doctor's screen re-hydrates from.
    const record = await snapshot.readPatientRecord(patientId, doctor.id)
    assert.equal(
      record.draft.followUpNote,
      'Check the chest again and repeat the sugar test',
      'the draft the tablet reads back must carry the reminder that was typed',
    )
  })

  test('saving the draft again does not wipe a note that was already there', async () => {
    const { doctor, patientId } = await clinic()

    await as(doctor, 'save_consultation_draft', {
      patientId, complaint: 'Cough', followUpNote: 'Bring the old films',
    })
    // The second save is the one that used to destroy it: the sheet came back
    // from the server without the field, so the next save wrote an empty one.
    await as(doctor, 'save_consultation_draft', {
      patientId, complaint: 'Cough and fever', followUpNote: 'Bring the old films',
    })

    assert.equal(await scalar('select count(*)::int from jmc.consultation_drafts'), 1, 'still one draft')
    assert.equal(
      await scalar('select follow_up_note from jmc.consultation_drafts where patient_id=$1', [patientId]),
      'Bring the old films',
    )
  })

  test('an empty note still falls back to the advice when the visit is signed', async () => {
    const { doctor, patientId } = await clinic()

    await as(doctor, 'sign_consultation', {
      patientId,
      diagnosis: 'Acute bronchitis',
      advice: 'Rest and fluids',
      followUpDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    })

    const followUps = await rows('select note from jmc.follow_ups where patient_id=$1', [patientId])
    assert.equal(followUps.length, 1)
    assert.equal(
      followUps[0].note,
      'Rest and fluids',
      'an unwritten reminder falls back to the advice, as it always has',
    )
  })
})

describe('the appearance belongs to the person, not the tablet', () => {
  test('it is stored on the account and comes back on the session', async () => {
    const { nurse } = await clinic()

    // Nobody has chosen yet, so the account follows the device.
    assert.equal(await scalar('select theme from jmc.staff where id=$1', [nurse.id]), 'system')

    const saved = await as(nurse, 'set_theme', { theme: 'night' })
    assert.equal(saved.data.theme, 'night')
    assert.equal(await scalar('select theme from jmc.staff where id=$1', [nurse.id]), 'night')

    /*
     * On the SESSION, which is the half that makes it follow somebody onto
     * another tablet. A value written to a column nothing projects would look
     * saved and change nothing the next time they signed in.
     */
    const session = await auth.getSession(await tokenFor(nurse))
    assert.equal(session.theme, 'night', 'the session a fresh sign-in builds must carry the choice')
  })

  test('one person choosing does not change anybody else', async () => {
    const { doctor, nurse } = await clinic()

    await as(nurse, 'set_theme', { theme: 'contrast' })

    assert.equal(await scalar('select theme from jmc.staff where id=$1', [nurse.id]), 'contrast')
    assert.equal(
      await scalar('select theme from jmc.staff where id=$1', [doctor.id]),
      'system',
      'a preference is one account’s and takes no staff id from its payload',
    )
  })

  test('an appearance the clinic does not recognise is refused', async () => {
    const { nurse } = await clinic()

    await assert.rejects(
      as(nurse, 'set_theme', { theme: 'neon' }),
      /theme/i,
      'the command refuses a value outside the three themes and system',
    )
    assert.equal(
      await scalar('select theme from jmc.staff where id=$1', [nurse.id]),
      'system',
      'and a refused command changes nothing at all',
    )
  })

  test('choosing to follow the tablet is itself a choice that travels', async () => {
    const { nurse } = await clinic()

    await as(nurse, 'set_theme', { theme: 'paper' })
    await as(nurse, 'set_theme', { theme: 'system' })

    assert.equal(
      await scalar('select theme from jmc.staff where id=$1', [nurse.id]),
      'system',
      'going back to following the device is stored rather than left as a gap',
    )
  })

  test('every role may set their own, because it authorizes nothing', async () => {
    const { doctor, nurse } = await clinic()
    const pharmacist = await makeStaff({
      name: 'Counter', username: 'counter-theme', roles: ['pharmacy'],
    })

    for (const [staff, theme] of [[doctor, 'paper'], [nurse, 'night'], [pharmacist, 'contrast']]) {
      const result = await as(staff, 'set_theme', { theme })
      assert.equal(result.data.theme, theme, `${staff.username} may choose their own appearance`)
    }
  })
})

describe('the print audit says what it can actually prove', () => {
  test('a recorded copy is a REQUEST, because a browser cannot see paper', async () => {
    const { doctor, patientId, medicineId } = await clinic()
    const signed = await as(doctor, 'sign_consultation', {
      patientId,
      diagnosis: 'Acute bronchitis',
      advice: 'Rest',
      prescriptionItems: [{
        medicineId,
        doseAmount: '1',
        doseUnit: 'tablet',
        frequency: 'twice_daily',
        timing: 'after_food',
        route: 'Oral',
        durationValue: 3,
        durationUnit: 'day',
        instructions: 'After food',
        quantity: 6,
      }],
    })

    const first = await as(doctor, 'record_prescription_print', {
      prescriptionId: signed.data.prescriptionId,
    })
    const second = await as(doctor, 'record_prescription_print', {
      prescriptionId: signed.data.prescriptionId,
    })

    assert.match(first.message, /requested/i, 'the clinic records a request, never a confirmed print')
    assert.match(second.message, /reprint requested/i)
    assert.doesNotMatch(first.message, /\bprinted\b/i, 'nothing here may claim paper exists')

    /*
     * The row is written BEFORE `window.print()` opens the operating system's
     * dialogue, deliberately, so a copy taken during a crash is still on the
     * record. The dialogue never reports whether the operator pressed Print or
     * Cancel, so the audit line says what the clinic knows: a copy was asked
     * for.
     */
    const audited = await rows(
      `select summary from jmc.audit_events where action='prescription.printed' order by summary`,
    )
    assert.equal(audited.length, 2)
    for (const row of audited) {
      assert.match(row.summary, /requested/i, `audit line must say requested: ${row.summary}`)
      assert.doesNotMatch(row.summary, /^Printed|^Reprinted/, 'and must not assert that it printed')
    }
  })
})
