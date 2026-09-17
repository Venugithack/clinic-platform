/**
 * Which visit a consultation belongs to, through every way the two can part.
 *
 * ── WHY THERE ARE TWO VISIT IDENTITIES AND NOT ONE ─────────────────────────
 *
 * A signing attempt carries two different facts about "which visit", and three
 * acceptance reviews were spent discovering that neither can be dropped.
 *
 * `openedVisitId` is what the attempt BEGAN against. It never changes. Without
 * it, a consultation opened on a visit — first request lost, visit then
 * cancelled — retried with nothing to send, and the clinic wrote a DIRECT
 * consultation: the cancellation bypassed, the encounter attached to nothing,
 * ₹300 charged for an attendance somebody had said did not happen.
 *
 * `appointmentId` is what the tablet has on screen NOW. Without it, a visit
 * created mid-attempt — which policy item 3 explicitly lets a doctor do — was
 * never attached to anything, and the patient sat in the queue as `waiting`
 * while their consultation was already signed.
 *
 * Both faults were reproduced against staging before either was fixed. This
 * file is the matrix that keeps them fixed, and every branch asserts the whole
 * side-effect set rather than the one field the branch is named after: a
 * consultation that links correctly and charges twice is not a pass.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, test } from 'node:test'
import { edgeGet } from '../support/backend.mjs'
import { as, closeClinic, makeStaff, resetClinic, rows, scalar, tokenFor } from '../support/clinic.mjs'

after(async () => { await closeClinic() })

const SHEET = { complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest' }

/** A doctor and a patient. The visit, if any, is the test's own business. */
async function consultingRoom(name = 'Walk In') {
  await resetClinic()
  const doctor = await makeStaff({ name: 'Doctor', roles: ['doctor'], username: 'doc', pin: '5731' })
  await as(doctor, 'create_patient', { name, age: 40, sex: 'male', phone: '+9990000001' })
  const patientId = String(await scalar('select id from jmc.patients where name=$1', [name]))
  return { doctor, patientId }
}

/** One arrival, returned by id. */
async function arrive(doctor, patientId, reason = 'Fever') {
  await as(doctor, 'create_appointment', {
    patientId, reason, scheduledAt: new Date().toISOString(),
  })
  return String(await scalar(
    `select id from jmc.appointments where patient_id=$1 and status='waiting'
      order by created_at desc limit 1`, [patientId]))
}

const sign = (doctor, payload) => as(doctor, 'sign_consultation', { ...SHEET, ...payload })

/**
 * Everything a signing touches, for one patient.
 *
 * The brief for this correction names each of these, and they are gathered in
 * one object so a branch asserts the whole shape at once. A test that checks
 * the encounter and forgets the fee is how the fee got charged twice.
 */
async function effectsFor(patientId) {
  const count = async (text) => Number(await scalar(text, [patientId]))
  return {
    encounters: await count('select count(*)::int from jmc.encounters where patient_id=$1'),
    linkedTo: (await rows(
      'select appointment_id from jmc.encounters where patient_id=$1', [patientId]))
      .map((row) => row.appointment_id),
    visits: (await rows(
      'select status from jmc.appointments where patient_id=$1 order by created_at', [patientId]))
      .map((row) => row.status),
    prescriptions: await count('select count(*)::int from jmc.prescriptions where patient_id=$1'),
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

/**
 * What reference each of this patient's consultations was written under.
 *
 * Separate from `effectsFor` because it is asserted against a value the test
 * holds rather than against a count — and because it is the half that says a
 * replay really was a replay. An encounter carrying a key the caller never
 * sent is a signing wearing a retry's clothes.
 */
async function keysFor(patientId) {
  return (await rows(
    `select idempotency_key, request_fingerprint from jmc.encounters
      where patient_id=$1 order by created_at`, [patientId]))
    .map((row) => ({
      key: row.idempotency_key,
      // The fingerprint's value is not the test's business; that it EXISTS is,
      // because the check constraint says a key never travels without one and
      // a null here would mean the pair had come apart.
      fingerprinted: typeof row.request_fingerprint === 'string'
        && row.request_fingerprint.length === 64,
    }))
}

describe('an attempt opened against a visit', () => {
  test('(a) the visit is still active: the retry signs against it and closes it', async () => {
    const { doctor, patientId } = await consultingRoom()
    const visit = await arrive(doctor, patientId)
    const idempotencyKey = randomUUID()

    // The first press never reached the clinic. The retry carries both
    // identities, and here they are the same visit.
    await sign(doctor, { patientId, idempotencyKey, appointmentId: visit, openedVisitId: visit })

    assert.deepEqual(await effectsFor(patientId), {
      encounters: 1, linkedTo: [visit], visits: ['done'],
      prescriptions: 0, followUps: 0, invoices: 1, feeLines: 1,
      charged: '300.00', completions: 1,
    }, 'attached to the visit, the visit closed, charged once')
    assert.deepEqual(await keysFor(patientId), [{ key: idempotencyKey, fingerprinted: true }],
      'and filed under the reference the tablet sent, which is what makes the retry findable')
  })

  /**
   * The bypass this correction exists for.
   *
   * The attempt began on a visit, nothing committed, and the visit was then
   * cancelled — so the poll takes it out of the snapshot and the tablet has no
   * live visit to send. Sending only the live value, the clinic saw a request
   * naming no visit at all and wrote a direct consultation: the cancellation
   * stepped around, the encounter attached to nothing, ₹300 charged.
   */
  test('(b) the visit was cancelled: nothing is signed, nothing is charged', async () => {
    const { doctor, patientId } = await consultingRoom()
    const visit = await arrive(doctor, patientId)
    const idempotencyKey = randomUUID()
    await as(doctor, 'set_appointment_status', { appointmentId: visit, status: 'cancelled' })

    await assert.rejects(
      () => sign(doctor, { patientId, idempotencyKey, openedVisitId: visit }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_VISIT_NO_LONGER_ACTIVE')
        assert.match(String(error.message), /cancelled/)
        assert.match(String(error.message), /nothing was charged/i)
        return true
      },
    )

    assert.deepEqual(await effectsFor(patientId), {
      encounters: 0, linkedTo: [], visits: ['cancelled'],
      prescriptions: 0, followUps: 0, invoices: 0, feeLines: 0,
      charged: '0', completions: 0,
    }, 'a cancelled visit is not a licence to write a consultation with no visit')
  })

  test('(b2) the visit was closed by somebody else: the same refusal', async () => {
    const { doctor, patientId } = await consultingRoom()
    const visit = await arrive(doctor, patientId)
    const idempotencyKey = randomUUID()
    await as(doctor, 'set_appointment_status', { appointmentId: visit, status: 'done' })

    await assert.rejects(
      () => sign(doctor, { patientId, idempotencyKey, openedVisitId: visit }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_VISIT_NO_LONGER_ACTIVE')
        assert.match(String(error.message), /closed/)
        return true
      },
    )
    const after = await effectsFor(patientId)
    assert.equal(after.encounters, 0)
    assert.equal(after.charged, '0')
  })

  test('(b3) and the way forward is a new visit, which signs normally', async () => {
    const { doctor, patientId } = await consultingRoom()
    const first = await arrive(doctor, patientId)
    await as(doctor, 'set_appointment_status', { appointmentId: first, status: 'cancelled' })
    await assert.rejects(
      () => sign(doctor, { patientId, idempotencyKey: randomUUID(), openedVisitId: first }),
      (error) => error.code === 'ATTEMPT_VISIT_NO_LONGER_ACTIVE',
    )

    // A cancelled visit and a patient still in front of the doctor is an
    // arrival. The tablet mints a fresh attempt against it through the
    // ordinary rule, and that signs.
    const second = await arrive(doctor, patientId)
    await sign(doctor, {
      patientId, idempotencyKey: randomUUID(), appointmentId: second, openedVisitId: second,
    })

    assert.deepEqual(await effectsFor(patientId), {
      encounters: 1, linkedTo: [second], visits: ['cancelled', 'done'],
      prescriptions: 0, followUps: 0, invoices: 1, feeLines: 1,
      charged: '300.00', completions: 1,
    }, 'one consultation, against the visit that was not cancelled')
    const [only] = await keysFor(patientId)
    assert.ok(only.fingerprinted, 'the key and its fingerprint travel together, as the check requires')
  })

  test('(c) the first request committed and the visit left the snapshot: replay', async () => {
    const { doctor, patientId } = await consultingRoom()
    const visit = await arrive(doctor, patientId)
    const idempotencyKey = randomUUID()

    const first = await sign(doctor, {
      patientId, idempotencyKey, appointmentId: visit, openedVisitId: visit,
    })
    // Signing closed the visit and the poll removed it, so only the attempt's
    // own identity is left to send.
    const retry = await sign(doctor, { patientId, idempotencyKey, openedVisitId: visit })

    assert.equal(retry.data.duplicate, true)
    assert.equal(retry.data.encounterId, first.data.encounterId)
    assert.equal(retry.data.signedAt, first.data.signedAt, 'the original signing time')
    assert.deepEqual(await effectsFor(patientId), {
      encounters: 1, linkedTo: [visit], visits: ['done'],
      prescriptions: 0, followUps: 0, invoices: 1, feeLines: 1,
      charged: '300.00', completions: 1,
    })
    assert.deepEqual(await keysFor(patientId), [{ key: idempotencyKey, fingerprinted: true }],
      'one encounter under one reference — the retry found it rather than spending it again')
  })

  /*
   * Slice 2 changed the code this raises, and owner item 74 is why.
   *
   * It used to be `ATTEMPT_NAMES_ANOTHER_CONSULTATION`, which the tablet
   * ROTATES on — a fresh reference, and the next press signs. That is right
   * when the key names a different PATIENT or DOCTOR, and it is not right
   * here, because two real visits for one patient is precisely what "the
   * patient never left and reception arrived them again" looks like. Owner
   * item 74: "Reception creating B is not, by itself, proof of a second
   * consultation." So it fails closed instead, and the way out is a doctor
   * saying which it was.
   */
  test('(f) a genuinely different live visit needs a doctor to say which it is', async () => {
    const { doctor, patientId } = await consultingRoom()
    const first = await arrive(doctor, patientId)
    const idempotencyKey = randomUUID()
    await sign(doctor, {
      patientId, idempotencyKey, appointmentId: first, openedVisitId: first,
    })
    const second = await arrive(doctor, patientId, 'Came back')

    await assert.rejects(
      () => sign(doctor, {
        patientId, idempotencyKey, appointmentId: second, openedVisitId: first,
      }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_NEEDS_RECONCILIATION',
          'a fresh reference here would write a second encounter and a second fee for what may be one attendance')
        return true
      },
    )

    const after = await effectsFor(patientId)
    assert.equal(after.encounters, 1, 'the refusal wrote nothing')
    assert.equal(after.charged, '300.00')
    assert.deepEqual(after.visits, ['done', 'waiting'], 'and the second arrival is untouched')
  })
})

describe('an attempt opened without a visit', () => {
  test('(d) nothing committed and a visit appears: the same key signs against it', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()

    // The first press never reached the clinic; the doctor then creates the
    // visit and presses again. `openedVisitId` is absent because there was
    // nothing to open against.
    const visit = await arrive(doctor, patientId)
    const signed = await sign(doctor, { patientId, idempotencyKey, appointmentId: visit })

    assert.equal(signed.data.duplicate, undefined, 'nothing had committed, so this is a signing')
    assert.deepEqual(await effectsFor(patientId), {
      encounters: 1, linkedTo: [visit], visits: ['done'],
      prescriptions: 0, followUps: 0, invoices: 1, feeLines: 1,
      charged: '300.00', completions: 1,
    }, 'attached to the visit that appeared, and the patient leaves the queue')
  })

  test('(e) it DID commit and a visit appears: refused, and nothing happens twice', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()

    const first = await sign(doctor, { patientId, idempotencyKey })
    const visit = await arrive(doctor, patientId)

    await assert.rejects(
      () => sign(doctor, { patientId, idempotencyKey, appointmentId: visit }),
      (error) => {
        assert.equal(error.code, 'CONSULTATION_SIGNED_WITHOUT_THIS_VISIT',
          'and NOT the code the tablet rotates on — a fresh reference signs it twice')
        assert.match(String(error.message), /still waiting/)
        return true
      },
    )

    assert.deepEqual(await effectsFor(patientId), {
      encounters: 1, linkedTo: [null], visits: ['waiting'],
      prescriptions: 0, followUps: 0, invoices: 1, feeLines: 1,
      charged: '300.00', completions: 1,
    }, 'one of everything, and the visit is left for a person to close')
    assert.equal(
      String(await scalar('select id from jmc.encounters where patient_id=$1', [patientId])),
      first.data.encounterId)
  })

  /*
   * The recovery that was documented for this state, and does not exist.
   *
   * The contract said the way out of a non-rotating refusal is to re-send the
   * sheet exactly as it was signed, because an identical sheet replays and a
   * replay releases the attempt. That is true of `CONSULTATION_ALREADY_SIGNED`
   * and it is FALSE here, and the reason is the order of the two checks:
   * `compareBinding` runs before the fingerprint is looked at, so a request
   * naming a live visit the encounter does not have is refused on the binding
   * and never reaches the comparison. The sheet could be byte-perfect; nobody
   * reads it.
   *
   * So the doctor in this state cannot type their way out at all. What ends it
   * is a clinic act on the VISIT, which is the second half of this test.
   */
  test('(e3) restoring the sheet does NOT release it while the visit is on screen', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()
    const first = await sign(doctor, { patientId, idempotencyKey })
    const visit = await arrive(doctor, patientId)

    // Byte-for-byte what was signed, plus the visit the tablet now has.
    await assert.rejects(
      () => sign(doctor, { patientId, idempotencyKey, appointmentId: visit }),
      (error) => error.code === 'CONSULTATION_SIGNED_WITHOUT_THIS_VISIT',
      'an identical sheet is not enough, because the binding is judged first',
    )

    // Closing the queue row is what ends it: with no live visit the attempt's
    // own identity answers, the fingerprint is finally compared, and the
    // original consultation comes back.
    await as(doctor, 'set_appointment_status', { appointmentId: visit, status: 'done' })
    const released = await sign(doctor, { patientId, idempotencyKey })

    assert.equal(released.data.duplicate, true)
    assert.equal(released.data.encounterId, first.data.encounterId)
    assert.deepEqual(await effectsFor(patientId), {
      encounters: 1, linkedTo: [null], visits: ['done'],
      prescriptions: 0, followUps: 0, invoices: 1, feeLines: 1,
      charged: '300.00', completions: 1,
    }, 'and closing the visit by hand charged nobody anything')
  })

  test('(e2) and the leftover visit is carried as an obligation', async () => {
    const { doctor, patientId } = await consultingRoom()
    const idempotencyKey = randomUUID()
    await sign(doctor, { patientId, idempotencyKey })
    await arrive(doctor, patientId)

    const { body } = await edgeGet(
      'workspace', `?view=obligations&patientId=${patientId}`, await tokenFor(doctor))
    const unlinked = body.obligations.find((item) => item.kind === 'unlinked_consultation')
    assert.ok(unlinked, 'a refusal is read once; this is the same fact written down')
    assert.equal(unlinked.severity, 'blocked')
    assert.equal(unlinked.owner, 'doctor')
  })
})

/**
 * The field is additive, and that is what keeps the deployed build working.
 *
 * Every branch above sends `openedVisitId`. A caller that does not — the build
 * in somebody's browser cache — must behave exactly as it did before, which is
 * the whole reason the contract was extended rather than changed.
 */
describe('a caller that sends no openedVisitId', () => {
  test('still replays its own retry', async () => {
    const { doctor, patientId } = await consultingRoom()
    const visit = await arrive(doctor, patientId)
    const idempotencyKey = randomUUID()

    const first = await sign(doctor, { patientId, idempotencyKey, appointmentId: visit })
    const retry = await sign(doctor, { patientId, idempotencyKey })

    assert.equal(retry.data.duplicate, true)
    assert.equal(retry.data.encounterId, first.data.encounterId)
    const after = await effectsFor(patientId)
    assert.equal(after.encounters, 1)
    assert.equal(after.charged, '300.00')
  })

  test('and still signs a direct consultation when that is genuinely what it is', async () => {
    const { doctor, patientId } = await consultingRoom()
    await sign(doctor, { patientId, idempotencyKey: randomUUID() })

    const after = await effectsFor(patientId)
    assert.equal(after.encounters, 1)
    assert.deepEqual(after.linkedTo, [null], 'no visit was ever involved, and none is invented')
    assert.equal(after.charged, '300.00')
  })
})

/**
 * Two tablets, one key, one QUEUED patient.
 *
 * The existing concurrency proof used a patient with no visit at all, so
 * `requireActiveAppointment ... for update` never ran — and that row lock is
 * the first thing a queued signing touches, before the unique key gets a
 * chance to serialize anything. This is the common case in the clinic and it
 * was the untested one.
 */
describe('two simultaneous signings of one queued visit', () => {
  test('both callers are told the truth, and exactly one of everything exists', async () => {
    const { doctor, patientId } = await consultingRoom()
    const visit = await arrive(doctor, patientId)
    const idempotencyKey = randomUUID()
    const request = { patientId, idempotencyKey, appointmentId: visit, openedVisitId: visit }

    const both = await Promise.allSettled([sign(doctor, request), sign(doctor, request)])

    assert.deepEqual(
      both.map((outcome) => outcome.status), ['fulfilled', 'fulfilled'],
      `neither caller may be handed a constraint or a lock: ${
        JSON.stringify(both.map((outcome) => outcome.reason?.message))}`)

    const [a, b] = both.map((outcome) => outcome.value)
    assert.equal(a.data.encounterId, b.data.encounterId, 'both answered with the same consultation')
    assert.equal(a.data.signedAt, b.data.signedAt)
    assert.equal(
      [a.data.duplicate, b.data.duplicate].filter(Boolean).length, 1,
      'one of them signed it and the other found it already signed')

    /*
     * And neither was told the visit was gone.
     *
     * Three roads end in "both fulfilled, one duplicate" — the appointment
     * lock, the unique index, and a run that happened to serialize before
     * either mattered — so the counts alone cannot say which one this was.
     * What they CAN say is that the loser was not handed the sentence this
     * correction removed. That sentence is the defect, and asserting its
     * absence is the assertion that reverts.
     */
    for (const answer of [a, b]) {
      assert.doesNotMatch(String(answer.message), /already finished|does not belong/,
        'a caller holding its own consultation must never be told the visit is not theirs')
    }
    assert.deepEqual(await keysFor(patientId), [{ key: idempotencyKey, fingerprinted: true }],
      'and exactly one encounter carries the reference both of them sent')

    assert.deepEqual(await effectsFor(patientId), {
      encounters: 1, linkedTo: [visit], visits: ['done'],
      prescriptions: 0, followUps: 0, invoices: 1, feeLines: 1,
      charged: '300.00', completions: 1,
    }, 'exactly one appointment closed, exactly one complete side-effect set')
  })

  test('and the same holds with a prescription and a follow-up riding along', async () => {
    const { doctor, patientId } = await consultingRoom()
    const pharmacist = await makeStaff({
      name: 'Pharmacist', roles: ['pharmacy'], username: 'ph', pin: '5731',
    })
    await as(pharmacist, 'add_medicine', {
      code: 'PARA500', name: 'Paracetamol 500', unit: 'tablet', saleClass: 'otc',
      reorderLevel: '10', targetStock: '100', initialQuantity: '0',
    })
    const medicineId = String(await scalar(`select id from jmc.medicines where code='PARA500'`))
    const visit = await arrive(doctor, patientId)
    const idempotencyKey = randomUUID()
    const request = {
      patientId, idempotencyKey, appointmentId: visit, openedVisitId: visit,
      followUpDate: '2026-09-30', followUpNote: 'Review',
      prescriptionItems: [{
        medicineId, doseAmount: '1', doseUnit: 'tablet', frequency: 'twice_daily',
        timing: 'after_food', quantity: 10, instructions: '',
      }],
    }

    const both = await Promise.allSettled([sign(doctor, request), sign(doctor, request)])
    assert.deepEqual(both.map((outcome) => outcome.status), ['fulfilled', 'fulfilled'])
    const [a, b] = both.map((outcome) => outcome.value)
    assert.equal(a.data.prescriptionNumber, b.data.prescriptionNumber,
      'a second prescription number for one visit is a second prescription')

    assert.deepEqual(await effectsFor(patientId), {
      encounters: 1, linkedTo: [visit], visits: ['done'],
      prescriptions: 1, followUps: 1, invoices: 1, feeLines: 1,
      charged: '300.00', completions: 1,
    }, 'one order, one reminder, one bill, one audit row')
  })
})
