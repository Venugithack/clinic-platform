/**
 * The lost reply, the second queue row, and the doctor who has to say which.
 *
 * Owner policy items 72, 73 and 74, which are one policy read three ways.
 *
 * ── THE STORY EVERY TEST HERE IS A BRANCH OF ───────────────────────────────
 *
 * A doctor presses Finish. The consultation commits in Chennai and the reply
 * is lost on the way home. The tablet says "Outcome not confirmed", and within
 * a minute the clinic may also be holding a second queue row for the same
 * patient — because signing set the first one to `done`, the fifteen-second
 * poll dropped it, and reception, seeing the patient still standing there,
 * arrived them again.
 *
 * Nothing the software can read tells "one attendance recorded once" apart
 * from "two attendances one of which is unrecorded". Slice 1 made every ending
 * of that honest and none of them finishable. This is the other half: a doctor
 * looks at what is in front of them and says which it is, and that sentence is
 * what releases the reference.
 *
 * ── WHAT EVERY BRANCH ASSERTS ──────────────────────────────────────────────
 *
 * `effectsFor` gathers the whole side-effect set — encounters, what each is
 * linked to, the queue, prescriptions, follow-ups, invoices, fee lines, the
 * rupees actually charged, the resolutions recorded and the audit rows — and
 * each test compares all of it at once. A reconciliation that closes the right
 * visit and charges ₹300 again is not a pass, and a test that only checks the
 * field in its own name would not notice.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, test } from 'node:test'
import postgres from 'postgres'
import { edgeGet, edgeRequest } from '../support/backend.mjs'
import { as as rawAs, closeClinic, makeStaff, resetClinic, rows, scalar, tokenFor } from '../support/clinic.mjs'
import {
  ATTEMPT_LOCK_NAMESPACE, ATTEMPT_RESOLUTION_LOCK_NAMESPACE,
} from '../../supabase/functions/_shared/idempotency.ts'

after(async () => { await closeClinic() })

/**
 * Every appointment command now requires a reference of its own, so the
 * harness behaves like a client: one fresh reference per attempt, unless a
 * test is deliberately reusing one to exercise a retry.
 *
 * Wrapping `as` rather than threading a key through fifty call sites keeps the
 * tests about the clinic. A test that passes `idempotencyKey` explicitly is
 * saying something, and it is never silently overwritten.
 */
const KEYED = new Set([
  'create_appointment_type', 'update_appointment_type',
  'publish_availability', 'retire_availability',
  'book_appointment', 'reschedule_appointment', 'cancel_appointment',
  'mark_no_show', 'check_in_appointment', 'set_queue_priority',
])

const as = (staff, action, payload = {}) => rawAs(
  staff,
  action,
  KEYED.has(action) && !payload.idempotencyKey
    ? { ...payload, idempotencyKey: randomUUID() }
    : payload,
)


const SHEET = { complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest' }

async function consultingRoom(name = 'Walk In') {
  await resetClinic()
  const doctor = await makeStaff({ name: 'Doctor', roles: ['doctor'], username: 'doc', pin: '5731' })
  const nurse = await makeStaff({ name: 'Nurse', roles: ['nurse'], username: 'nur', pin: '5732' })
  const admin = await makeStaff({ name: 'Admin', roles: ['admin'], username: 'adm', pin: '5733' })
  const pharmacist = await makeStaff({ name: 'Pharmacist', roles: ['pharmacy'], username: 'pha', pin: '5734' })
  await as(doctor, 'create_patient', { name, age: 40, sex: 'male', phone: '+919990000001' })
  const patientId = String(await scalar('select id from jmc.patients where name=$1', [name]))
  return { doctor, nurse, admin, pharmacist, patientId }
}

/** Put the patient in the queue and hand back the visit. */
async function arrive(staff, patientId, reason = 'Fever') {
  await as(staff, 'create_appointment', { patientId, reason, scheduledAt: new Date().toISOString() })
  return String(await scalar(
    `select id from jmc.appointments where patient_id=$1 and status='waiting'
      order by created_at desc limit 1`, [patientId]))
}

const sign = (doctor, payload) => as(doctor, 'sign_consultation', { ...SHEET, ...payload })

/** Everything that could have changed, gathered in one object. */
async function effectsFor(patientId) {
  const [counts] = await rows(
    `select
       (select count(*)::int from jmc.encounters where patient_id=$1) as encounters,
       (select count(*)::int from jmc.prescriptions where patient_id=$1) as prescriptions,
       (select count(*)::int from jmc.follow_ups where patient_id=$1) as follow_ups,
       (select count(*)::int from jmc.invoices where patient_id=$1) as invoices,
       (select count(*)::int from jmc.invoice_lines l join jmc.invoices i on i.id=l.invoice_id
         where i.patient_id=$1 and l.source='consultation_fee') as fee_lines,
       (select coalesce(sum(l.amount),0)::text from jmc.invoice_lines l
          join jmc.invoices i on i.id=l.invoice_id
         where i.patient_id=$1 and l.source='consultation_fee') as charged,
       (select count(*)::int from jmc.consultation_attempt_resolutions where patient_id=$1) as resolutions,
       (select count(*)::int from jmc.audit_events
         where action='consultation_attempt.resolved') as resolution_audits,
       (select count(*)::int from jmc.audit_events
         where action='encounter.completed') as completions`,
    [patientId],
  )
  const linked = await rows(
    'select appointment_id from jmc.encounters where patient_id=$1 order by created_at, id', [patientId])
  const visits = await rows(
    'select status from jmc.appointments where patient_id=$1 order by created_at, id', [patientId])
  return {
    encounters: counts.encounters,
    linkedTo: linked.map((row) => row.appointment_id),
    visits: visits.map((row) => row.status),
    prescriptions: counts.prescriptions,
    followUps: counts.follow_ups,
    invoices: counts.invoices,
    feeLines: counts.fee_lines,
    charged: counts.charged,
    resolutions: counts.resolutions,
    resolutionAudits: counts.resolution_audits,
    completions: counts.completions,
  }
}

const resolve = (staff, payload) => as(staff, 'resolve_consultation_attempt', payload)

describe('A committed, B accidental: one attendance', () => {
  /*
   * The exact sequence the register calls "Two arrivals for one attendance".
   * It was the one hole Slice 1 could not close, because every way of closing
   * it was a clinic policy that had not been decided. Owner item 74 decided
   * it.
   */
  async function reQueuedAfterALostReply() {
    const context = await consultingRoom()
    const visitA = await arrive(context.nurse, context.patientId)
    const idempotencyKey = randomUUID()
    const first = await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey, appointmentId: visitA, openedVisitId: visitA,
    })
    // The reply was lost. Signing closed visit A, the poll dropped it, and
    // reception arrived the patient again.
    const visitB = await arrive(context.nurse, context.patientId)
    return { ...context, visitA, visitB, idempotencyKey, first }
  }

  test('pressing Finish again is refused, and does not rotate the reference', async () => {
    const { doctor, patientId, visitB, idempotencyKey, visitA } = await reQueuedAfterALostReply()

    await assert.rejects(
      () => sign(doctor, { patientId, idempotencyKey, appointmentId: visitB, openedVisitId: visitA }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_NEEDS_RECONCILIATION',
          'owner item 74: reception creating B is not proof of a second consultation')
        assert.match(String(error.message), /nothing was charged/i)
        return true
      },
    )

    const effects = await effectsFor(patientId)
    assert.equal(effects.encounters, 1)
    assert.equal(effects.charged, '300.00')
    assert.deepEqual(effects.visits, ['done', 'waiting'])
  })

  test('the doctor is offered both determinations, and told what was signed', async () => {
    const { doctor, patientId, idempotencyKey, first, visitB } = await reQueuedAfterALostReply()

    const { body } = await edgeGet(
      'workspace', `?view=reconciliation&key=${idempotencyKey}&patientId=${patientId}`,
      await tokenFor(doctor))

    assert.equal(body.reconciliation.priorOutcome, 'committed')
    assert.equal(body.reconciliation.consultation.encounterId, first.data.encounterId)
    assert.deepEqual(
      body.reconciliation.openVisits.map((visit) => visit.visitId), [visitB],
      'the only open visit is the second one, which is what the doctor is deciding about')
    assert.deepEqual(
      Object.fromEntries(body.reconciliation.options.map((o) => [o.resolution, o.available])),
      { same_attendance: true, new_attendance: true, abandoned_attempt: false })
    assert.equal(
      body.reconciliation.options.find((o) => o.resolution === 'same_attendance').refusalCode,
      undefined, 'an available option carries no refusal code')
    assert.equal(
      body.reconciliation.options.find((o) => o.resolution === 'abandoned_attempt').refusalCode,
      'ATTEMPT_ALREADY_COMMITTED',
      'a screen that offers a button the server will refuse teaches people to expect refusals')
  })

  test('same attendance closes the visit, charges nothing, and edits no signed record', async () => {
    const { doctor, patientId, visitA, visitB, idempotencyKey, first } = await reQueuedAfterALostReply()

    const result = await resolve(doctor, {
      patientId, idempotencyKey, resolution: 'same_attendance',
      subjectVisitId: visitB, openedVisitId: visitA,
      reason: 'Same patient, never left the room; reception arrived them twice',
    })

    assert.equal(result.data.priorOutcome, 'committed')
    assert.equal(result.data.attemptReleased, true)
    assert.equal(result.data.subjectVisitClosed, true)
    assert.equal(result.data.encounterId, first.data.encounterId)
    assert.match(result.message, /nothing was charged again/)

    assert.deepEqual(await effectsFor(patientId), {
      encounters: 1,
      linkedTo: [visitA],
      visits: ['done', 'done'],
      prescriptions: 0,
      followUps: 0,
      invoices: 1,
      feeLines: 1,
      charged: '300.00',
      resolutions: 1,
      resolutionAudits: 1,
      completions: 1,
    }, 'one consultation, one fee, both visits closed, and the encounter still points where it was signed')

    const [row] = await rows('select * from jmc.consultation_attempt_resolutions')
    assert.equal(row.resolution, 'same_attendance')
    assert.equal(row.prior_outcome, 'committed')
    assert.equal(row.encounter_id, first.data.encounterId)
    assert.equal(row.subject_visit_id, visitB)
    assert.equal(row.subject_visit_closed, true)
    assert.equal(row.resolved_by, doctor.id)

    const [event] = await rows(
      `select from_status, to_status, reason, actor_id from jmc.appointment_events
        where arrival_id=$1 and event='closed_on_reconciliation'`, [visitB])
    assert.deepEqual(
      { from: event.from_status, to: event.to_status, by: event.actor_id },
      { from: 'waiting', to: 'done', by: doctor.id },
      'the visit says why it stopped waiting rather than being a `done` with nobody’s name on it')
  })

  test('and a press that still names the closed visit says it was reconciled, not that it needs to be', async () => {
    /*
     * The loop the independent review found. Before this, `replayConsultation`
     * answered `another_visit` without looking at the resolution, so a doctor
     * who had just recorded their decision pressed Finish and read the
     * IDENTICAL refusal they had read before resolving — with nothing to say
     * their decision existed, and no way forward from the screen at all.
     */
    const { doctor, patientId, visitA, visitB, idempotencyKey } = await reQueuedAfterALostReply()
    await resolve(doctor, {
      patientId, idempotencyKey, resolution: 'same_attendance',
      subjectVisitId: visitB, openedVisitId: visitA, reason: 'One attendance',
    })

    await assert.rejects(
      () => sign(doctor, { patientId, idempotencyKey, appointmentId: visitB, openedVisitId: visitA }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_RECONCILED_AS_SAME_ATTENDANCE',
          'and this code does NOT rotate: a fresh reference would have no live visit left to name')
        assert.match(String(error.message), /Doctor/)
        assert.match(String(error.message), /nothing was charged/i)
        return true
      },
    )
    const effects = await effectsFor(patientId)
    assert.equal(effects.encounters, 1)
    assert.equal(effects.charged, '300.00')
  })

  test('and the reference is spent: a later press under it writes nothing', async () => {
    const { doctor, patientId, visitA, visitB, idempotencyKey } = await reQueuedAfterALostReply()
    await resolve(doctor, {
      patientId, idempotencyKey, resolution: 'same_attendance',
      subjectVisitId: visitB, openedVisitId: visitA, reason: 'One attendance',
    })

    // The tablet still holds the reference and the sheet is unchanged, so the
    // replay answers it — with the original consultation, not a new one.
    const replay = await sign(doctor, { patientId, idempotencyKey, openedVisitId: visitA })
    assert.equal(replay.data.duplicate, true)
    const effects = await effectsFor(patientId)
    assert.equal(effects.encounters, 1)
    assert.equal(effects.charged, '300.00')
  })
})

describe('A committed, B genuine: a second attendance', () => {
  test('new attendance settles the reference and leaves the visit to be consulted', async () => {
    const context = await consultingRoom()
    const visitA = await arrive(context.nurse, context.patientId)
    const idempotencyKey = randomUUID()
    await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey, appointmentId: visitA, openedVisitId: visitA,
    })
    const visitB = await arrive(context.nurse, context.patientId, 'Came back in the evening')

    const result = await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey, resolution: 'new_attendance',
      subjectVisitId: visitB, openedVisitId: visitA,
      reason: 'The patient went home and came back worse in the evening',
    })

    assert.equal(result.data.attemptReleased, true)
    assert.equal(result.data.subjectVisitClosed, false)
    assert.match(result.message, /still open/)

    assert.deepEqual(await effectsFor(context.patientId), {
      encounters: 1, linkedTo: [visitA], visits: ['done', 'waiting'],
      prescriptions: 0, followUps: 0, invoices: 1, feeLines: 1, charged: '300.00',
      resolutions: 1, resolutionAudits: 1, completions: 1,
    }, 'owner item 72: new attendance "keeps the visit available for a fresh consultation"')

    // And then the second consultation happens in the ordinary way, under a
    // reference of its own, and is charged because it is a second attendance.
    await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey: randomUUID(),
      appointmentId: visitB, openedVisitId: visitB, diagnosis: 'Worsening',
    })

    const after = await effectsFor(context.patientId)
    assert.equal(after.encounters, 2)
    assert.deepEqual(after.linkedTo, [visitA, visitB])
    assert.deepEqual(after.visits, ['done', 'done'])
    assert.equal(after.charged, '600.00', 'two attendances are charged twice, which is correct')
  })

  test('a press still holding the settled reference is told to use a fresh one', async () => {
    /*
     * The other half of the loop the review found, and the half that makes
     * the resolution actually release anything.
     *
     * Before this, a doctor who recorded New attendance and then pressed
     * Finish — which is what they would do next — got
     * `ATTEMPT_NEEDS_RECONCILIATION` again, the same refusal that sent them to
     * resolve in the first place. Now the server says the reference is closed
     * and the tablet rotates, which owner item 73 names as the one audited
     * release: "Only that audited resolution ... may release the attempt."
     */
    const context = await consultingRoom()
    const visitA = await arrive(context.nurse, context.patientId)
    const idempotencyKey = randomUUID()
    await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey, appointmentId: visitA, openedVisitId: visitA,
    })
    const visitB = await arrive(context.nurse, context.patientId, 'Came back')
    await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey, resolution: 'new_attendance',
      subjectVisitId: visitB, openedVisitId: visitA, reason: 'Came back in the evening',
    })

    await assert.rejects(
      () => sign(context.doctor, {
        patientId: context.patientId, idempotencyKey,
        appointmentId: visitB, openedVisitId: visitA,
      }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_SETTLED_BY_RECONCILIATION',
          'and this one DOES rotate, because a doctor recorded that it is closed')
        assert.match(String(error.message), /fresh reference/)
        return true
      },
    )
    const effects = await effectsFor(context.patientId)
    assert.equal(effects.encounters, 1, 'and the refusal wrote nothing')
    assert.equal(effects.charged, '300.00')
  })
})

describe('A never committed', () => {
  test('new attendance records the abandoned path and lets the visit be signed', async () => {
    const context = await consultingRoom()
    const visitB = await arrive(context.nurse, context.patientId)
    const idempotencyKey = randomUUID()

    const result = await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey, resolution: 'new_attendance',
      subjectVisitId: visitB,
      reason: 'The first press never reached the clinic; starting again',
    })

    assert.equal(result.data.priorOutcome, 'not_committed')
    assert.equal(result.data.encounterId, undefined)
    assert.deepEqual(await effectsFor(context.patientId), {
      encounters: 0, linkedTo: [], visits: ['waiting'],
      prescriptions: 0, followUps: 0, invoices: 0, feeLines: 0, charged: '0',
      resolutions: 1, resolutionAudits: 1, completions: 0,
    }, 'nothing clinical and nothing financial happens during a reconciliation')

    await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey: randomUUID(),
      appointmentId: visitB, openedVisitId: visitB,
    })
    const after = await effectsFor(context.patientId)
    assert.equal(after.encounters, 1)
    assert.equal(after.charged, '300.00')
  })

  test('same attendance is refused, because there is nothing to be the same attendance as', async () => {
    const context = await consultingRoom()
    const visitB = await arrive(context.nurse, context.patientId)

    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey: randomUUID(),
        resolution: 'same_attendance', subjectVisitId: visitB, reason: 'One attendance',
      }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_NOT_COMMITTED')
        assert.match(String(error.message), /sign it/)
        return true
      },
    )
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.consultation_attempt_resolutions')), 0)
  })

  test('a stale tablet cannot sign under a reference a doctor has closed', async () => {
    /*
     * Owner item 73's release has to STICK. A tablet in somebody's pocket for
     * an hour, still holding the settled reference, must not be able to write
     * the consultation the doctor has already decided did not happen.
     */
    const context = await consultingRoom()
    const visitB = await arrive(context.nurse, context.patientId)
    const idempotencyKey = randomUUID()
    await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey, resolution: 'new_attendance',
      subjectVisitId: visitB, reason: 'Starting again',
    })

    await assert.rejects(
      () => sign(context.doctor, {
        patientId: context.patientId, idempotencyKey, appointmentId: visitB, openedVisitId: visitB,
      }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_SETTLED_BY_RECONCILIATION')
        assert.match(String(error.message), /Doctor/)
        assert.match(String(error.message), /fresh reference/)
        return true
      },
    )
    const effects = await effectsFor(context.patientId)
    assert.equal(effects.encounters, 0)
    assert.equal(effects.charged, '0')
  })
})

describe('an attempt whose visit went away', () => {
  test('abandoning it needs the visit to be inactive, and closes nothing else', async () => {
    const context = await consultingRoom()
    const visitA = await arrive(context.nurse, context.patientId)
    const idempotencyKey = randomUUID()

    // Still open: this is not an abandoned attempt, it is one waiting to be signed.
    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey, resolution: 'abandoned_attempt',
        openedVisitId: visitA, reason: 'Giving up',
      }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_VISIT_STILL_ACTIVE')
        return true
      },
    )

    // And naming no visit at all is refused rather than skipping the check,
    // because owner item 73 defines this determination BY the opened visit.
    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey: randomUUID(),
        resolution: 'abandoned_attempt', reason: 'Giving up',
      }),
      /Say which visit this consultation was started against/,
    )

    await as(context.nurse, 'set_appointment_status', { appointmentId: visitA, status: 'cancelled' })

    const result = await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey, resolution: 'abandoned_attempt',
      openedVisitId: visitA, reason: 'The visit was cancelled under the attempt',
    })
    assert.equal(result.data.attemptReleased, true)
    assert.equal(result.data.priorOutcome, 'not_committed')

    assert.deepEqual(await effectsFor(context.patientId), {
      encounters: 0, linkedTo: [], visits: ['cancelled'],
      prescriptions: 0, followUps: 0, invoices: 0, feeLines: 0, charged: '0',
      resolutions: 1, resolutionAudits: 1, completions: 0,
    })
  })

  test('an attempt that DID commit cannot be abandoned', async () => {
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })

    const visit = await arrive(context.nurse, context.patientId)
    await as(context.nurse, 'set_appointment_status', { appointmentId: visit, status: 'cancelled' })
    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey, openedVisitId: visit,
        resolution: 'abandoned_attempt', reason: 'Never mind',
      }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_ALREADY_COMMITTED')
        return true
      },
    )
  })

  test('abandoning does not close a visit, and says so rather than ignoring the field', async () => {
    const context = await consultingRoom()
    const visitB = await arrive(context.nurse, context.patientId)
    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey: randomUUID(),
        resolution: 'abandoned_attempt', subjectVisitId: visitB,
        openedVisitId: visitB, reason: 'Giving up',
      }),
      /closes nothing/,
    )
  })
})

describe('the leftover visit from a consultation signed before it existed', () => {
  /*
   * The other half of owner item 72. A walk-in opened from the register, no
   * visit row, the signing commits and the reply is lost — and then somebody
   * creates today's visit, which policy item 3 allows and which is the tidy
   * thing to do. Slice 1 refused the second signing and carried the leftover
   * visit as an obligation with nobody able to close it.
   */
  test('the refusal, the obligation, and then the resolution that closes both', async () => {
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    const first = await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    const visit = await arrive(context.nurse, context.patientId)

    await assert.rejects(
      () => sign(context.doctor, {
        patientId: context.patientId, idempotencyKey, appointmentId: visit,
      }),
      (error) => {
        assert.equal(error.code, 'CONSULTATION_SIGNED_WITHOUT_THIS_VISIT')
        return true
      },
    )

    const obligations = await edgeGet(
      'workspace', `?view=obligations&patientId=${context.patientId}`, await tokenFor(context.doctor))
    assert.ok(obligations.body.obligations.some((item) => item.kind === 'unlinked_consultation'))

    await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey, resolution: 'same_attendance',
      subjectVisitId: visit, reason: 'One attendance; the visit row was created afterwards',
    })

    assert.deepEqual(await effectsFor(context.patientId), {
      encounters: 1, linkedTo: [null], visits: ['done'],
      prescriptions: 0, followUps: 0, invoices: 1, feeLines: 1, charged: '300.00',
      resolutions: 1, resolutionAudits: 1, completions: 1,
    }, 'the encounter is still attached to nothing, because editing a signed record is what item 72 forbids')

    const after = await edgeGet(
      'workspace', `?view=obligations&patientId=${context.patientId}`, await tokenFor(context.doctor))
    assert.equal(
      after.body.obligations.some((item) => item.kind === 'unlinked_consultation'), false,
      'and the obligation goes, because the queue row it named is closed')
    assert.equal(first.data.encounterId, String(await scalar('select id from jmc.encounters')))
  })
})

describe('the outcome that cannot be established', () => {
  test('a resolution is refused while a signing holds the same reference', async () => {
    /*
     * Owner item 73: "If the outcome cannot be established, fail closed."
     *
     * The lock is taken here on the test's own connection, which is what a
     * signing in flight looks like from the command's side. Without the try-
     * lock the resolution would read "no encounter carries this key", conclude
     * nothing committed, release the reference — and the signing would commit
     * a moment later, leaving the next press free to write a second fee.
     */
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()

    await rows('select pg_advisory_lock($1, hashtext($2))', [ATTEMPT_LOCK_NAMESPACE, idempotencyKey])
    try {
      await assert.rejects(
        () => resolve(context.doctor, {
          patientId: context.patientId, idempotencyKey,
          resolution: 'new_attendance', reason: 'Starting again',
        }),
        (error) => {
          assert.equal(error.code, 'ATTEMPT_OUTCOME_NOT_ESTABLISHED')
          assert.match(String(error.message), /Nothing was changed/)
          return true
        },
      )
      assert.equal(Number(await scalar(
        'select count(*)::int from jmc.consultation_attempt_resolutions')), 0)

      // And the read says so too, rather than reporting a confident
      // `not_committed` that is about to stop being true.
      const { body } = await edgeGet(
        'workspace', `?view=reconciliation&key=${idempotencyKey}&patientId=${context.patientId}`,
        await tokenFor(context.doctor))
      assert.equal(body.reconciliation.priorOutcome, 'unknown')
      assert.deepEqual(
        body.reconciliation.options.map((option) => option.refusalCode),
        ['ATTEMPT_OUTCOME_NOT_ESTABLISHED', 'ATTEMPT_OUTCOME_NOT_ESTABLISHED',
         'ATTEMPT_OUTCOME_NOT_ESTABLISHED'])
    } finally {
      await rows('select pg_advisory_unlock($1, hashtext($2))', [ATTEMPT_LOCK_NAMESPACE, idempotencyKey])
    }
  })

  test('the reconciliation read takes no lock at all', async () => {
    /*
     * It used to take `pg_try_advisory_lock` and release it in the same
     * statement, and this test held the release: the lock is SESSION-scoped,
     * so a read that did not release it held the reference hostage for as long
     * as the pooled connection lived, and the next signing under it would wait
     * for ever.
     *
     * It now observes `pg_locks` instead of acquiring anything, because being
     * careful about releasing the lock was not the same as being careful about
     * HOLDING it: for the microseconds the read owned it, a concurrent
     * resolution's `pg_try_advisory_xact_lock` lost its try and refused the
     * doctor with "this consultation is being signed right now" — a false
     * sentence about the clinic, produced by a read. The independent review
     * found it.
     *
     * That correction is proved by construction rather than here: a race of
     * microseconds is not something this suite can arrange deterministically,
     * and a test that only sometimes fails is worse than none. What this holds
     * is what is observable — no lock, in either namespace, after any number
     * of reads, and the reference still free for the work that comes next.
     *
     * Asserted against `pg_locks` rather than by signing afterwards and
     * finding it works. Advisory locks are re-entrant within one session, and
     * the workspace read and the command share a pool of two connections: a
     * leaked lock would be invisible to a signing that happened to land on the
     * same connection, and the test would pass while the fault was there.
     */
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    await edgeGet(
      'workspace', `?view=reconciliation&key=${idempotencyKey}&patientId=${context.patientId}`,
      await tokenFor(context.doctor))

    const held = await rows(
      `select count(*)::int as n from pg_locks
        where locktype = 'advisory' and classid = any($1)`,
      [[ATTEMPT_LOCK_NAMESPACE, ATTEMPT_RESOLUTION_LOCK_NAMESPACE]])
    assert.equal(held[0].n, 0, 'the read must not leave an advisory lock behind')

    // Read a second and third time, because the pool has two connections and
    // the fault this guards against is the release landing on the wrong one.
    // A single read can take and leak a lock and still look clean if the next
    // query happens to reuse the connection.
    for (let n = 0; n < 4; n += 1) {
      await edgeGet(
        'workspace', `?view=reconciliation&key=${idempotencyKey}&patientId=${context.patientId}`,
        await tokenFor(context.doctor))
    }
    const stillHeld = await rows(
      `select count(*)::int as n from pg_locks
        where locktype = 'advisory' and classid = any($1)`,
      [[ATTEMPT_LOCK_NAMESPACE, ATTEMPT_RESOLUTION_LOCK_NAMESPACE]])
    assert.equal(stillHeld[0].n, 0, 'and not after five of them either')

    const signed = await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    assert.ok(signed.data.encounterId)

    // And a determination immediately after a read is not told that somebody
    // is signing right now, which is what the read used to be able to cause.
    const settled = await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey,
      resolution: 'same_attendance', reason: 'The consultation stands',
    })
    assert.equal(settled.data.attemptReleased, true)
  })
})

describe('the read never offers a button the server would refuse', () => {
  /*
   * The promise `readReconciliation` makes in its own doc comment, and it was
   * broken for `abandoned_attempt`: nothing had committed, so the option came
   * back available with the detail "the visit it was started against is no
   * longer open" — which the read had no way of knowing, because it was never
   * given the visit. The write then refused with `ATTEMPT_VISIT_STILL_ACTIVE`.
   * Found by the independent review.
   */
  test('an abandoned attempt is not offered while its opened visit is still in the queue', async () => {
    const context = await consultingRoom()
    const visitA = await arrive(context.nurse, context.patientId)
    const idempotencyKey = randomUUID()
    const token = await tokenFor(context.doctor)
    const ask = (extra = '') => edgeGet(
      'workspace',
      `?view=reconciliation&key=${idempotencyKey}&patientId=${context.patientId}${extra}`,
      token)

    const named = await ask(`&openedVisitId=${visitA}`)
    const offered = named.body.reconciliation.options.find((o) => o.resolution === 'abandoned_attempt')
    assert.equal(offered.available, false)
    assert.equal(offered.refusalCode, 'ATTEMPT_VISIT_STILL_ACTIVE')
    // And the server agrees, which is the point of the promise.
    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey, openedVisitId: visitA,
        resolution: 'abandoned_attempt', reason: 'Giving up',
      }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_VISIT_STILL_ACTIVE')
        return true
      },
    )

    // Not named at all: the read says what it needs rather than guessing.
    const unnamed = await ask()
    const withheld = unnamed.body.reconciliation.options.find((o) => o.resolution === 'abandoned_attempt')
    assert.equal(withheld.available, false)
    assert.match(withheld.detail, /Name the visit/)

    // Cancelled, and now it is genuinely available.
    await as(context.nurse, 'set_appointment_status', { appointmentId: visitA, status: 'cancelled' })
    const after = await ask(`&openedVisitId=${visitA}`)
    assert.equal(
      after.body.reconciliation.options.find((o) => o.resolution === 'abandoned_attempt').available,
      true)
  })
})

describe('resolving the same reference twice', () => {
  test('a repeat is answered with what was recorded, and records nothing more', async () => {
    const context = await consultingRoom()
    const visitB = await arrive(context.nurse, context.patientId)
    const request = {
      patientId: context.patientId, idempotencyKey: randomUUID(),
      resolution: 'new_attendance', subjectVisitId: visitB, reason: 'Starting again',
    }

    const first = await resolve(context.doctor, request)
    const second = await resolve(context.doctor, request)

    assert.equal(second.data.resolutionId, first.data.resolutionId)
    assert.equal(second.data.duplicate, true)
    assert.match(second.message, /Nothing was recorded twice/)
    const effects = await effectsFor(context.patientId)
    assert.equal(effects.resolutions, 1)
    assert.equal(effects.resolutionAudits, 1)
  })

  test('a different determination under the same reference is refused, not agreed with', async () => {
    const context = await consultingRoom()
    const visitA = await arrive(context.nurse, context.patientId)
    const idempotencyKey = randomUUID()
    await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey, appointmentId: visitA, openedVisitId: visitA,
    })
    const visitB = await arrive(context.nurse, context.patientId)

    await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey, resolution: 'same_attendance',
      subjectVisitId: visitB, openedVisitId: visitA, reason: 'One attendance',
    })

    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey, resolution: 'new_attendance',
        subjectVisitId: visitB, openedVisitId: visitA, reason: 'Actually two',
      }),
      (error) => {
        assert.equal(error.code, 'RECONCILIATION_ALREADY_RESOLVED')
        assert.match(String(error.message), /Doctor/)
        return true
      },
    )
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.consultation_attempt_resolutions')), 1)
  })

  /*
   * This is the test that found the two-lock split.
   *
   * With one lock shared between "is a signing in flight" and "is another
   * doctor resolving", the loser's TRY failed and it was told the outcome
   * could not be established — when what had actually happened was that the
   * other doctor had just established it, and the truthful answer was the
   * determination they recorded. It failed about one run in three, which is
   * the worst way for it to have failed.
   */
  test('two doctors resolving at once produce one determination, and both are told the truth', async () => {
    const context = await consultingRoom()
    const locum = await makeStaff({ name: 'Locum', roles: ['doctor'], username: 'loc', pin: '5741' })
    const visitB = await arrive(context.nurse, context.patientId)
    const request = {
      patientId: context.patientId, idempotencyKey: randomUUID(),
      resolution: 'new_attendance', subjectVisitId: visitB, reason: 'Starting again',
    }

    const both = await Promise.allSettled([
      resolve(context.doctor, request),
      resolve(locum, request),
    ])

    assert.deepEqual(both.map((outcome) => outcome.status), ['fulfilled', 'fulfilled'],
      `neither doctor is shown the name of an index: ${
        both.filter((o) => o.status === 'rejected').map((o) => o.reason?.code ?? o.reason?.message)
      }`)
    const ids = new Set(both.map((outcome) => outcome.value.data.resolutionId))
    assert.equal(ids.size, 1, 'one attempt, one determination')
    assert.equal(
      both.filter((outcome) => outcome.value.data.duplicate === true).length, 1,
      'and exactly one of them is told it was a repeat')
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.consultation_attempt_resolutions')), 1)
  })
})

describe('who may make a clinical determination', () => {
  test('a nurse, a pharmacist and an administrator who is not a doctor are refused', async () => {
    const context = await consultingRoom()
    const visitB = await arrive(context.nurse, context.patientId)

    for (const staff of [context.nurse, context.pharmacist, context.admin]) {
      await assert.rejects(
        () => resolve(staff, {
          patientId: context.patientId, idempotencyKey: randomUUID(),
          resolution: 'new_attendance', subjectVisitId: visitB, reason: 'Trying',
        }),
        /role cannot perform/,
        `${staff.name} must not decide whether a patient was treated once or twice`)
    }
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.consultation_attempt_resolutions')), 0)
  })

  test('an administrator who is also a doctor may', async () => {
    const context = await consultingRoom()
    const both = await makeStaff({
      name: 'Owner Doctor', roles: ['admin', 'doctor'], username: 'own', pin: '5742',
    })
    const visitB = await arrive(context.nurse, context.patientId)
    const result = await resolve(both, {
      patientId: context.patientId, idempotencyKey: randomUUID(),
      resolution: 'new_attendance', subjectVisitId: visitB, reason: 'Starting again',
    })
    assert.equal(result.data.attemptReleased, true)
  })

  test('only a doctor may read the reconciliation, and a refusal says nothing about the key', async () => {
    const context = await consultingRoom()
    for (const staff of [context.nurse, context.pharmacist, context.admin]) {
      const { status } = await edgeGet(
        'workspace', `?view=reconciliation&key=anything&patientId=${context.patientId}`,
        await tokenFor(staff))
      assert.equal(status, 403, staff.name)
    }
  })

  test('a reference that signed somebody else’s consultation cannot be resolved here', async () => {
    const context = await consultingRoom()
    await as(context.doctor, 'create_patient',
      { name: 'Somebody Else', age: 31, sex: 'female', phone: '+919990000002' })
    const otherId = String(await scalar('select id from jmc.patients where name=$1', ['Somebody Else']))
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: otherId, idempotencyKey })

    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey,
        resolution: 'same_attendance', reason: 'One attendance',
      }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_NAMES_ANOTHER_CONSULTATION')
        return true
      },
    )
  })
})

describe('what a tablet actually receives', () => {
  const post = async (staff, action, payload) => edgeRequest('command', '', {
    method: 'POST',
    token: await tokenFor(staff),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, payload }),
  })

  test('the reconciliation refusal arrives with its code on the body', async () => {
    const context = await consultingRoom()
    const visitA = await arrive(context.nurse, context.patientId)
    const idempotencyKey = randomUUID()
    await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey, appointmentId: visitA, openedVisitId: visitA,
    })
    const visitB = await arrive(context.nurse, context.patientId)

    const refused = await post(context.doctor, 'sign_consultation', {
      ...SHEET, patientId: context.patientId, idempotencyKey,
      appointmentId: visitB, openedVisitId: visitA,
    })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.code, 'ATTEMPT_NEEDS_RECONCILIATION')
    assert.equal(
      /fresh reference/.test(refused.body.message), false,
      'the words must not invite the rotation that writes a second fee')
  })

  test('a resolution arrives as a command result, with the snapshot behind it', async () => {
    const context = await consultingRoom()
    const visitB = await arrive(context.nurse, context.patientId)
    const answer = await post(context.doctor, 'resolve_consultation_attempt', {
      patientId: context.patientId, idempotencyKey: randomUUID(),
      resolution: 'new_attendance', subjectVisitId: visitB, reason: 'Starting again',
    })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.equal(answer.body.data.attemptReleased, true)
    assert.ok(answer.body.revision > 0)
    assert.ok(Array.isArray(answer.body.snapshot.appointments))
  })
})

describe('A never committed, and a second visit is live', () => {
  /*
   * The blocker the acceptance review reproduced. Slice 2 let the live visit
   * win unconditionally — "the tablet is looking at it" — so an attempt opened
   * against A that had committed NOTHING, arriving with B live, signed B on the
   * spot: an encounter, a ₹300 fee, and A left standing in the queue, stepped
   * around without anybody deciding anything.
   *
   * Owner item 74 covers exactly this. "If A did not commit, the doctor
   * explicitly chooses which active attendance continues; the abandoned path is
   * preserved in audit."
   */
  async function twoLiveVisits() {
    const context = await consultingRoom()
    const visitA = await arrive(context.nurse, context.patientId)
    const visitB = await arrive(context.nurse, context.patientId, 'Arrived again')
    return { ...context, visitA, visitB, idempotencyKey: randomUUID() }
  }

  test('signing is refused before anything clinical or financial is written', async () => {
    const { doctor, patientId, visitA, visitB, idempotencyKey } = await twoLiveVisits()

    await assert.rejects(
      () => sign(doctor, { patientId, idempotencyKey, appointmentId: visitB, openedVisitId: visitA }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_NEEDS_RECONCILIATION',
          'owner item 74: the clinic does not choose which attendance continues')
        assert.match(String(error.message), /nothing was charged/i)
        return true
      },
    )

    assert.deepEqual(await effectsFor(patientId), {
      encounters: 0,
      linkedTo: [],
      visits: ['waiting', 'waiting'],
      prescriptions: 0,
      followUps: 0,
      invoices: 0,
      feeLines: 0,
      charged: '0',
      resolutions: 0,
      resolutionAudits: 0,
      completions: 0,
    }, 'no encounter, no prescription, no invoice, no fee, and neither visit closed')
  })

  test('the refusal does not release the attempt, and the tablet holds it', async () => {
    const { doctor, patientId, visitA, visitB, idempotencyKey } = await twoLiveVisits()
    const request = { patientId, idempotencyKey, appointmentId: visitB, openedVisitId: visitA }

    // Twice, because a refusal that quietly released would let the second
    // press through under a fresh reference.
    for (let n = 0; n < 2; n += 1) {
      await assert.rejects(() => sign(doctor, request), (error) => {
        assert.equal(error.code, 'ATTEMPT_NEEDS_RECONCILIATION')
        return true
      })
    }
    const { settleConsultationAttempt } = await import('../../lib/consultation-attempt.ts')
    assert.equal(
      settleConsultationAttempt('patient', {
        status: 'refused', code: 'ATTEMPT_NEEDS_RECONCILIATION',
      }),
      false,
      'and the client does not rotate on it either')
  })

  test('the doctor chooses which attendance continues, and then it signs', async () => {
    const { doctor, nurse, patientId, visitA, visitB, idempotencyKey } = await twoLiveVisits()
    await assert.rejects(
      () => sign(doctor, { patientId, idempotencyKey, appointmentId: visitB, openedVisitId: visitA }),
      (error) => (error.code === 'ATTEMPT_NEEDS_RECONCILIATION'),
    )

    // B continues. A is the abandoned path and stays in the queue for reception
    // to close; nothing here cancels a visit a person created.
    const resolved = await resolve(doctor, {
      patientId, idempotencyKey, resolution: 'new_attendance',
      subjectVisitId: visitB, openedVisitId: visitA,
      reason: 'Reception arrived them twice; seeing them under the second token',
    })
    assert.equal(resolved.data.priorOutcome, 'not_committed')
    assert.equal(resolved.data.attemptReleased, true)

    // The tablet rotates on that code and signs B under a fresh reference.
    await sign(doctor, {
      patientId, idempotencyKey: randomUUID(), appointmentId: visitB, openedVisitId: visitB,
    })

    const after = await effectsFor(patientId)
    assert.equal(after.encounters, 1)
    assert.deepEqual(after.linkedTo, [visitB], 'against the visit the doctor chose')
    assert.deepEqual(after.visits, ['waiting', 'done'], 'and A was not stepped around')
    assert.equal(after.charged, '300.00', 'one attendance, one fee')
    assert.ok(nurse)
  })

  test('the four compatible shapes still sign', async () => {
    // opened = live: agreement.
    {
      const context = await consultingRoom('Same Visit')
      const visit = await arrive(context.nurse, context.patientId)
      await sign(context.doctor, {
        patientId: context.patientId, idempotencyKey: randomUUID(),
        appointmentId: visit, openedVisitId: visit,
      })
      const effects = await effectsFor(context.patientId)
      assert.deepEqual(effects.linkedTo, [visit])
      assert.deepEqual(effects.visits, ['done'])
    }
    // opened = none, live = a visit: the walk-in that acquired one.
    {
      const context = await consultingRoom('Acquired A Visit')
      const visit = await arrive(context.nurse, context.patientId)
      await sign(context.doctor, {
        patientId: context.patientId, idempotencyKey: randomUUID(), appointmentId: visit,
      })
      const effects = await effectsFor(context.patientId)
      assert.deepEqual(effects.linkedTo, [visit], 'policy item 3 allows creating it mid-attempt')
    }
    // opened = a visit, live = none: the ordinary retry shape.
    {
      const context = await consultingRoom('Nothing Live')
      const visit = await arrive(context.nurse, context.patientId)
      await sign(context.doctor, {
        patientId: context.patientId, idempotencyKey: randomUUID(), openedVisitId: visit,
      })
      const effects = await effectsFor(context.patientId)
      assert.deepEqual(effects.linkedTo, [visit])
    }
    // neither: a direct consultation.
    {
      const context = await consultingRoom('No Visit At All')
      await sign(context.doctor, { patientId: context.patientId, idempotencyKey: randomUUID() })
      const effects = await effectsFor(context.patientId)
      assert.deepEqual(effects.linkedTo, [null])
    }
  })

  test('and a legitimate retry of the refused request is still refused, not signed', async () => {
    const { doctor, patientId, visitA, visitB, idempotencyKey } = await twoLiveVisits()
    const request = { patientId, idempotencyKey, appointmentId: visitB, openedVisitId: visitA }
    await assert.rejects(() => sign(doctor, request), (e) => e.code === 'ATTEMPT_NEEDS_RECONCILIATION')

    // The visit the attempt was opened against is cancelled by reception. That
    // does NOT make the choice for the doctor: which attendance continues is
    // still theirs to say, and nothing may be written until they say it.
    await as(doctor, 'set_appointment_status', { appointmentId: visitA, status: 'cancelled' })
    await assert.rejects(
      () => sign(doctor, request),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_NEEDS_RECONCILIATION')
        return true
      },
    )
    const effects = await effectsFor(patientId)
    assert.equal(effects.encounters, 0)
    assert.equal(effects.charged, '0')
  })
})

describe('a visit named in a reconciliation belongs to the patient', () => {
  /*
   * The acceptance review recorded a cross-patient relationship being accepted
   * and stored: one patient's queue row reconciled against another patient's
   * consultation. The command checks it now, and `20260921000000` adds
   * composite foreign keys on `(visit, patient)` so the schema refuses it too.
   */
  async function twoPatients() {
    const context = await consultingRoom('First Patient')
    await as(context.doctor, 'create_patient',
      { name: 'Second Patient', age: 31, sex: 'female', phone: '+919990000021' })
    const strangerId = String(
      await scalar('select id from jmc.patients where name=$1', ['Second Patient']))
    const strangerVisit = await arrive(context.nurse, strangerId, 'Somebody else')
    return { ...context, strangerId, strangerVisit }
  }

  test('a subject visit belonging to somebody else is refused, on all three determinations', async () => {
    for (const resolution of ['same_attendance', 'new_attendance', 'abandoned_attempt']) {
      const context = await twoPatients()
      const idempotencyKey = randomUUID()
      if (resolution === 'same_attendance') {
        await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
      }

      await assert.rejects(
        () => resolve(context.doctor, {
          patientId: context.patientId, idempotencyKey, resolution,
          subjectVisitId: context.strangerVisit,
          openedVisitId: resolution === 'abandoned_attempt' ? context.strangerVisit : undefined,
          reason: 'Trying it on',
        }),
        (error) => {
          assert.ok(
            error.code === 'VISIT_NOT_THIS_PATIENTS' || /closes nothing/.test(String(error.message)),
            `${resolution}: ${error.code ?? error.message}`)
          return true
        },
      )

      assert.equal(Number(await scalar(
        'select count(*)::int from jmc.consultation_attempt_resolutions')), 0, resolution)
      assert.equal(
        String(await scalar('select status from jmc.appointments where id=$1',
          [context.strangerVisit])), 'waiting',
        `${resolution}: somebody else's visit is untouched`)
    }
  })

  test('an opened visit belonging to somebody else is refused, on all three determinations', async () => {
    for (const resolution of ['same_attendance', 'new_attendance', 'abandoned_attempt']) {
      const context = await twoPatients()
      const own = await arrive(context.nurse, context.patientId)
      const idempotencyKey = randomUUID()
      if (resolution === 'same_attendance') {
        await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
      }

      await assert.rejects(
        () => resolve(context.doctor, {
          patientId: context.patientId, idempotencyKey, resolution,
          subjectVisitId: resolution === 'abandoned_attempt' ? undefined : own,
          openedVisitId: context.strangerVisit,
          reason: 'Trying it on',
        }),
        (error) => {
          assert.equal(error.code, 'VISIT_NOT_THIS_PATIENTS', resolution)
          return true
        },
      )

      assert.equal(Number(await scalar(
        'select count(*)::int from jmc.consultation_attempt_resolutions')), 0, resolution)
      const untouched = await rows(
        `select status from jmc.appointments where id = any($1::text[]) order by id`,
        [[own, context.strangerVisit]])
      assert.deepEqual(untouched.map((row) => row.status), ['waiting', 'waiting'], resolution)
      assert.equal(Number(await scalar(
        'select count(*)::int from jmc.encounters where patient_id=$1',
        [context.strangerId])), 0, resolution)
    }
  })

  test('and the database refuses it even if the command ever stopped checking', async () => {
    const context = await twoPatients()
    const own = await arrive(context.nurse, context.patientId)

    for (const [column, visit] of [
      ['subject_visit_id', context.strangerVisit],
      ['opened_visit_id', context.strangerVisit],
    ]) {
      await assert.rejects(
        () => rows(
          `insert into jmc.consultation_attempt_resolutions
             (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
              ${column}, reason, request_fingerprint)
           values ($1,$2,$3,$4,'new_attendance','not_committed',$5,'By hand','x')`,
          [randomUUID(), randomUUID(), context.patientId, context.doctor.id, visit],
        ),
        /is_this_patients/,
        `${column} must be refused by the schema, not only by the command`)
    }

    // And the patient's own visit is accepted, so the constraint is not simply
    // refusing everything.
    await rows(
      `insert into jmc.consultation_attempt_resolutions
         (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
          subject_visit_id, reason, request_fingerprint)
       values ($1,$2,$3,$4,'new_attendance','not_committed',$5,'By hand','x')`,
      [randomUUID(), randomUUID(), context.patientId, context.doctor.id, own],
    )
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.consultation_attempt_resolutions')), 1)
  })

  test('an encounter belonging to somebody else cannot be reconciled here either', async () => {
    const context = await twoPatients()
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.strangerId, idempotencyKey })

    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey,
        resolution: 'same_attendance', reason: 'Trying it on',
      }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_NAMES_ANOTHER_CONSULTATION')
        return true
      },
    )
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.consultation_attempt_resolutions')), 0)
  })
})

describe('same attendance has to name the visit it closes', () => {
  /*
   * The trap the independent review walked. `subjectVisitId` was optional on
   * every determination, so a doctor could record Same attendance with a visit
   * still in the queue, close nothing, and spend the reference's one
   * resolution — and the next press then read "and closed it" about a visit
   * that was still waiting, under a code that does not rotate. No way to sign,
   * no way to resolve again.
   *
   * Owner item 72 defines Same attendance as creating the link AND closing the
   * leftover visit.
   */
  test('with a visit in the queue and none named, it is refused and nothing is spent', async () => {
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    const visit = await arrive(context.nurse, context.patientId)

    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey,
        resolution: 'same_attendance', reason: 'One attendance',
      }),
      (error) => {
        assert.equal(error.code, 'SUBJECT_VISIT_REQUIRED')
        assert.match(String(error.message), /JMC-/)
        return true
      },
    )
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.consultation_attempt_resolutions')), 0,
      'and the reference still has its one resolution')

    // Naming it works, and closes it.
    await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey, resolution: 'same_attendance',
      subjectVisitId: visit, reason: 'One attendance',
    })
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [visit])), 'done')
  })

  test('with no queue row at all, none is asked for', async () => {
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })

    const resolved = await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey,
      resolution: 'same_attendance', reason: 'The consultation stands',
    })
    assert.equal(resolved.data.subjectVisitClosed, false)
    assert.equal(resolved.data.attemptReleased, true)
  })

  test('and a visit the determination did not name lets the doctor sign it', async () => {
    /*
     * The other half of the trap: a determination that named no visit, met
     * afterwards by one. It used to answer
     * `ATTEMPT_RECONCILED_AS_SAME_ATTENDANCE` — which says "and closed it",
     * false, and does not rotate, so the doctor was stuck. The reference IS
     * settled and this visit was not part of it, so it takes the code that
     * rotates and the next press signs it in the ordinary way.
     */
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey,
      resolution: 'same_attendance', reason: 'The consultation stands',
    })

    // A visit appears afterwards.
    const later = await arrive(context.nurse, context.patientId, 'Came back')
    await assert.rejects(
      () => sign(context.doctor, {
        patientId: context.patientId, idempotencyKey, appointmentId: later,
      }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_SETTLED_BY_RECONCILIATION')
        assert.match(String(error.message), /did not name the visit you have open/)
        assert.match(String(error.message), /fresh reference/)
        return true
      },
    )

    // Which the tablet rotates on, and the visit signs normally.
    await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey: randomUUID(),
      appointmentId: later, openedVisitId: later,
    })
    const effects = await effectsFor(context.patientId)
    assert.equal(effects.encounters, 2)
    assert.deepEqual(effects.visits, ['done'])
  })

  test('and the visit it DID name still says it was closed', async () => {
    const context = await consultingRoom()
    const visitA = await arrive(context.nurse, context.patientId)
    const idempotencyKey = randomUUID()
    await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey, appointmentId: visitA, openedVisitId: visitA,
    })
    const visitB = await arrive(context.nurse, context.patientId)
    await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey, resolution: 'same_attendance',
      subjectVisitId: visitB, openedVisitId: visitA, reason: 'One attendance',
    })

    await assert.rejects(
      () => sign(context.doctor, {
        patientId: context.patientId, idempotencyKey, appointmentId: visitB, openedVisitId: visitA,
      }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_RECONCILED_AS_SAME_ATTENDANCE')
        assert.match(String(error.message), /closed it/)
        return true
      },
    )
  })
})

describe('the read and the command agree about what is available', () => {
  test('an opened visit belonging to somebody else is not offered as abandoned', async () => {
    /*
     * The correction tightened the command to refuse a cross-patient visit and
     * did not re-check the read against it, so the read went on offering
     * `abandoned_attempt` as available — "not found" read as "not active". The
     * read's own comment promises it never offers a button the server rejects.
     */
    const context = await consultingRoom('First Patient')
    await as(context.doctor, 'create_patient',
      { name: 'Second Patient', age: 31, sex: 'female', phone: '+919990000041' })
    const strangerId = String(
      await scalar('select id from jmc.patients where name=$1', ['Second Patient']))
    const strangerVisit = await arrive(context.nurse, strangerId, 'Somebody else')
    const idempotencyKey = randomUUID()

    const { body } = await edgeGet(
      'workspace',
      `?view=reconciliation&key=${idempotencyKey}&patientId=${context.patientId}`
      + `&openedVisitId=${strangerVisit}`,
      await tokenFor(context.doctor))
    const offered = body.reconciliation.options.find((o) => o.resolution === 'abandoned_attempt')
    assert.equal(offered.available, false)
    assert.equal(offered.refusalCode, 'VISIT_NOT_THIS_PATIENTS')

    // And the command agrees, which is the whole of the promise.
    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey, openedVisitId: strangerVisit,
        resolution: 'abandoned_attempt', reason: 'Trying it on',
      }),
      (error) => {
        assert.equal(error.code, 'VISIT_NOT_THIS_PATIENTS')
        return true
      },
    )
  })

  test('a resolution belonging to another patient is not handed back', async () => {
    const context = await consultingRoom('First Patient')
    await as(context.doctor, 'create_patient',
      { name: 'Second Patient', age: 31, sex: 'female', phone: '+919990000042' })
    const strangerId = String(
      await scalar('select id from jmc.patients where name=$1', ['Second Patient']))
    const strangerVisit = await arrive(context.nurse, strangerId, 'Somebody else')
    const idempotencyKey = randomUUID()
    await resolve(context.doctor, {
      patientId: strangerId, idempotencyKey, resolution: 'new_attendance',
      subjectVisitId: strangerVisit, reason: 'Their own business',
    })

    const { body } = await edgeGet(
      'workspace', `?view=reconciliation&key=${idempotencyKey}&patientId=${context.patientId}`,
      await tokenFor(context.doctor))
    assert.equal(body.reconciliation.resolved, undefined,
      'the consultation two lines above it was gated on the patient and this was not')
    assert.equal(
      JSON.stringify(body.reconciliation).includes('Their own business'), false)
  })
})

describe('same attendance closes the visit it names, or is refused', () => {
  async function signedWithAVisitIn(status) {
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    const visit = await arrive(context.nurse, context.patientId)
    if (status !== 'waiting') {
      await as(context.nurse, 'set_appointment_status', { appointmentId: visit, status })
    }
    return { ...context, visit, idempotencyKey }
  }

  for (const status of ['waiting', 'in_consult']) {
    test(`a ${status} visit is closed, and the row and the events say so`, async () => {
      const { doctor, patientId, visit, idempotencyKey } = await signedWithAVisitIn(status)
      const resolved = await resolve(doctor, {
        patientId, idempotencyKey, resolution: 'same_attendance',
        subjectVisitId: visit, reason: 'One attendance',
      })

      assert.equal(resolved.data.subjectVisitClosed, true)
      const [row] = await rows(
        'select subject_visit_id, subject_visit_closed from jmc.consultation_attempt_resolutions')
      assert.equal(row.subject_visit_id, visit)
      assert.equal(row.subject_visit_closed, true)
      assert.equal(
        String(await scalar('select status from jmc.appointments where id=$1', [visit])), 'done')
      const [event] = await rows(
        `select from_status, to_status, actor_id from jmc.appointment_events
          where arrival_id=$1 and event='closed_on_reconciliation'`, [visit])
      assert.deepEqual(
        { from: event.from_status, to: event.to_status, by: event.actor_id },
        { from: status, to: 'done', by: doctor.id })
      assert.equal(Number(await scalar(
        `select count(*)::int from jmc.audit_events where action='consultation_attempt.resolved'`)), 1)
    })
  }

  test('a cancelled visit is refused, and the reference is left unspent', async () => {
    /*
     * The owner decision of 16 September 2026 keeps a cancelled visit
     * ineligible. It was not an attendance, so a consultation cannot be the
     * same attendance as it, and the cancellation is its own correction to
     * make first.
     */
    const { doctor, patientId, visit, idempotencyKey } = await signedWithAVisitIn('cancelled')

    await assert.rejects(
      () => resolve(doctor, {
        patientId, idempotencyKey, resolution: 'same_attendance',
        subjectVisitId: visit, reason: 'One attendance',
      }),
      (error) => {
        assert.equal(error.code, 'SUBJECT_VISIT_NOT_OPEN')
        assert.match(String(error.message), /JMC-/)
        assert.match(String(error.message), /cancelled/)
        return true
      },
    )

    assert.deepEqual(await effectsFor(patientId), {
      encounters: 1, linkedTo: [null], visits: ['cancelled'],
      prescriptions: 0, followUps: 0, invoices: 1, feeLines: 1, charged: '300.00',
      resolutions: 0, resolutionAudits: 0, completions: 1,
    }, 'nothing recorded, nothing closed, nothing charged, and the reference unspent')

    // Which it is: the doctor says what they meant, and it works.
    const resolved = await resolve(doctor, {
      patientId, idempotencyKey, resolution: 'same_attendance', reason: 'The consultation stands',
    })
    assert.equal(resolved.data.attemptReleased, true)
  })

  test('a visit already done is linked retrospectively, and no closure is claimed', async () => {
    /*
     * The owner decision, 16 September 2026:
     *
     *   "A doctor may retrospectively link same_attendance to a same-patient
     *   visit already marked done. Record whether the resolution closed it now
     *   or found it already done; never claim the resolution performed a
     *   closure it did not perform."
     *
     * So the disposition is its own field. Overloading `subject_visit_closed`
     * is what made the clinic report a closure that did not happen, and a
     * boolean cannot hold three answers.
     */
    const { doctor, nurse, patientId, visit, idempotencyKey } = await signedWithAVisitIn('done')
    const alsoOpen = await arrive(nurse, patientId, 'A genuinely separate arrival')

    const resolved = await resolve(doctor, {
      patientId, idempotencyKey, resolution: 'same_attendance',
      subjectVisitId: visit, reason: 'He was seen at that visit',
    })

    assert.equal(resolved.data.subjectVisitDisposition, 'already_done')
    assert.match(resolved.message, /already finished, so nothing about it changed/,
      'and the sentence says which of the three happened, not one of two')
    assert.equal(resolved.data.subjectVisitClosed, false, 'because this determination closed nothing')
    const [row] = await rows(
      `select subject_visit_id, subject_visit_closed, subject_visit_disposition
         from jmc.consultation_attempt_resolutions`)
    assert.deepEqual(
      { visit: row.subject_visit_id, closed: row.subject_visit_closed, how: row.subject_visit_disposition },
      { visit, closed: false, how: 'already_done' })

    assert.equal(Number(await scalar(
      `select count(*)::int from jmc.appointment_events
        where arrival_id=$1 and event='closed_on_reconciliation'`, [visit])), 0,
      'no closure event, because no closure happened')
    assert.match(
      String(await scalar(
        `select summary from jmc.audit_events where action='consultation_attempt.resolved'`)),
      /already finished and was linked retrospectively/)

    // "Other open visits remain untouched."
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [alsoOpen])), 'waiting')

    // And the sentence a doctor meets afterwards does not invent a closure.
    await assert.rejects(
      () => sign(doctor, { patientId, idempotencyKey, appointmentId: visit }),
      (error) => {
        assert.equal(/and closed it/.test(String(error.message)), false)
        assert.match(String(error.message), /already finished/)
        return true
      },
    )
  })

  /*
   * A guard rather than a regression, and labelled so.
   *
   * With the refusal above and the constraint beside it, a same-attendance row
   * naming a visit has always closed it, so this cannot be made to fail by
   * reverting the `subject_visit_closed` read in `refuseSettledAttempt`. What
   * it holds is the shape a doctor actually meets: a determination that named
   * no visit must not be described afterwards as one that closed a visit.
   */
  test('a determination that closed nothing never says it closed something', async () => {
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey,
      resolution: 'same_attendance', reason: 'The consultation stands',
    })
    const later = await arrive(context.nurse, context.patientId, 'Came back')

    await assert.rejects(
      () => sign(context.doctor, {
        patientId: context.patientId, idempotencyKey, appointmentId: later,
      }),
      (error) => {
        assert.equal(error.code, 'ATTEMPT_SETTLED_BY_RECONCILIATION')
        assert.equal(/closed it/.test(String(error.message)), false)
        return true
      },
    )
  })

  test('and the database refuses a hollow same-attendance however it arrives', async () => {
    /*
     * The command is the sentence a doctor reads; this is the guarantee. A
     * psql session, a repair script or a later command that forgets can all
     * reach this table, and none of them may record a closure that did not
     * happen.
     */
    const context = await consultingRoom()
    const signed = await sign(context.doctor,
      { patientId: context.patientId, idempotencyKey: randomUUID() })
    const visit = await arrive(context.nurse, context.patientId)

    await assert.rejects(
      () => rows(
        `insert into jmc.consultation_attempt_resolutions
           (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
            encounter_id, subject_visit_id, subject_visit_closed, reason, request_fingerprint)
         values ($1,$2,$3,$4,'same_attendance','committed',$5,$6,false,'By hand','x')`,
        [randomUUID(), randomUUID(), context.patientId, context.doctor.id,
          signed.data.encounterId, visit],
      ),
      // `20260923000000` replaced `resolutions_same_attendance_closes_its_visit`
      // with rules that say what it meant to say. Either name is the schema
      // refusing the same untrue row.
      /closes_its_visit|disposition_follows_the_determination/,
    )
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [visit])), 'waiting')
  })
})

describe('the read and the command agree, across the whole matrix', () => {
  /*
   * Table-driven, because the two drifted apart twice: once when the command
   * was tightened to refuse a visit belonging to another patient and the read
   * was not, and once when that correction reached one determination of three.
   * Neither was caught here, which is why this walks every cell rather than
   * the interesting ones.
   *
   * Each cell gets its own clinic, because resolving spends the reference and
   * a shared scene would only ever test the first determination that ran.
   *
   * The property: every option the read marks available is executable under
   * exactly the facts the read saw, and every option it marks unavailable is
   * refused with the code the read named.
   */
  const EVERY = ['same_attendance', 'new_attendance', 'abandoned_attempt']

  async function scene({ committed, openedVisit, resolvedAlready = false }) {
    const context = await consultingRoom('Matrix Patient')
    await as(context.doctor, 'create_patient',
      { name: 'Somebody Else', age: 31, sex: 'female', phone: '+919990000051' })
    const strangerId = String(
      await scalar('select id from jmc.patients where name=$1', ['Somebody Else']))
    const strangerVisit = await arrive(context.nurse, strangerId, 'Theirs')

    const idempotencyKey = randomUUID()
    const own = await arrive(context.nurse, context.patientId)
    if (committed) {
      await sign(context.doctor, {
        patientId: context.patientId, idempotencyKey, appointmentId: own, openedVisitId: own,
      })
    } else {
      // Nothing was recorded, and the visit it was opened against is gone —
      // which is the shape owner item 73 calls an abandoned attempt.
      await as(context.nurse, 'set_appointment_status', { appointmentId: own, status: 'cancelled' })
    }
    const subject = await arrive(context.nurse, context.patientId, 'Second arrival')

    const opened = openedVisit === 'none' ? ''
      : openedVisit === 'cross' ? strangerVisit
      : openedVisit === 'missing' ? randomUUID()
      : openedVisit === 'closed' ? own
      : subject

    if (resolvedAlready) {
      // A DIFFERENT reason, deliberately, because `reason` is material: this
      // cell is about a doctor arriving at a settled reference and being shown
      // what was settled, not about an exact retry. The exact retry replays
      // and has a test of its own below, which the first version of this
      // matrix was silently relying on not being the case.
      await resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey, resolution: 'new_attendance',
        subjectVisitId: subject, reason: 'Already decided',
      })
    }
    return { ...context, idempotencyKey, opened, subject }
  }

  const CASES = [
    { name: 'committed, the opened visit still open', committed: true, openedVisit: 'open' },
    { name: 'committed, the opened visit closed', committed: true, openedVisit: 'closed' },
    { name: 'committed, no opened visit named', committed: true, openedVisit: 'none' },
    { name: 'committed, a stranger\u2019s opened visit', committed: true, openedVisit: 'cross' },
    { name: 'committed, an opened visit that does not exist', committed: true, openedVisit: 'missing' },
    { name: 'nothing recorded, the opened visit still open', committed: false, openedVisit: 'open' },
    { name: 'nothing recorded, the opened visit closed', committed: false, openedVisit: 'closed' },
    { name: 'nothing recorded, no opened visit named', committed: false, openedVisit: 'none' },
    { name: 'nothing recorded, a stranger\u2019s opened visit', committed: false, openedVisit: 'cross' },
    { name: 'already resolved', committed: false, openedVisit: 'open', resolvedAlready: true },
  ]

  async function offered(context) {
    const ask = `?view=reconciliation&key=${context.idempotencyKey}`
      + `&patientId=${context.patientId}`
      + (context.opened ? `&openedVisitId=${context.opened}` : '')
    const { body } = await edgeGet('workspace', ask, await tokenFor(context.doctor))
    assert.equal(body.reconciliation.options.length, 3)
    return body.reconciliation.options
  }

  for (const scenario of CASES) {
    for (const resolution of EVERY) {
      test(`${scenario.name}: ${resolution.replace(/_/g, ' ')}`, async () => {
        const context = await scene(scenario)
        const option = (await offered(context)).find((row) => row.resolution === resolution)
        assert.ok(option, resolution)

        const request = {
          patientId: context.patientId,
          idempotencyKey: context.idempotencyKey,
          resolution,
          reason: 'Walking the matrix',
          openedVisitId: context.opened || undefined,
          // An abandoned attempt closes nothing, so it never names a subject.
          subjectVisitId: resolution === 'abandoned_attempt' ? undefined : context.subject,
        }

        if (option.available) {
          const done = await resolve(context.doctor, request)
          assert.equal(done.data.resolution, resolution,
            'the read offered it, so the command must perform it under the same facts')
          return
        }

        assert.ok(option.detail, 'an unavailable option has to say why')
        await assert.rejects(
          () => resolve(context.doctor, request),
          (error) => {
            assert.equal(error.code ?? undefined, option.refusalCode ?? undefined,
              `the read promised ${option.refusalCode ?? 'a plain refusal'} and the command gave ${
                error.code ?? 'a plain refusal'}`)
            return true
          },
        )
        assert.equal(Number(await scalar(
          `select count(*)::int from jmc.consultation_attempt_resolutions where patient_id=$1`,
          [context.patientId])), scenario.resolvedAlready ? 1 : 0,
          'and a refused determination records nothing')
      })
    }
  }
})

describe('the cells the option list cannot see, and the one it saw wrongly', () => {
  /*
   * The gate table mirrors the refusals the read is in a position to know
   * about. Three of the command's refusals turn on `subjectVisitId`, which the
   * read is never given — `workspace/index.ts` passes the key, the patient and
   * the opened visit and nothing else — so the read offers Same attendance as
   * available and the command decides when it sees which visit was named.
   *
   * That is a real limit rather than a bug, and the frontend contract says so
   * in §2 in words a screen has to obey. These tests are what stops the words
   * drifting away from the command: each one is a cell the 30-cell matrix
   * cannot reach, pinned where it actually lives.
   */
  async function settledCommittedPatient() {
    const context = await consultingRoom('Edge Patient')
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    const subject = await arrive(context.nurse, context.patientId, 'Second arrival')
    return { ...context, idempotencyKey, subject }
  }

  test('a new attendance is told to name its visit, in the detail a screen shows', async () => {
    /*
     * The fourth correction gave `new_attendance` a `SUBJECT_VISIT_REQUIRED`
     * refusal and left its detail branching on whether anything was signed, so
     * the option came back available saying nothing about naming a visit. A
     * screen built to the contract's own instruction would have submitted
     * without one and met the refusal — the promise this table exists to keep,
     * broken for the case that round had just created.
     */
    const context = await settledCommittedPatient()
    const { body } = await edgeGet(
      'workspace',
      `?view=reconciliation&key=${context.idempotencyKey}&patientId=${context.patientId}`,
      await tokenFor(context.doctor))
    const offered = body.reconciliation.options.find((o) => o.resolution === 'new_attendance')
    assert.equal(offered.available, true)
    assert.match(offered.detail, /Name the visit/,
      'the detail a screen shows must ask for what the command requires')

    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey: context.idempotencyKey,
        resolution: 'new_attendance', reason: 'No visit named',
      }),
      (error) => {
        assert.equal(error.code, 'SUBJECT_VISIT_REQUIRED')
        return true
      },
    )

    const done = await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey: context.idempotencyKey,
      resolution: 'new_attendance', subjectVisitId: context.subject, reason: 'He has come back',
    })
    assert.equal(done.data.subjectVisitId, context.subject)
  })

  test('and with no visit open, it does not ask for one', async () => {
    // A patient opened from the register has no queue row to name, and a
    // detail asking for one would be asking for something that does not exist.
    const context = await consultingRoom('No Queue Row')
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    const { body } = await edgeGet(
      'workspace',
      `?view=reconciliation&key=${idempotencyKey}&patientId=${context.patientId}`,
      await tokenFor(context.doctor))
    for (const option of body.reconciliation.options) {
      if (option.available) assert.equal(/Name the/.test(option.detail), false, option.resolution)
    }
  })

  test('offered as available, sent without a visit, refused by name', async () => {
    const context = await settledCommittedPatient()
    const { body } = await edgeGet(
      'workspace',
      `?view=reconciliation&key=${context.idempotencyKey}&patientId=${context.patientId}`,
      await tokenFor(context.doctor))
    const offered = body.reconciliation.options.find((o) => o.resolution === 'same_attendance')
    assert.equal(offered.available, true)
    assert.match(offered.detail, /Name the open visit/,
      'so the screen is told what it still has to supply')

    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey: context.idempotencyKey,
        resolution: 'same_attendance', reason: 'No visit named',
      }),
      (error) => {
        assert.equal(error.code, 'SUBJECT_VISIT_REQUIRED')
        assert.match(String(error.message), /JMC-/, 'and it names the token to send')
        return true
      },
    )
    // Unspent, so the screen can obey the detail it was given.
    const done = await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey: context.idempotencyKey,
      resolution: 'same_attendance', subjectVisitId: context.subject, reason: 'One attendance',
    })
    assert.equal(done.data.subjectVisitClosed, true)
  })

  test('offered as available, sent with a stranger\u2019s visit, refused by name', async () => {
    const context = await settledCommittedPatient()
    await as(context.doctor, 'create_patient',
      { name: 'Somebody Else', age: 31, sex: 'female', phone: '+919990000061' })
    const strangerId = String(
      await scalar('select id from jmc.patients where name=$1', ['Somebody Else']))
    const theirs = await arrive(context.nurse, strangerId, 'Theirs')

    for (const resolution of ['same_attendance', 'new_attendance']) {
      await assert.rejects(
        () => resolve(context.doctor, {
          patientId: context.patientId, idempotencyKey: context.idempotencyKey,
          resolution, subjectVisitId: theirs, reason: 'Wrong visit',
        }),
        (error) => {
          assert.equal(error.code, 'VISIT_NOT_THIS_PATIENTS', resolution)
          return true
        },
      )
    }
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.consultation_attempt_resolutions')), 0)
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [theirs])), 'waiting',
      'and the stranger is still in the queue')
  })

  test('an exact retry of a determination replays; the read shows what it was', async () => {
    /*
     * The read marks every option unavailable once a reference is settled,
     * which is the right thing to put in front of a doctor. The command is
     * gentler, because it must be: an exact retry of the SAME determination is
     * the lost-reply case the whole mechanism exists for, and it replays.
     *
     * The two are not in conflict — the screen shows what was recorded instead
     * of the buttons — but the matrix above asserts the refusal, so this is
     * where the replay is held.
     */
    const context = await settledCommittedPatient()
    const request = {
      patientId: context.patientId, idempotencyKey: context.idempotencyKey,
      resolution: 'same_attendance', subjectVisitId: context.subject,
      reason: 'One attendance',
    }
    const first = await resolve(context.doctor, request)
    const retry = await resolve(context.doctor, request)
    assert.equal(retry.data.resolutionId, first.data.resolutionId)
    assert.equal(retry.data.duplicate, true)
    assert.equal(retry.data.subjectVisitClosed, true)

    const { body } = await edgeGet(
      'workspace',
      `?view=reconciliation&key=${context.idempotencyKey}&patientId=${context.patientId}`,
      await tokenFor(context.doctor))
    assert.equal(body.reconciliation.resolved.resolutionId, first.data.resolutionId)
    for (const option of body.reconciliation.options) {
      assert.equal(option.available, false, option.resolution)
      assert.equal(option.refusalCode, 'RECONCILIATION_ALREADY_RESOLVED')
    }
  })

  test('a reference settled for another patient is settled here too', async () => {
    /*
     * The read filtered its lookup by patient, so a reference resolved for
     * somebody else made the "already resolved" gate miss entirely: all three
     * options were offered as available, and the command refused every one of
     * them with `RECONCILIATION_ALREADY_RESOLVED` — because the key is unique
     * across the clinic and the fingerprint names a different patient.
     *
     * The filter belongs on what is SHOWN, which is what it was added for: a
     * doctor must not be handed a stranger's doctor's free-text reason.
     * Reproduced by the independent review.
     */
    const context = await consultingRoom('Ours')
    await as(context.doctor, 'create_patient',
      { name: 'Theirs', age: 31, sex: 'female', phone: '+919990000062' })
    const strangerId = String(await scalar('select id from jmc.patients where name=$1', ['Theirs']))
    const theirVisit = await arrive(context.nurse, strangerId, 'Theirs')

    const idempotencyKey = randomUUID()
    await resolve(context.doctor, {
      patientId: strangerId, idempotencyKey, resolution: 'new_attendance',
      subjectVisitId: theirVisit, reason: 'Their doctor’s own words',
    })

    const { body } = await edgeGet(
      'workspace',
      `?view=reconciliation&key=${idempotencyKey}&patientId=${context.patientId}`,
      await tokenFor(context.doctor))

    assert.equal(body.reconciliation.resolved, undefined,
      'nothing about the other patient is handed over')
    assert.equal(JSON.stringify(body).includes('Their doctor'), false)
    for (const option of body.reconciliation.options) {
      assert.equal(option.available, false, option.resolution)
      assert.equal(option.refusalCode, 'RECONCILIATION_ALREADY_RESOLVED')
      assert.match(option.detail, /different patient/)
    }

    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey,
        resolution: 'new_attendance', reason: 'Ours',
      }),
      (error) => {
        assert.equal(error.code, 'RECONCILIATION_ALREADY_RESOLVED')
        return true
      },
    )
  })
})

describe('a reconciled visit stays reconciled', () => {
  /*
   * The one that could take money twice, and the reason this slice has been
   * returned four times: owner item 72 closes the leftover visit so that one
   * attendance is recorded once and charged once. The closure was written in
   * the command that performs it, and `set_appointment_status` moves any visit
   * to any status. So a nurse tidying the queue could put a reconciled visit
   * back into it, and the next signature — under a fresh reference, so no
   * idempotency guard applies — wrote a second encounter and a second ₹300.
   *
   * Reproduced against the guarded database before any of this was written:
   * two encounters, two fee lines, ₹600.
   */
  async function reconciled() {
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    const leftover = await arrive(context.nurse, context.patientId)
    await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey, resolution: 'same_attendance',
      subjectVisitId: leftover, reason: 'One attendance',
    })
    return { ...context, leftover, idempotencyKey }
  }

  const ONE_ATTENDANCE = {
    encounters: 1, linkedTo: [null], visits: ['done'],
    prescriptions: 0, followUps: 0, invoices: 1, feeLines: 1, charged: '300.00',
    resolutions: 1, resolutionAudits: 1, completions: 1,
  }

  for (const status of ['waiting', 'in_consult']) {
    test(`the queue cannot put it back to ${status}`, async () => {
      const context = await reconciled()
      await assert.rejects(
        () => as(context.nurse, 'set_appointment_status',
          { appointmentId: context.leftover, status }),
        (error) => {
          assert.equal(error.code, 'VISIT_RECONCILED_AND_CLOSED')
          assert.match(String(error.message), /JMC-/)
          assert.match(String(error.message), /arrive them afresh/)
          return true
        },
      )
      assert.deepEqual(await effectsFor(context.patientId), ONE_ATTENDANCE)
    })
  }

  test('and neither can a hand at the database', async () => {
    const context = await reconciled()
    await assert.rejects(
      () => rows(`update jmc.appointments set status='waiting' where id=$1`, [context.leftover]),
      /recorded as the same attendance/,
    )
    assert.deepEqual(await effectsFor(context.patientId), ONE_ATTENDANCE)
  })

  test('signing it is refused, and says why rather than "already finished"', async () => {
    const context = await reconciled()
    await assert.rejects(
      () => sign(context.doctor, {
        patientId: context.patientId, idempotencyKey: randomUUID(),
        appointmentId: context.leftover, openedVisitId: context.leftover,
      }),
      (error) => {
        assert.equal(error.code, 'VISIT_RECONCILED_AND_CLOSED')
        assert.match(String(error.message), /seen and paid for/)
        return true
      },
    )
    assert.deepEqual(await effectsFor(context.patientId), ONE_ATTENDANCE,
      'one attendance, one encounter, one fee — which is the whole point')
  })

  test('the patient coming back genuinely is not blocked by any of it', async () => {
    const context = await reconciled()
    const returning = await arrive(context.nurse, context.patientId, 'Back a week later')
    const second = await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey: randomUUID(),
      appointmentId: returning, openedVisitId: returning,
    })
    assert.ok(second.data.encounterId)
    const effects = await effectsFor(context.patientId)
    assert.equal(effects.encounters, 2, 'two attendances are two encounters')
    assert.equal(effects.charged, '600.00', 'and two fees, which is correct')
    assert.deepEqual(effects.visits, ['done', 'done'])
  })

  test('and it cannot be cancelled either', async () => {
    /*
     * The first draft of this rule blocked the queue and let `cancelled`
     * through, and this test asserted that as correct. It is not: the
     * determination says the patient was seen at that visit and a cancellation
     * says the visit never happened, and a clinical record that contradicts
     * itself is what owner item 72 exists to prevent. No second fee is
     * reachable that way — signing needs an open visit — which is exactly why
     * it would have gone unnoticed.
     */
    const context = await reconciled()
    await assert.rejects(
      () => as(context.nurse, 'set_appointment_status',
        { appointmentId: context.leftover, status: 'cancelled' }),
      (error) => {
        assert.equal(error.code, 'VISIT_RECONCILED_AND_CLOSED')
        assert.match(String(error.message), /never happened/)
        return true
      },
    )
    await assert.rejects(
      () => rows(`update jmc.appointments set status='cancelled' where id=$1`, [context.leftover]),
      /stays closed/,
    )
    assert.deepEqual(await effectsFor(context.patientId), ONE_ATTENDANCE)

    // Setting it to what it already is changes nothing and is not an error:
    // the determination's own closure is an update this rule has to permit.
    await as(context.nurse, 'set_appointment_status',
      { appointmentId: context.leftover, status: 'done' })
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [context.leftover])),
      'done')
  })

  test('a new attendance subject is deliberately left alone', async () => {
    /*
     * Owner item 74 keeps that visit available for a fresh consultation, so
     * the rule above must not reach it. A guard against over-correction.
     */
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    const second = await arrive(context.nurse, context.patientId, 'Genuinely back')
    await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey, resolution: 'new_attendance',
      subjectVisitId: second, reason: 'He has come back',
    })
    await as(context.nurse, 'set_appointment_status', { appointmentId: second, status: 'in_consult' })
    const signed = await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey: randomUUID(),
      appointmentId: second, openedVisitId: second,
    })
    assert.ok(signed.data.encounterId)
  })
})

describe('a new attendance names the visit that continues', () => {
  /*
   * Owner item 74 is the doctor saying which attendance continues. A
   * determination that names nobody has not said it, and one that names a
   * visit nobody can consult has said something false — the fourth acceptance
   * review recorded both.
   */
  async function patientWith({ committed, arrivals = 1 }) {
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    if (committed) await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    const visits = []
    for (let n = 0; n < arrivals; n += 1) {
      visits.push(await arrive(context.nurse, context.patientId, `Arrival ${n + 1}`))
    }
    return { ...context, idempotencyKey, visits }
  }

  for (const committed of [true, false]) {
    const what = committed ? 'a committed attempt' : 'an attempt that recorded nothing'

    test(`${what}: with a visit open, none named is refused`, async () => {
      const context = await patientWith({ committed })
      await assert.rejects(
        () => resolve(context.doctor, {
          patientId: context.patientId, idempotencyKey: context.idempotencyKey,
          resolution: 'new_attendance', reason: 'He has come back',
        }),
        (error) => {
          assert.equal(error.code, 'SUBJECT_VISIT_REQUIRED')
          assert.match(String(error.message), /JMC-/, 'and it names the token to send')
          assert.match(String(error.message), /come back for/)
          return true
        },
      )
      assert.equal(Number(await scalar(
        'select count(*)::int from jmc.consultation_attempt_resolutions')), 0)
    })

    for (const status of ['cancelled', 'done']) {
      test(`${what}: a ${status} visit is not a consultation still to be done`, async () => {
        const context = await patientWith({ committed })
        const [visit] = context.visits
        await as(context.nurse, 'set_appointment_status', { appointmentId: visit, status })

        await assert.rejects(
          () => resolve(context.doctor, {
            patientId: context.patientId, idempotencyKey: context.idempotencyKey,
            resolution: 'new_attendance', subjectVisitId: visit, reason: 'He has come back',
          }),
          (error) => {
            assert.equal(error.code, 'SUBJECT_VISIT_NOT_OPEN')
            assert.match(String(error.message), /waiting at|arrive them afresh/)
            return true
          },
        )
        assert.equal(Number(await scalar(
          'select count(*)::int from jmc.consultation_attempt_resolutions')), 0,
          'and the reference is unspent')
      })
    }
  }

  test('with no visit open at all, naming none is the honest answer', async () => {
    // A patient opened from the register has no queue row to name, and asking
    // for one would be asking for something that does not exist.
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    const done = await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey,
      resolution: 'new_attendance', reason: 'Starting again',
    })
    assert.equal(done.data.attemptReleased, true)
    assert.equal(done.data.subjectVisitId, undefined)
    assert.equal(done.data.subjectVisitDisposition, 'not_applicable')
  })

  test('with two open, the message names both and the other is untouched', async () => {
    const context = await patientWith({ committed: false, arrivals: 2 })
    const [first, second] = context.visits

    const waiting = await rows(
      `select token from jmc.appointments where id = any($1) order by scheduled_at`,
      [[first, second]])

    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey: context.idempotencyKey,
        resolution: 'new_attendance', reason: 'He has come back',
      }),
      (error) => {
        for (const row of waiting) {
          assert.ok(String(error.message).includes(String(row.token)),
            'both waiting tokens are named, so the doctor can pick one')
        }
        return true
      },
    )

    const done = await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey: context.idempotencyKey,
      resolution: 'new_attendance', subjectVisitId: second, reason: 'This is the one',
    })
    assert.equal(done.data.subjectVisitId, second)
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [first])), 'waiting',
      'the other open visit is untouched')
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [second])), 'waiting',
      'and so is the one it named, because a new attendance keeps it available')
  })

  test('the visit it named is on the row, for every determination that names one', async () => {
    const context = await patientWith({ committed: true })
    const [visit] = context.visits
    await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey: context.idempotencyKey,
      resolution: 'new_attendance', subjectVisitId: visit, reason: 'He has come back',
    })
    const [row] = await rows(
      `select subject_visit_id, subject_visit_closed, subject_visit_disposition
         from jmc.consultation_attempt_resolutions`)
    assert.deepEqual(
      { visit: row.subject_visit_id, closed: row.subject_visit_closed, how: row.subject_visit_disposition },
      { visit, closed: false, how: 'not_applicable' })
  })
})

describe('a closure is something that happened, not something claimed', () => {
  /*
   * Three reviews in a row found this one layer down each time. The schema
   * asked a boolean; then it asked whether an event existed; then whether the
   * event's `to_status` was honest. Each was a better question put to the same
   * untrusted writer, and the fourth review answered it the way that question
   * always gets answered — by writing the row the check was looking for.
   *
   * Its reproduction used THIS FILE's own test as the demonstration: a visit
   * already `done` for unrelated reasons, a `closed_now` resolution beside it
   * and a fabricated `waiting -> done` event, and the test called that "the
   * true one" and asserted it was accepted. It was a forgery and the suite
   * blessed it.
   *
   * So the schema stopped asking. `jmc.close_visit_for_reconciliation()` locks
   * the visit, reads the status, performs the transition and emits the event in
   * one operation, and nothing else may write that event at all. The tests
   * below are about what can no longer be written rather than about what is
   * caught after the fact.
   */
  async function signedAnd(status) {
    const context = await consultingRoom()
    const signed = await sign(context.doctor,
      { patientId: context.patientId, idempotencyKey: randomUUID() })
    const visit = await arrive(context.nurse, context.patientId)
    if (status !== 'waiting') {
      await as(context.nurse, 'set_appointment_status', { appointmentId: visit, status })
    }
    return { ...context, visit, encounterId: signed.data.encounterId }
  }

  const insertResolution = (context, fields) => rows(
    `insert into jmc.consultation_attempt_resolutions
       (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
        encounter_id, subject_visit_id, subject_visit_closed, subject_visit_disposition,
        reason, request_fingerprint)
     values ($1,$2,$3,$4,$5,'committed',$6,$7,$8,$9,'By hand','x')`,
    [fields.id ?? randomUUID(), randomUUID(), context.patientId, context.doctor.id,
      fields.resolution, context.encounterId, context.visit,
      fields.closed, fields.disposition])

  test('a closure event cannot be fabricated beside a visit that never moved', async () => {
    /*
     * The fifth review's reproduction, and the one the fourth round's design
     * could not stop: mark a visit `done` for an unrelated reason, insert a
     * `closed_now` determination, SET THE GUARD YOURSELF — `set_config` is
     * available to every session — and insert a fabricated `waiting -> done`
     * event. A transaction-local setting is a convention, not provenance.
     *
     * There is nothing to set now. Inserting the event is what moves the visit,
     * so an event beside a visit that did not move cannot be written: the visit
     * is already `done` and a closure moves a visit OUT of the queue.
     */
    const context = await signedAnd('done')
    const resolutionId = randomUUID()
    await assert.rejects(
      () => rows(
        `with r as (
           insert into jmc.consultation_attempt_resolutions
             (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
              encounter_id, subject_visit_id, subject_visit_closed, subject_visit_disposition,
              reason, request_fingerprint)
           values ($1,$2,$3,$4,'same_attendance','committed',$5,$6,true,'closed_now','By hand','x')
           returning id
         ), guard as (
           select set_config('jmc.closing_reconciliation', $1, true)
         )
         insert into jmc.appointment_events
           (id, arrival_id, event, from_status, to_status, reason, detail, actor_id, resolution_id)
         select $7, $6, 'closed_on_reconciliation', 'waiting', 'done', 'By hand', 'By hand', $4, r.id
           from r, guard`,
        [resolutionId, randomUUID(), context.patientId, context.doctor.id,
          context.encounterId, context.visit, randomUUID()]),
      /cannot be closed: a closure moves a visit out of the queue/,
    )
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.consultation_attempt_resolutions')), 0)
    assert.equal(Number(await scalar(
      `select count(*)::int from jmc.appointment_events where event='closed_on_reconciliation'`)), 0)
  })

  test('and a closure event cannot put somebody else\u2019s name on the act', async () => {
    /*
     * The function used to take an actor from its caller and believe it. The
     * fifth review closed a doctor's determination with a nurse's id and the
     * event named the nurse — a false name against a clinical act, written by
     * the mechanism that exists to make such acts attributable.
     */
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    const visit = await arrive(context.nurse, context.patientId)
    const resolutionId = randomUUID()

    await assert.rejects(
      () => rows(
        `with r as (
           insert into jmc.consultation_attempt_resolutions
             (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
              encounter_id, subject_visit_id, subject_visit_closed, subject_visit_disposition,
              reason, request_fingerprint)
           select $1,$2,$3,$4,'same_attendance','committed',e.id,$5,true,'closed_now','By hand','x'
             from jmc.encounters e where e.patient_id = $3 limit 1
           returning id
         )
         insert into jmc.appointment_events
           (id, arrival_id, event, from_status, to_status, reason, detail, actor_id, resolution_id)
         select $6, $5, 'closed_on_reconciliation', 'waiting', 'done', 'By hand', 'By hand', $7, r.id
           from r`,
        [resolutionId, randomUUID(), context.patientId, context.doctor.id, visit,
          randomUUID(), context.nurse.id]),
      /A closure is performed by the doctor who determined it/,
    )
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [visit])), 'waiting',
      'and the visit did not move')
  })

  test('a direct writer cannot put its own words in the record', async () => {
    /*
     * The last thing the trigger took on trust. The transition, the visit, the
     * actor and both statuses were all derived; `reason` and `detail` were
     * whatever the writer handed over — so a genuine closure, by the right
     * doctor, could carry a fabricated reason in an append-only clinical
     * record. Owner item 72 keeps the doctor's reason, and this kept whoever's
     * reason arrived.
     */
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    const signed = await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    const visit = await arrive(context.nurse, context.patientId)
    const resolutionId = randomUUID()

    await rows(
      `with r as (
         insert into jmc.consultation_attempt_resolutions
           (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
            encounter_id, subject_visit_id, subject_visit_closed, subject_visit_disposition,
            reason, request_fingerprint)
         values ($1,$2,$3,$4,'same_attendance','committed',$5,$6,true,'closed_now',
                 'He was seen at that visit','x')
         returning id
       )
       insert into jmc.appointment_events
         (id, arrival_id, event, from_status, to_status, reason, detail, actor_id, resolution_id)
       select $7, $6, 'closed_on_reconciliation', 'waiting', 'done',
              'Patient absconded', 'Closed by the night watchman', $4, r.id
         from r`,
      [resolutionId, randomUUID(), context.patientId, context.doctor.id,
        signed.data.encounterId, visit, randomUUID()])

    const [event] = await rows(
      `select reason, detail, actor_id, from_status, to_status from jmc.appointment_events
        where resolution_id = $1 and event='closed_on_reconciliation'`, [resolutionId])
    assert.equal(event.reason, 'He was seen at that visit',
      'the determination’s reason, not the writer’s')
    assert.equal(/absconded|watchman/.test(String(event.detail)), false)
    assert.match(String(event.detail), /^Same attendance as the consultation already signed/)
    assert.equal(event.actor_id, context.doctor.id)
    assert.deepEqual([event.from_status, event.to_status], ['waiting', 'done'])

    // And when the consultation has a prescription, the detail names it.
    const second = await consultingRoom('Second Patient')
    const secondKey = randomUUID()
    const withRx = await sign(second.doctor, {
      patientId: second.patientId, idempotencyKey: secondKey,
      items: [{ medicineId: null, medicineName: 'Paracetamol 500', dose: '1', frequency: 'BD',
        durationDays: 3, quantity: 6, instructions: '' }],
    })
    const secondVisit = await arrive(second.nurse, second.patientId)
    const resolved = await resolve(second.doctor, {
      patientId: second.patientId, idempotencyKey: secondKey, resolution: 'same_attendance',
      subjectVisitId: secondVisit, reason: 'One attendance',
    })
    const [named] = await rows(
      `select detail from jmc.appointment_events where resolution_id = $1`,
      [resolved.data.resolutionId])
    if (withRx.data.prescriptionNumber) {
      assert.match(String(named.detail), new RegExp(String(withRx.data.prescriptionNumber)))
    }
  })

  test('the function takes the determination and nothing else', async () => {
    // Everything the closure records is read from the determination under its
    // own lock, so there is no caller-supplied identity to get wrong.
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    const visit = await arrive(context.nurse, context.patientId)
    const resolved = await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey, resolution: 'same_attendance',
      subjectVisitId: visit, reason: 'One attendance',
    })
    const [event] = await rows(
      `select actor_id, reason, from_status, to_status from jmc.appointment_events
        where resolution_id = $1 and event='closed_on_reconciliation'`, [resolved.data.resolutionId])
    assert.deepEqual(
      { by: event.actor_id, why: event.reason, from: event.from_status, to: event.to_status },
      { by: context.doctor.id, why: 'One attendance', from: 'waiting', to: 'done' },
      'the doctor who determined it, in the words they used')
  })

  test('and a determination claiming a closure it never performed cannot commit', async () => {
    // Without the event it cannot forge, `closed_now` has nothing behind it.
    const context = await signedAnd('done')
    await assert.rejects(
      () => insertResolution(context,
        { resolution: 'same_attendance', closed: true, disposition: 'closed_now' }),
      /no closure event records it doing so/,
    )
  })

  test('the closing function is the way, and it does the whole thing at once', async () => {
    const context = await signedAnd('waiting')
    const resolutionId = randomUUID()
    await insertResolution(context,
      { id: resolutionId, resolution: 'same_attendance', closed: true, disposition: 'closed_now' })
      .then(() => assert.fail('a determination cannot claim a closure before performing it'))
      .catch((error) => assert.match(String(error.message),
        // Either half refuses it: the visit is still in the queue, and there is
        // no event, because nothing has happened to it yet.
        /rather than done|no closure event records it doing so/))

    // In one transaction, the way the command does it: the determination, then
    // the function that performs what it describes.
    await rows(
      `do $$
       declare performed text;
       begin
         insert into jmc.consultation_attempt_resolutions
           (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
            encounter_id, subject_visit_id, subject_visit_closed, subject_visit_disposition,
            reason, request_fingerprint)
         values ('${resolutionId}', '${randomUUID()}', '${context.patientId}', '${context.doctor.id}',
                 'same_attendance', 'committed', '${context.encounterId}', '${context.visit}',
                 true, 'closed_now', 'By hand', 'x');
         performed := jmc.close_visit_for_reconciliation('${resolutionId}');
         if performed <> 'closed_now' then raise exception 'expected closed_now, got %', performed; end if;
       end $$;`)

    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [context.visit])), 'done')
    const [event] = await rows(
      `select from_status, to_status, resolution_id from jmc.appointment_events
        where event='closed_on_reconciliation'`)
    assert.deepEqual(
      { from: event.from_status, to: event.to_status, by: event.resolution_id },
      { from: 'waiting', to: 'done', by: resolutionId },
      'and the event records the transition that actually happened')
  })

  test('the closing function refuses what it cannot close, and says which', async () => {
    const insertFor = (context, visit) => rows(
      `insert into jmc.consultation_attempt_resolutions
         (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
          encounter_id, subject_visit_id, subject_visit_closed, subject_visit_disposition,
          reason, request_fingerprint)
       values ($1,$2,$3,$4,'same_attendance','committed',$5,$6,false,'already_done','By hand','x')`,
      [randomUUID(), randomUUID(), context.patientId, context.doctor.id, context.encounterId, visit])

    // A cancelled visit is ineligible, and the function says so rather than
    // returning a disposition nobody may record.
    const cancelled = await signedAnd('cancelled')
    await assert.rejects(
      () => rows(
        `do $$ declare id text := gen_random_uuid()::text; begin
           insert into jmc.consultation_attempt_resolutions
             (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
              encounter_id, subject_visit_id, subject_visit_closed, subject_visit_disposition,
              reason, request_fingerprint)
           values (id, gen_random_uuid()::text, '${cancelled.patientId}', '${cancelled.doctor.id}',
                   'same_attendance','committed','${cancelled.encounterId}','${cancelled.visit}',
                   false,'already_done','By hand','x');
           perform jmc.close_visit_for_reconciliation(id);
         end $$;`),
      /was cancelled/,
    )

    // And an already-finished visit is reported as such rather than closed.
    const finished = await signedAnd('done')
    await insertFor(finished, finished.visit)
    const [what] = await rows(
      `select jmc.close_visit_for_reconciliation(id) as d
         from jmc.consultation_attempt_resolutions limit 1`)
    assert.equal(what.d, 'already_done')
    assert.equal(Number(await scalar(
      `select count(*)::int from jmc.appointment_events where event='closed_on_reconciliation'`)), 0)
  })

  test('one closure proof per determination, and no more', async () => {
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })
    const visit = await arrive(context.nurse, context.patientId)
    const resolved = await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey, resolution: 'same_attendance',
      subjectVisitId: visit, reason: 'One attendance',
    })
    // The visit is closed now, so a second call performs nothing and the unique
    // index means a second proof could not be recorded even if it did.
    const [again] = await rows('select jmc.close_visit_for_reconciliation($1) as d',
      [resolved.data.resolutionId])
    assert.equal(again.d, 'already_done')
    assert.equal(Number(await scalar(
      `select count(*)::int from jmc.appointment_events
        where event='closed_on_reconciliation' and resolution_id=$1`, [resolved.data.resolutionId])), 1)
  })

  test('the boolean and the disposition cannot disagree', async () => {
    const context = await signedAnd('done')
    await assert.rejects(
      () => insertResolution(context,
        { resolution: 'same_attendance', closed: true, disposition: 'already_done' }),
      /closed_flag_follows_disposition/,
    )
    await assert.rejects(
      () => insertResolution(context,
        { resolution: 'same_attendance', closed: false, disposition: 'closed_now' }),
      /closed_flag_follows_disposition/,
    )
  })

  test('a retrospective link over a done visit is accepted by hand too', async () => {
    const context = await signedAnd('done')
    await insertResolution(context,
      { resolution: 'same_attendance', closed: false, disposition: 'already_done' })
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.consultation_attempt_resolutions')), 1)
  })

  test('a new attendance over a closed visit is refused', async () => {
    const context = await signedAnd('done')
    await assert.rejects(
      () => insertResolution(context,
        { resolution: 'new_attendance', closed: false, disposition: 'not_applicable' }),
      /names the visit still to be consulted/,
    )
  })

  test('an abandoned attempt may not name a visit at all', async () => {
    const context = await signedAnd('done')
    await assert.rejects(
      () => rows(
        `insert into jmc.consultation_attempt_resolutions
           (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
            subject_visit_id, reason, request_fingerprint)
         values ($1,$2,$3,$4,'abandoned_attempt','not_committed',$5,'By hand','x')`,
        [randomUUID(), randomUUID(), context.patientId, context.doctor.id, context.visit]),
      /abandoned_names_no_visit/,
    )
  })
})

describe('a visit consulted on its own is not a visit left finished', () => {
  /*
   * Owner item 75 links retrospectively to a visit that was ALREADY FINISHED.
   * The fourth review described the race that makes that dangerous: a signing
   * under a FRESH reference wins the visit lock, writes its own encounter and
   * its own ₹300, and leaves the visit `done`. The reconciliation then wakes,
   * sees `done`, and records that visit as the same attendance as the earlier
   * consultation.
   *
   * It did not cause the duplicate. It writes a false determination over it and
   * hides the exact condition reconciliation exists to expose, which is worse
   * than leaving it visible.
   */
  test('an already-consulted visit is refused, and the duplicate is left visible', async () => {
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    await sign(context.doctor, { patientId: context.patientId, idempotencyKey })

    // The second signing, under its own reference, against its own visit.
    const second = await arrive(context.nurse, context.patientId, 'Arrived again')
    await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey: randomUUID(),
      appointmentId: second, openedVisitId: second,
    })

    await assert.rejects(
      () => resolve(context.doctor, {
        patientId: context.patientId, idempotencyKey,
        resolution: 'same_attendance', subjectVisitId: second, reason: 'One attendance',
      }),
      (error) => {
        assert.equal(error.code, 'SUBJECT_VISIT_ALREADY_CONSULTED')
        assert.match(String(error.message), /charged twice/)
        return true
      },
    )

    const effects = await effectsFor(context.patientId)
    assert.equal(effects.encounters, 2, 'the duplicate is still there')
    assert.equal(effects.charged, '600.00', 'and still visible as two fees')
    assert.equal(effects.resolutions, 0, 'and nothing was recorded over it')
  })

  test('the database refuses it too, whatever route is taken', async () => {
    const context = await consultingRoom()
    const first = await sign(context.doctor,
      { patientId: context.patientId, idempotencyKey: randomUUID() })
    const second = await arrive(context.nurse, context.patientId, 'Arrived again')
    await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey: randomUUID(),
      appointmentId: second, openedVisitId: second,
    })

    await assert.rejects(
      () => rows(
        `insert into jmc.consultation_attempt_resolutions
           (id, idempotency_key, patient_id, resolved_by, resolution, prior_outcome,
            encounter_id, subject_visit_id, subject_visit_closed, subject_visit_disposition,
            reason, request_fingerprint)
         values ($1,$2,$3,$4,'same_attendance','committed',$5,$6,false,'already_done','By hand','x')`,
        [randomUUID(), randomUUID(), context.patientId, context.doctor.id,
          first.data.encounterId, second]),
      /already has a consultation of its own/,
    )
  })

  test('but a consultation signed against its own visit is the ordinary shape', async () => {
    /*
     * A guard. The encounter this determination is ABOUT must not be counted
     * against it: a doctor who signed with the visit on screen and then had the
     * reply lost is exactly who this control is for.
     */
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    const visit = await arrive(context.nurse, context.patientId)
    await sign(context.doctor, {
      patientId: context.patientId, idempotencyKey, appointmentId: visit, openedVisitId: visit,
    })

    const resolved = await resolve(context.doctor, {
      patientId: context.patientId, idempotencyKey,
      resolution: 'same_attendance', subjectVisitId: visit, reason: 'That was the attendance',
    })
    assert.equal(resolved.data.subjectVisitDisposition, 'already_done')
    const effects = await effectsFor(context.patientId)
    assert.equal(effects.encounters, 1)
    assert.equal(effects.charged, '300.00')
  })
})

describe('who is doing what under this reference', () => {
  /*
   * A resolution holds BOTH advisory namespaces: the resolution lock to
   * serialize against other determinations, and the attempt lock to fail
   * closed against a signing. The read watched the attempt lock alone and
   * said "a consultation is being signed under this reference right now" —
   * about a determination, with nothing being signed at all. The fourth
   * acceptance review reproduced it.
   *
   * Deterministic, because the locks are taken here on the test's own
   * connection rather than raced for.
   */
  async function askWhileHolding(namespaces) {
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    for (const namespace of namespaces) {
      await rows('select pg_advisory_lock($1, hashtext($2))', [namespace, idempotencyKey])
    }
    try {
      const { body } = await edgeGet(
        'workspace', `?view=reconciliation&key=${idempotencyKey}&patientId=${context.patientId}`,
        await tokenFor(context.doctor))
      return body.reconciliation
    } finally {
      for (const namespace of [...namespaces].reverse()) {
        await rows('select pg_advisory_unlock($1, hashtext($2))', [namespace, idempotencyKey])
      }
    }
  }

  test('a determination in flight is not a signing', async () => {
    const seen = await askWhileHolding(
      [ATTEMPT_RESOLUTION_LOCK_NAMESPACE, ATTEMPT_LOCK_NAMESPACE])

    assert.equal(seen.priorOutcome, 'unknown')
    assert.equal(seen.inFlight, 'resolution')
    for (const option of seen.options) {
      assert.equal(option.available, false, option.resolution)
      assert.match(option.detail, /recording a determination/)
      assert.equal(/A consultation is being signed/.test(option.detail), false)
      /*
       * And no code, deliberately: the command WAITS on the resolution lock
       * rather than refusing, so by the time it answers the other doctor has
       * committed and what comes back is a replay or
       * `RECONCILIATION_ALREADY_RESOLVED`. Naming a code would promise a
       * refusal that may not be the one that arrives.
       */
      assert.equal(option.refusalCode, undefined, option.resolution)
    }
  })

  test('a signing in flight still is one', async () => {
    const seen = await askWhileHolding([ATTEMPT_LOCK_NAMESPACE])
    assert.equal(seen.priorOutcome, 'unknown')
    assert.equal(seen.inFlight, 'signing')
    assert.deepEqual(
      seen.options.map((option) => option.refusalCode),
      ['ATTEMPT_OUTCOME_NOT_ESTABLISHED', 'ATTEMPT_OUTCOME_NOT_ESTABLISHED',
        'ATTEMPT_OUTCOME_NOT_ESTABLISHED'])
  })

  test('a signer on one connection is not hidden by a resolver on another', async () => {
    /*
     * The two locks were counted across the whole database, so seeing both
     * meant "a resolution" — which is true when ONE backend holds both, and
     * false when two different people are doing two different things. A doctor
     * signing was reported as "nothing is being signed", which is the one
     * sentence owner item 73 must never produce. The fourth review reproduced
     * it with two connections; the tests here held both on one, so they could
     * not.
     */
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    const signer = postgres(process.env.STAGING_DB_URL, { max: 1 })
    const resolver = postgres(process.env.STAGING_DB_URL, { max: 1 })
    try {
      await signer.unsafe('select pg_advisory_lock($1, hashtext($2))',
        [ATTEMPT_LOCK_NAMESPACE, idempotencyKey])
      await resolver.unsafe('select pg_advisory_lock($1, hashtext($2))',
        [ATTEMPT_RESOLUTION_LOCK_NAMESPACE, idempotencyKey])

      const { body } = await edgeGet(
        'workspace', `?view=reconciliation&key=${idempotencyKey}&patientId=${context.patientId}`,
        await tokenFor(context.doctor))

      assert.equal(body.reconciliation.inFlight, 'signing',
        'somebody is signing, whoever else is also busy')
      for (const option of body.reconciliation.options) {
        assert.equal(option.refusalCode, 'ATTEMPT_OUTCOME_NOT_ESTABLISHED', option.resolution)
        assert.equal(/Nothing is being signed/.test(option.detail), false)
      }
    } finally {
      await resolver.unsafe('select pg_advisory_unlock($1, hashtext($2))',
        [ATTEMPT_RESOLUTION_LOCK_NAMESPACE, idempotencyKey])
      await signer.unsafe('select pg_advisory_unlock($1, hashtext($2))',
        [ATTEMPT_LOCK_NAMESPACE, idempotencyKey])
      await resolver.end()
      await signer.end()
    }
  })

  test('and with nothing running, nothing is claimed to be', async () => {
    const seen = await askWhileHolding([])
    assert.equal(seen.priorOutcome, 'not_committed')
    assert.equal(seen.inFlight, undefined)
  })

  test('the lock is read in this database and not the cluster', async () => {
    /*
     * `pg_locks` is cluster-wide. Two databases on one server — which is
     * exactly how the scratch database sits beside anything else here — would
     * otherwise answer for each other, and a reference nobody in this clinic
     * is touching would read as busy.
     */
    const context = await consultingRoom()
    const idempotencyKey = randomUUID()
    const elsewhere = postgres(process.env.STAGING_DB_URL.replace(/\/[^/]*$/, '/postgres'), { max: 1 })
    try {
      await elsewhere.unsafe('select pg_advisory_lock($1, hashtext($2))',
        [ATTEMPT_LOCK_NAMESPACE, idempotencyKey])
      const { body } = await edgeGet(
        'workspace', `?view=reconciliation&key=${idempotencyKey}&patientId=${context.patientId}`,
        await tokenFor(context.doctor))
      assert.equal(body.reconciliation.inFlight, undefined,
        'another database holding the same key says nothing about this clinic')
      assert.equal(body.reconciliation.priorOutcome, 'not_committed')
    } finally {
      await elsewhere.unsafe('select pg_advisory_unlock($1, hashtext($2))',
        [ATTEMPT_LOCK_NAMESPACE, idempotencyKey])
      await elsewhere.end()
    }
  })
})
