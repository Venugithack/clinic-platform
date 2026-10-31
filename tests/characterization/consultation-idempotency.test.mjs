/**
 * One consultation, however many times the tablet says it.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 *
 * `unprotected-write-paths.test.mjs` pinned the fault: a sheet signed twice
 * for a patient with no visit row open today produced two encounters, two
 * invoices and two ₹300 fee lines — a ₹600 bill for one visit. That file's
 * job was to record what the code did. This file's job is to hold the fix to
 * what the code must now do, and the two are deliberately separate: the old
 * assertions still stand for a caller that sends no key, because the server
 * still has to answer one, and that is stated there rather than quietly
 * dropped here.
 *
 * ── THE FOUR THINGS AN IDEMPOTENCY KEY HAS TO DO ───────────────────────────
 *
 * Same key, same sheet — the second call is a retry and gets the FIRST call's
 * encounter, prescription number and signing time back. Not a fresh success
 * with fresh numbers, because the screen behind it prints them.
 *
 * Same key, a different sheet — refused out loud. A tablet that reuses a key
 * across two consultations must never be answered with the earlier patient's
 * record, which is the fault the counter met when one payment key was shared
 * across two bills.
 *
 * Two tablets, one key, at once — exactly one consultation exists afterwards,
 * and both callers are told the truth about it. This is the case a pre-check
 * alone cannot cover and the unique index has to.
 *
 * And every side effect counted, not just the encounter: the invoice, the fee
 * line, the prescription, the follow-up, the audit row and the phrase counter.
 * A retry that creates one encounter and two follow-ups is still a retry that
 * happened twice.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, test } from 'node:test'
import { edgeGet, edgeRequest } from '../support/backend.mjs'
import { as, closeClinic, makeStaff, resetClinic, rows, scalar, tokenFor } from '../support/clinic.mjs'

after(async () => { await closeClinic() })

/** A doctor, a patient, and nothing else — no visit row, which is the gap. */
async function consultingRoom() {
  await resetClinic()
  const doctor = await makeStaff({ name: 'Doctor', roles: ['doctor'], username: 'doc', pin: '5731' })
  await as(doctor, 'create_patient', { name: 'Walk In', age: 40, sex: 'male', phone: '+9990000001' })
  const patientId = String(await scalar('select id from jmc.patients where name=$1', ['Walk In']))
  return { doctor, patientId }
}

/**
 * One medicine to prescribe. Created by a pharmacist, because policy register
 * 12 says the formulary is pharmacist and admin work and the command agrees.
 */
async function medicine() {
  const pharmacist = await makeStaff({
    name: 'Pharmacist', roles: ['pharmacy'], username: 'ph', pin: '5731',
  })
  await as(pharmacist, 'add_medicine', {
    code: 'PARA500', name: 'Paracetamol 500', unit: 'tablet', saleClass: 'otc',
    reorderLevel: '10', targetStock: '100', initialQuantity: '0',
  })
  return String(await scalar(`select id from jmc.medicines where code='PARA500'`))
}

/** Everything one signing leaves behind, counted for one patient. */
async function effectsFor(patientId) {
  const count = async (text) => Number(await scalar(text, [patientId]))
  return {
    encounters: await count('select count(*)::int from jmc.encounters where patient_id=$1'),
    prescriptions: await count('select count(*)::int from jmc.prescriptions where patient_id=$1'),
    prescriptionLines: await count(
      `select count(*)::int from jmc.prescription_lines l
         join jmc.prescriptions p on p.id = l.prescription_id where p.patient_id=$1`),
    followUps: await count('select count(*)::int from jmc.follow_ups where patient_id=$1'),
    invoices: await count('select count(*)::int from jmc.invoices where patient_id=$1'),
    feeLines: await count(
      `select count(*)::int from jmc.invoice_lines il
         join jmc.invoices i on i.id = il.invoice_id
        where i.patient_id=$1 and il.source = 'consultation_fee'`),
    charged: String(await scalar(
      `select coalesce(sum(il.amount), 0)::text from jmc.invoice_lines il
         join jmc.invoices i on i.id = il.invoice_id
        where i.patient_id=$1 and il.source = 'consultation_fee'`, [patientId])),
    completions: Number(await scalar(
      `select count(*)::int from jmc.audit_events
        where action = 'encounter.completed' and summary like $1`, [`%${patientId}%`])),
  }
}

describe('signing one consultation twice under one key', () => {
  test('the retry gets the first signing back, and nothing happens a second time', async () => {
    const { doctor, patientId } = await consultingRoom()
    const medicineId = await medicine()
    const idempotencyKey = randomUUID()
    const sheet = {
      patientId, idempotencyKey,
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
      followUpDate: '2026-09-30', followUpNote: 'Review if still febrile',
      prescriptionItems: [{
        medicineId, doseAmount: '1', doseUnit: 'tablet', frequency: 'twice_daily',
        timing: 'after_food', quantity: 10, instructions: 'With water',
      }],
    }

    const first = await as(doctor, 'sign_consultation', sheet)
    const second = await as(doctor, 'sign_consultation', sheet)

    assert.equal(second.data.duplicate, true, 'the second call must know it is a replay')
    assert.equal(second.data.encounterId, first.data.encounterId,
      'and must answer with the encounter the clinic actually holds')
    assert.equal(second.data.prescriptionId, first.data.prescriptionId)
    assert.equal(second.data.prescriptionNumber, first.data.prescriptionNumber,
      'a second prescription number for one visit is a second prescription')
    assert.equal(second.data.signedAt, first.data.signedAt,
      'and the signing time is when it was signed, not when it was asked about')
    assert.match(second.message, /already signed/)

    const after = await effectsFor(patientId)
    assert.deepEqual(after, {
      encounters: 1, prescriptions: 1, prescriptionLines: 1, followUps: 1,
      invoices: 1, feeLines: 1, charged: '300.00', completions: 1,
    }, 'one of everything — the bill, the order, the reminder and the audit row')
  })

  test('the phrase the doctor used is not counted twice either', async () => {
    const { doctor, patientId } = await consultingRoom()
    const sheet = {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Sore throat', diagnosis: 'Pharyngitis', notes: '', advice: 'Warm fluids',
    }

    await as(doctor, 'sign_consultation', sheet)
    await as(doctor, 'sign_consultation', sheet)

    const uses = Number(await scalar(
      `select use_count from jmc.clinical_phrase_preferences
        where doctor_id=$1 and kind='diagnosis'`, [doctor.id]))
    assert.equal(uses, 1, 'a replayed consultation must not inflate what the doctor reaches for')
  })

  test('a genuine second consultation for the same patient is not blocked', async () => {
    const { doctor, patientId } = await consultingRoom()
    const base = { patientId, complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest' }

    await as(doctor, 'sign_consultation', { ...base, idempotencyKey: randomUUID() })
    await as(doctor, 'sign_consultation', { ...base, idempotencyKey: randomUUID() })

    const { encounters, charged } = await effectsFor(patientId)
    assert.equal(encounters, 2, 'two visits are two visits; the key is the retry guard, not a lock')
    assert.equal(charged, '600.00', 'and two visits are charged twice, which is correct')
  })
})

describe('reusing one key for a different consultation', () => {
  test('a different patient under the same key is refused, not answered', async () => {
    const { doctor, patientId } = await consultingRoom()
    await as(doctor, 'create_patient', { name: 'Someone Else', age: 31, sex: 'female', phone: '+9990000002' })
    const otherId = String(await scalar('select id from jmc.patients where name=$1', ['Someone Else']))
    const idempotencyKey = randomUUID()

    await as(doctor, 'sign_consultation', {
      patientId, idempotencyKey, complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })
    await assert.rejects(
      () => as(doctor, 'sign_consultation', {
        patientId: otherId, idempotencyKey,
        complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
      }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_NAMES_ANOTHER_CONSULTATION',
          'the tablet has to be able to tell a stale reference from an edited sheet')
        assert.match(String(error.message), /belongs to a different consultation/)
        return true
      },
      'answering this with the first patient’s encounter is how one visit is filed under another',
    )

    assert.equal(
      Number(await scalar('select count(*)::int from jmc.encounters where patient_id=$1', [otherId])), 0,
      'and the refused consultation left nothing behind',
    )
  })

  test('a different diagnosis under the same key is refused', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()
    await as(doctor, 'sign_consultation', {
      patientId, idempotencyKey, complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })
    await assert.rejects(
      () => as(doctor, 'sign_consultation', {
        patientId, idempotencyKey, complaint: 'Fever', diagnosis: 'Dengue', notes: '', advice: 'Rest',
      }),
      (error) => {
        assert.equal(error.code, 'CONSULTATION_ALREADY_SIGNED')
        assert.match(String(error.message), /already signed/)
        return true
      },
    )
  })

  test('a different prescribed quantity under the same key is refused', async () => {
    const { doctor, patientId } = await consultingRoom()
    const medicineId = await medicine()
    const idempotencyKey = randomUUID()
    const line = {
      medicineId, doseAmount: '1', doseUnit: 'tablet', frequency: 'twice_daily',
      timing: 'after_food', instructions: '',
    }
    const sheet = {
      patientId, idempotencyKey, complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    }

    await as(doctor, 'sign_consultation', { ...sheet, prescriptionItems: [{ ...line, quantity: 10 }] })
    await assert.rejects(
      () => as(doctor, 'sign_consultation', { ...sheet, prescriptionItems: [{ ...line, quantity: 20 }] }),
      (error) => {
        assert.equal(error.code, 'CONSULTATION_ALREADY_SIGNED')
        return true
      },
      'ten tablets and twenty tablets are not the same order',
    )
  })

  test('a different fee decision under the same key is refused', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()
    const sheet = {
      patientId, idempotencyKey, complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    }

    await as(doctor, 'sign_consultation', sheet)
    await assert.rejects(
      () => as(doctor, 'sign_consultation', {
        ...sheet, feeWaived: true, feeReason: 'Staff family',
      }),
      (error) => {
        assert.equal(error.code, 'CONSULTATION_ALREADY_SIGNED')
        return true
      },
      'charging and waiving are different decisions about the same visit',
    )
  })

  test('whitespace and field order are not a different consultation', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()

    const first = await as(doctor, 'sign_consultation', {
      patientId, idempotencyKey, complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })
    // The same sheet, retyped by a retry that trimmed differently and sent its
    // keys in another order. Refusing this would strand the doctor.
    const second = await as(doctor, 'sign_consultation', {
      advice: '  Rest  ', notes: '', diagnosis: ' Viral fever', complaint: 'Fever ',
      idempotencyKey, patientId,
    })

    assert.equal(second.data.duplicate, true)
    assert.equal(second.data.encounterId, first.data.encounterId)
  })
})

describe('two tablets, one key, at the same moment', () => {
  test('exactly one consultation is created and both callers are told the truth', async () => {
    const { doctor, patientId } = await consultingRoom()
    const medicineId = await medicine()
    const idempotencyKey = randomUUID()
    const sheet = {
      patientId, idempotencyKey,
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
      followUpDate: '2026-09-30', followUpNote: 'Review',
      prescriptionItems: [{
        medicineId, doseAmount: '1', doseUnit: 'tablet', frequency: 'twice_daily',
        timing: 'after_food', quantity: 10, instructions: '',
      }],
    }

    const both = await Promise.allSettled([
      as(doctor, 'sign_consultation', sheet),
      as(doctor, 'sign_consultation', sheet),
    ])

    assert.deepEqual(
      both.map((outcome) => outcome.status), ['fulfilled', 'fulfilled'],
      `neither caller may be handed a constraint: ${JSON.stringify(both.map((o) => o.reason?.message))}`,
    )
    const [a, b] = both.map((outcome) => outcome.value)
    assert.equal(a.data.encounterId, b.data.encounterId, 'both answered with the same consultation')
    assert.equal(a.data.prescriptionNumber, b.data.prescriptionNumber)
    assert.equal(
      [a.data.duplicate, b.data.duplicate].filter(Boolean).length, 1,
      'one of them signed it and the other found it already signed',
    )

    const after = await effectsFor(patientId)
    assert.deepEqual(after, {
      encounters: 1, prescriptions: 1, prescriptionLines: 1, followUps: 1,
      invoices: 1, feeLines: 1, charged: '300.00', completions: 1,
    }, 'one of everything, from two simultaneous signings')
  })
})

/**
 * The walk-in that acquires a visit halfway through.
 *
 * A doctor opens a patient from the register — no visit row, so no appointment
 * id — presses Finish, and the reply is lost. Policy item 3 lets a doctor
 * create today's visit, and creating it is the tidy thing to do, so they do.
 * Then they press Finish again.
 *
 * Whether that second press writes anything depends on something the tablet
 * cannot see: whether the first one committed. Both directions were reproduced
 * against staging before this was changed, and both were wrong in the same
 * way — the consultation succeeded and the visit stayed `waiting`, attached to
 * nothing, with nobody coming to call it.
 *
 * The tablet now sends the visit it has on screen rather than the one the
 * attempt was opened against, and the clinic decides, because only the clinic
 * knows which branch this is.
 */
describe('a direct consultation that acquires a visit before the retry', () => {
  /** The visit a doctor creates for a patient already in front of them. */
  async function openVisit(doctor, patientId) {
    await as(doctor, 'create_appointment', {
      patientId, reason: 'Fever', scheduledAt: new Date().toISOString(),
    })
    return String(await scalar(
      `select id from jmc.appointments where patient_id=$1 and status='waiting'`, [patientId]))
  }

  const sheetFor = (patientId, idempotencyKey) => ({
    patientId, idempotencyKey,
    complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
  })

  test('when the first request never committed, the retry signs it AGAINST the visit', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()

    // The first press never reached the clinic. The visit is created, and the
    // retry carries it.
    const appointmentId = await openVisit(doctor, patientId)
    const signed = await as(doctor, 'sign_consultation',
      { ...sheetFor(patientId, idempotencyKey), appointmentId })

    assert.equal(signed.data.duplicate, undefined, 'nothing had committed, so this is a signing')
    assert.equal(
      String(await scalar('select appointment_id from jmc.encounters where patient_id=$1', [patientId])),
      appointmentId, 'and the consultation is attached to the visit it was for')
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [appointmentId])),
      'done', 'which takes the patient out of the queue rather than leaving them in it')

    const after = await effectsFor(patientId)
    assert.deepEqual(after, {
      encounters: 1, prescriptions: 0, prescriptionLines: 0, followUps: 0,
      invoices: 1, feeLines: 1, charged: '300.00', completions: 1,
    }, 'one of everything')
  })

  test('when the first request DID commit, the retry is refused and nothing is written twice', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()

    const first = await as(doctor, 'sign_consultation', sheetFor(patientId, idempotencyKey))
    const appointmentId = await openVisit(doctor, patientId)

    await assert.rejects(
      () => as(doctor, 'sign_consultation',
        { ...sheetFor(patientId, idempotencyKey), appointmentId }),
      (error) => {
        assert.equal(error.code, 'CONSULTATION_SIGNED_WITHOUT_THIS_VISIT',
          'and NOT the code the tablet rotates on — a fresh reference here signs it twice')
        assert.match(String(error.message), /still waiting/,
          'the doctor is told the visit is open, not only that the consultation exists')
        return true
      },
    )

    const after = await effectsFor(patientId)
    assert.deepEqual(after, {
      encounters: 1, prescriptions: 0, prescriptionLines: 0, followUps: 0,
      invoices: 1, feeLines: 1, charged: '300.00', completions: 1,
    }, 'one of everything — the refusal wrote nothing')
    assert.equal(
      String(await scalar('select id from jmc.encounters where patient_id=$1', [patientId])),
      first.data.encounterId, 'and it is still the consultation that was signed')
  })

  test('the leftover visit is not silent — it is an obligation on the patient', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()
    await as(doctor, 'sign_consultation', sheetFor(patientId, idempotencyKey))
    const appointmentId = await openVisit(doctor, patientId)

    const { body } = await edgeGet(
      'workspace', `?view=obligations&patientId=${patientId}`, await tokenFor(doctor))
    const unlinked = body.obligations.find((item) => item.kind === 'unlinked_consultation')

    assert.ok(unlinked, 'a refusal is read once and dismissed; this is the same fact written down')
    assert.equal(unlinked.severity, 'blocked')
    assert.equal(unlinked.owner, 'doctor')
    assert.match(unlinked.detail, /attached to no visit/)
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [appointmentId])),
      'waiting', 'the visit is still there — this slice reports it and does not decide it')
  })

  test('the ordinary retry still replays, and the visit it was signed against stays closed', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()
    const appointmentId = await openVisit(doctor, patientId)

    const first = await as(doctor, 'sign_consultation',
      { ...sheetFor(patientId, idempotencyKey), appointmentId })
    // Signing set the visit to `done` and the poll took it out of the snapshot,
    // so the tablet now has nothing to send. Silence is not disagreement.
    const retry = await as(doctor, 'sign_consultation', sheetFor(patientId, idempotencyKey))

    assert.equal(retry.data.duplicate, true)
    assert.equal(retry.data.encounterId, first.data.encounterId)
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [appointmentId])),
      'done')
    const { encounters, charged } = await effectsFor(patientId)
    assert.equal(encounters, 1)
    assert.equal(charged, '300.00')
  })

  /*
   * Slice 2 changed the code, and owner item 74 is why: two real visits for
   * one patient is exactly what "the patient never left and reception arrived
   * them again" looks like, so the tablet must not rotate into a second
   * encounter and a second fee. It fails closed and a doctor resolves it.
   */
  test('a genuinely different visit under the same key needs a doctor to say which it is', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()
    const first = await openVisit(doctor, patientId)
    await as(doctor, 'sign_consultation', { ...sheetFor(patientId, idempotencyKey), appointmentId: first })
    const second = await openVisit(doctor, patientId)

    await assert.rejects(
      () => as(doctor, 'sign_consultation',
        { ...sheetFor(patientId, idempotencyKey), appointmentId: second }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_NEEDS_RECONCILIATION',
          'reception creating a second queue row is not proof of a second consultation')
        return true
      },
    )
    assert.equal(
      Number(await scalar('select count(*)::int from jmc.encounters where patient_id=$1', [patientId])), 1)
  })
})

describe('what the key does not change', () => {
  test('a visit that came from the queue is still refused a second signature', async () => {
    const { doctor, patientId } = await consultingRoom()
    await as(doctor, 'create_appointment', {
      patientId, reason: 'Fever', scheduledAt: new Date().toISOString(),
    })
    const appointmentId = String(await scalar('select id from jmc.appointments limit 1'))
    const sheet = {
      patientId, appointmentId,
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    }

    // No key at all, and two DIFFERENT keys: the appointment guard is a fact
    // about the visit and does not depend on the caller's word for anything.
    await as(doctor, 'sign_consultation', { ...sheet, idempotencyKey: randomUUID() })
    await assert.rejects(
      () => as(doctor, 'sign_consultation', { ...sheet, idempotencyKey: randomUUID() }),
      /already finished/,
      'the key is added to that guard, never in place of it',
    )
    assert.equal(
      Number(await scalar('select count(*)::int from jmc.encounters where patient_id=$1', [patientId])), 1)
  })

  /**
   * The exposure that remains, pinned so it cannot be forgotten.
   *
   * The server accepts a call with no key because a tablet running the build
   * that is deployed today sends none, and refusing it would lock the clinic
   * out of signing. A caller that sends nothing therefore still has no
   * protection — it is the pre-W1 behaviour, unchanged, for exactly as long as
   * a pre-W1 build is in somebody's browser cache.
   *
   * This is asserted rather than described because a sentence in a document is
   * not evidence. When the compatibility window closes and the server begins
   * requiring a key, THIS test is the one that fails and says so.
   */
  test('a caller that sends no key is still unprotected, and that is the compatibility window', async () => {
    const { doctor, patientId } = await consultingRoom()
    const sheet = { patientId, complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest' }

    await as(doctor, 'sign_consultation', sheet)
    await as(doctor, 'sign_consultation', sheet)

    const { encounters, charged } = await effectsFor(patientId)
    assert.equal(encounters, 2,
      'an old cached build can still sign twice — the current repository client cannot, and does not')
    assert.equal(charged, '600.00', 'which is the ₹600 bill W1 exists to prevent, still reachable without a key')
  })

  /**
   * The retry the whole mechanism exists for, and why the visit travels with it.
   *
   * Consult resolves `appointmentId` from the snapshot as the patient's first
   * row that is neither done nor cancelled, and signing sets that row to
   * `done`. So on the retry that matters — signed, reply lost, poll landed —
   * there is no longer a visit row for the tablet to look up.
   *
   * The first fix for this dropped the appointment from the request identity
   * altogether, so that a retry sending nothing would still match. That made
   * this case pass and made a worse one possible: one patient's Monday and
   * Thursday became the same consultation, and Thursday replayed Monday. The
   * correction is that the TABLET stops re-resolving and re-sends the visit
   * its attempt was opened against (`lib/attempt-key.ts`), which is what the
   * second call below does.
   */
  test('a retry that still names the closed visit replays', async () => {
    const { doctor, patientId } = await consultingRoom()
    await as(doctor, 'create_appointment', {
      patientId, reason: 'Fever', scheduledAt: new Date().toISOString(),
    })
    const appointmentId = String(await scalar('select id from jmc.appointments limit 1'))
    const idempotencyKey = randomUUID()
    const sheet = {
      patientId, idempotencyKey, appointmentId,
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    }

    const first = await as(doctor, 'sign_consultation', sheet)
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [appointmentId])), 'done',
      'the poll that follows will find nothing to resolve, which is the whole difficulty')

    // A caller that still names the visit — the shape the tablet sent before
    // the second acceptance correction, and any other caller that has the id.
    // Same visit stored and asked for is compatible, so it replays. The
    // tablet's own retry now sends nothing at all, which is the case above.
    const second = await as(doctor, 'sign_consultation', sheet)

    assert.equal(second.data.duplicate, true)
    assert.equal(second.data.encounterId, first.data.encounterId)
    assert.equal(second.data.signedAt, first.data.signedAt, 'the original signing time, not a fresh one')
    assert.equal(
      Number(await scalar('select count(*)::int from jmc.encounters where patient_id=$1', [patientId])), 1)
  })

  /**
   * The case the first fix got wrong, pinned from the other side.
   *
   * The patient comes back. A new visit row is open, the doctor happens to
   * write down exactly what they wrote last time, and the tablet — buggy,
   * cached, or simply carrying an attempt nobody resolved — sends the earlier
   * key. Answering that with the earlier encounter would mean the second visit
   * never existed: no encounter, no fee, no prescription number, and a queue
   * row left waiting for a consultation that already happened days ago.
   */
  test('a later visit under the same key is refused, even with an identical sheet', async () => {
    const { doctor, patientId } = await consultingRoom()
    await as(doctor, 'create_appointment', {
      patientId, reason: 'Fever', scheduledAt: new Date().toISOString(),
    })
    const mondayVisit = String(await scalar('select id from jmc.appointments limit 1'))
    const idempotencyKey = randomUUID()
    const sheet = {
      patientId, idempotencyKey,
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    }

    const monday = await as(doctor, 'sign_consultation', { ...sheet, appointmentId: mondayVisit })

    await as(doctor, 'create_appointment', {
      patientId, reason: 'Fever again', scheduledAt: new Date().toISOString(),
    })
    const thursdayVisit = String(await scalar(
      'select id from jmc.appointments where id <> $1', [mondayVisit]))

    await assert.rejects(
      () => as(doctor, 'sign_consultation', { ...sheet, appointmentId: thursdayVisit }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_NEEDS_RECONCILIATION',
          'and the code says a person has to decide, because an identical sheet on a second visit '
          + 'is as likely to be one attendance recorded twice as two attendances')
        return true
      },
      'an identical sheet on a different visit is not automatically a retry of the first one',
    )

    assert.equal(
      Number(await scalar('select count(*)::int from jmc.encounters where patient_id=$1', [patientId])), 1,
      'Monday stands and Thursday wrote nothing')
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [thursdayVisit])), 'waiting',
      'and Thursday is untouched, so it can be signed properly under its own reference')

    /*
     * And Thursday is then signed under a reference of its own, which is what
     * the recovery is once a doctor has said this is a second attendance. From
     * Slice 2 that sentence is a recorded act —
     * `resolve_consultation_attempt`, owner item 74 — rather than the tablet
     * minting on its own; `slice2-reconciliation.test.mjs` walks it end to
     * end. What is proved here is the half that belongs to this file: the
     * refusal wrote nothing, Thursday is untouched, and a fresh reference
     * signs it correctly.
     */
    const thursday = await as(doctor, 'sign_consultation', {
      ...sheet, idempotencyKey: randomUUID(), appointmentId: thursdayVisit,
    })
    assert.notEqual(thursday.data.encounterId, monday.data.encounterId)
    assert.equal(
      Number(await scalar('select count(*)::int from jmc.encounters where patient_id=$1', [patientId])), 2)
  })

  /**
   * A different doctor under one key is a different consultation too.
   *
   * Two tablets on a shared desk, one holding an attempt nobody resolved. The
   * encounter records who signed it, and answering the second doctor with the
   * first doctor's encounter would attribute a signature to the wrong person.
   */
  test('a different doctor under the same key is refused', async () => {
    const { doctor, patientId } = await consultingRoom()
    const locum = await makeStaff({
      name: 'Locum', roles: ['doctor'], username: 'loc', pin: '4917',
    })
    const idempotencyKey = randomUUID()
    const sheet = {
      patientId, idempotencyKey,
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    }

    await as(doctor, 'sign_consultation', sheet)
    await assert.rejects(
      () => as(locum, 'sign_consultation', sheet),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_NAMES_ANOTHER_CONSULTATION')
        return true
      },
      'a signature is attributed to the person who made it',
    )
  })

  /**
   * Changing the sheet after an outcome nobody knows, and the way back.
   *
   * This is the one refusal that must NOT invite a fresh reference. The visit
   * matches, so this is the consultation the key named; it committed; and
   * signing is immutable. A tablet that rotated here would write a second
   * encounter and a second fee for one visit, which is W1 arriving by another
   * road. So the refusal names what was recorded and sends the doctor to look
   * at it — and the patient is not blocked, because the next visit has its own
   * row and its own attempt, which the test above signs.
   */
  test('an edited sheet after an unknown outcome is refused, and names what was signed', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()
    const sheet = {
      patientId, idempotencyKey,
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    }

    const signed = await as(doctor, 'sign_consultation', sheet)
    await assert.rejects(
      () => as(doctor, 'sign_consultation', { ...sheet, diagnosis: 'Dengue' }),
      (error) => {
        assert.equal(error.code, 'CONSULTATION_ALREADY_SIGNED')
        assert.match(String(error.message), /cannot be edited/,
          'the doctor is told the record stands, not invited to sign it again')
        return true
      },
    )

    const { encounters, charged } = await effectsFor(patientId)
    assert.equal(encounters, 1)
    assert.equal(charged, '300.00', 'one visit, one fee')
    assert.equal(
      String(await scalar('select diagnosis from jmc.encounters where id=$1', [signed.data.encounterId])),
      'Viral fever', 'and the signed record is exactly what was signed')
  })

  /**
   * The way back out of an edited sheet after an unknown outcome.
   *
   * `CONSULTATION_ALREADY_SIGNED` is deliberately not a refusal the tablet
   * rotates on — a fresh key there writes a second encounter and a second fee
   * for one visit. So the doctor has to be able to get out some other way, and
   * the contract names three. This is the first and the only one available
   * from the refused screen itself: restore the sheet to what was signed and
   * press again. An unedited sheet replays rather than writing anything, the
   * replay is a SUCCESS, and a success is what releases the attempt — after
   * which the patient's next consultation opens under a fresh reference.
   *
   * Without this the doctor is stuck, which is the "permanently blocked" case
   * the acceptance criteria name.
   */
  test('restoring the signed sheet replays, which is the way out of a refusal', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()
    const asSigned = {
      patientId, idempotencyKey,
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    }

    const signed = await as(doctor, 'sign_consultation', asSigned)

    // The reply was lost; the doctor edits the sheet and presses again.
    await assert.rejects(
      () => as(doctor, 'sign_consultation', { ...asSigned, diagnosis: 'Dengue' }),
      (error) => error.code === 'CONSULTATION_ALREADY_SIGNED',
    )

    // The refusal named the record. Restoring the sheet to it and pressing
    // again is a replay, and a replay is a success.
    const recovered = await as(doctor, 'sign_consultation', asSigned)
    assert.equal(recovered.data.duplicate, true)
    assert.equal(recovered.data.encounterId, signed.data.encounterId)

    // Which the tablet treats as confirmed, so the attempt is released and the
    // next consultation is a new one rather than a refusal.
    const next = await as(doctor, 'sign_consultation', {
      patientId, idempotencyKey: randomUUID(),
      complaint: 'Cough', diagnosis: 'Bronchitis', notes: '', advice: 'Fluids',
    })
    assert.notEqual(next.data.encounterId, signed.data.encounterId)

    const { encounters, charged } = await effectsFor(patientId)
    assert.equal(encounters, 2, 'the signed one and the genuinely new one')
    assert.equal(charged, '600.00', 'and the refused edit charged nothing')
  })

  /**
   * Two direct consultations, both without a visit row, are two consultations.
   *
   * The clinic has no appointment to tell them apart, so the attempt does: the
   * tablet releases it on a confirmed signing and the second consultation is
   * opened under a new one (`tests/attempt-key.test.ts` holds that rule). What
   * the server has to do is not get in the way — two keys, two encounters, two
   * fees, because a patient genuinely seen twice is charged twice.
   */
  test('two direct consultations under two attempts are two consultations', async () => {
    const { doctor, patientId } = await consultingRoom()
    const sheet = {
      patientId, complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    }

    const morning = await as(doctor, 'sign_consultation', { ...sheet, idempotencyKey: randomUUID() })
    const evening = await as(doctor, 'sign_consultation', { ...sheet, idempotencyKey: randomUUID() })

    assert.notEqual(evening.data.encounterId, morning.data.encounterId)
    assert.equal(evening.data.duplicate, undefined, 'the second is a signing, not a replay')
    const { encounters, charged } = await effectsFor(patientId)
    assert.equal(encounters, 2)
    assert.equal(charged, '600.00')
  })

  test('an encounter signed without a key is still recorded, and carries one of its own', async () => {
    const { doctor, patientId } = await consultingRoom()
    await as(doctor, 'sign_consultation', {
      patientId, complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })

    const [row] = await rows(
      'select idempotency_key, request_fingerprint from jmc.encounters where patient_id=$1', [patientId])
    assert.match(String(row.idempotency_key), /^consultation:/,
      'a caller that sends nothing still gets a reference the encounter can be found by')
    assert.equal(String(row.request_fingerprint).length, 64, 'and the fingerprint beside it')
  })

  test('every key in the clinic is unique, at the table', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()
    await as(doctor, 'sign_consultation', {
      patientId, idempotencyKey, complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })
    const encounterId = String(await scalar('select id from jmc.encounters where patient_id=$1', [patientId]))

    // Straight at the table, past every line of application code, because that
    // is the layer the concurrent case actually relies on.
    await assert.rejects(
      () => rows(
        `insert into jmc.encounters
           (id,patient_id,doctor_id,diagnosis,notes,advice,created_at,idempotency_key,request_fingerprint)
         values ($1,$2,$3,'x','','',now()::text,$4,'f')`,
        [randomUUID(), patientId, doctor.id, idempotencyKey]),
      /duplicate key value violates unique constraint/,
    )
    assert.ok(encounterId, 'and the original is untouched')
  })

  test('a key may not be stored without the fingerprint that makes it safe', async () => {
    const { doctor, patientId } = await consultingRoom()
    await assert.rejects(
      () => rows(
        `insert into jmc.encounters
           (id,patient_id,doctor_id,diagnosis,notes,advice,created_at,idempotency_key)
         values ($1,$2,$3,'x','','',now()::text,$4)`,
        [randomUUID(), patientId, doctor.id, randomUUID()]),
      /encounters_key_carries_fingerprint/,
      'a key with nothing to compare against cannot refuse a mismatch',
    )
  })
})

/**
 * The codes, over the wire this time.
 *
 * Everything above calls the command function in process, which reads the
 * thrown `CommandRefusal` and its `code` directly. That proves the command
 * raises the right refusal and proves nothing about what a tablet receives —
 * and what a tablet receives is the contract. `command/index.ts` has to put the
 * code on the JSON body beside the message, only for a `CommandRefusal`, and
 * without disturbing the sixty-odd callers that read `message` and nothing
 * else.
 *
 * This matters because the client ACTS on one of these codes: a refusal that
 * says the reference belongs to another consultation releases the attempt so
 * the next press is a fresh one (`lib/consultation-attempt.ts`). A code that
 * never arrived would make that rotation dead code and the server's promise —
 * "the tablet will use a fresh reference" — a lie.
 */
describe('what a tablet actually receives', () => {
  const sign = async (doctor, payload) => edgeRequest('command', '', {
    method: 'POST',
    token: await tokenFor(doctor),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'sign_consultation', payload }),
  })

  test('a stale reference arrives with the code the tablet rotates on', async () => {
    const { doctor, patientId } = await consultingRoom()
    await as(doctor, 'create_patient', { name: 'Other Person', age: 30, sex: 'female', phone: '+9990000009' })
    const otherId = String(await scalar('select id from jmc.patients where name=$1', ['Other Person']))
    const idempotencyKey = randomUUID()
    const sheet = { complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest' }

    const first = await sign(doctor, { ...sheet, patientId, idempotencyKey })
    assert.equal(first.status, 200)
    assert.equal(first.body.ok, true)

    const stale = await sign(doctor, { ...sheet, patientId: otherId, idempotencyKey })
    assert.equal(stale.status, 400)
    assert.equal(stale.body.ok, false)
    assert.equal(stale.body.code, 'ATTEMPT_NAMES_ANOTHER_CONSULTATION')
    assert.match(stale.body.message, /fresh reference/,
      'and the words the doctor reads match what the tablet is about to do')
  })

  test('a signed visit arrives with the code the tablet must NOT rotate on', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()
    const sheet = { patientId, idempotencyKey, complaint: 'Fever', notes: '', advice: 'Rest' }

    await sign(doctor, { ...sheet, diagnosis: 'Viral fever' })
    const edited = await sign(doctor, { ...sheet, diagnosis: 'Dengue' })

    assert.equal(edited.status, 400)
    assert.equal(edited.body.code, 'CONSULTATION_ALREADY_SIGNED')
    assert.match(edited.body.message, /cannot be edited/)
  })

  test('an ordinary refusal carries no code at all, and is still a sentence', async () => {
    const { doctor, patientId } = await consultingRoom()
    const refused = await sign(doctor, { patientId, complaint: 'Fever', notes: '', advice: '' })

    assert.equal(refused.status, 400)
    assert.equal(refused.body.ok, false)
    assert.equal(refused.body.code, undefined,
      'a code is for the few refusals the software must act on, not decoration on all of them')
    assert.match(refused.body.message, /diagnosis/)
  })

  test('a replay arrives as a success, not as a refusal', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()
    const sheet = {
      patientId, idempotencyKey,
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    }

    const first = await sign(doctor, sheet)
    const retry = await sign(doctor, sheet)

    assert.equal(retry.status, 200)
    assert.equal(retry.body.ok, true)
    assert.equal(retry.body.data.duplicate, true)
    assert.equal(retry.body.data.encounterId, first.body.data.encounterId)
  })
})
