/**
 * The appointment book, against owner policy items 65 to 71.
 *
 * Every test here is named for the clinic behaviour it holds rather than for
 * the function it calls, and each one asserts the whole of what changed rather
 * than the one field its name is about. A booking that lands in the right slot
 * and silently puts a patient in today's queue is not a pass.
 *
 * ── THE PROPERTY THAT RUNS THROUGH ALL OF IT ───────────────────────────────
 *
 * A booking is not a queue row. Owner item 70: "A future booking does not
 * enter the live queue until check-in." So most of these tests end by counting
 * `jmc.appointments` and finding it unchanged, and the ones that do not are
 * the two commands allowed to touch it — `check_in_appointment`, and a
 * cancellation or reschedule of somebody who has already checked in.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, test } from 'node:test'
import { edgeGet } from '../support/backend.mjs'
import {
  as as rawAs, clinicDate, closeClinic, makeStaff, resetClinic, rows, scalar, tokenFor,
} from '../support/clinic.mjs'

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


/**
 * A clinic with one doctor, one nurse, one pharmacist, one patient — and,
 * unless a test says otherwise, published hours.
 *
 * The hours are not decoration. Owner item 71 says a nurse books WITHIN
 * published availability, so a clinic that has published nothing is a clinic
 * where a nurse books nothing and a doctor must justify every appointment as an
 * outside-hours override. That is correct and it is not what most of these
 * tests are about, so the ordinary fixture is a clinic that has opened its
 * doors. The tests that ARE about availability pass `hours: false` and publish
 * exactly what they mean to test.
 */
async function clinic(patientName = 'Booked Patient', { hours = true } = {}) {
  await resetClinic()
  const doctor = await makeStaff({ name: 'Doctor', roles: ['doctor'], username: 'doc', pin: '5731' })
  const nurse = await makeStaff({ name: 'Nurse', roles: ['nurse'], username: 'nur', pin: '5732' })
  const admin = await makeStaff({ name: 'Admin', roles: ['admin'], username: 'adm', pin: '5733' })
  const pharmacist = await makeStaff({ name: 'Pharmacist', roles: ['pharmacy'], username: 'pha', pin: '5734' })
  await as(doctor, 'create_patient', { name: patientName, age: 40, sex: 'male', phone: '+919990000001' })
  const patientId = String(await scalar('select id from jmc.patients where name=$1', [patientName]))
  if (hours) await openEveryDay(doctor)
  return { doctor, nurse, admin, pharmacist, patientId }
}

/** Open every weekday, all day, from a month ago. A clinic with its doors open. */
async function openEveryDay(doctor) {
  const from = await clinicDate(-30)
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
    await as(doctor, 'publish_availability', {
      kind: 'open', weekday: String(weekday), startsAt: '00:00', endsAt: '23:59',
      effectiveFrom: from,
    })
  }
}

/** A time on a clinic day, in the naive local shape the desk form sends. */
async function at(daysAhead, hhmm) {
  return `${await clinicDate(daysAhead)}T${hhmm}`
}

const book = (staff, payload) => as(staff, 'book_appointment', payload)

/** Everything a booking changed, gathered in one place. */
async function effectsFor(patientId) {
  const [counts] = await rows(
    `select
       (select count(*)::int from jmc.appointment_bookings where patient_id=$1) as bookings,
       (select count(*)::int from jmc.appointments where patient_id=$1) as arrivals,
       (select count(*)::int from jmc.encounters where patient_id=$1) as encounters,
       (select count(*)::int from jmc.invoices where patient_id=$1) as invoices`,
    [patientId],
  )
  const events = await rows(
    `select e.event from jmc.appointment_events e
      left join jmc.appointment_bookings b on b.id = e.booking_id
      left join jmc.appointments a on a.id = e.arrival_id
      where coalesce(b.patient_id, a.patient_id) = $1
      order by e.created_at, e.id`,
    [patientId],
  )
  return {
    bookings: counts.bookings,
    arrivals: counts.arrivals,
    encounters: counts.encounters,
    invoices: counts.invoices,
    events: events.map((row) => row.event),
  }
}

describe('owner item 65: how long an appointment is', () => {
  test('a booking with no type is the clinic default of fifteen minutes', async () => {
    const { doctor, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(1, '10:00') })

    assert.equal(
      Number(await scalar('select duration_minutes from jmc.appointment_bookings')), 15,
      'owner item 65: fifteen minutes unless a type says otherwise')
  })

  test('a type carries its own duration onto the booking', async () => {
    const { doctor, patientId } = await clinic()
    const created = await as(doctor, 'create_appointment_type',
      { name: 'Long review', durationMinutes: 30 })
    await book(doctor, {
      patientId, reason: 'Review', scheduledAt: await at(1, '10:00'),
      appointmentTypeId: created.data.appointmentTypeId,
    })

    assert.equal(Number(await scalar('select duration_minutes from jmc.appointment_bookings')), 30)
  })

  test('changing the type afterwards does not rewrite a booking already made', async () => {
    const { doctor, patientId } = await clinic()
    const created = await as(doctor, 'create_appointment_type',
      { name: 'Long review', durationMinutes: 30 })
    await book(doctor, {
      patientId, reason: 'Review', scheduledAt: await at(1, '10:00'),
      appointmentTypeId: created.data.appointmentTypeId,
    })

    await as(doctor, 'update_appointment_type',
      { appointmentTypeId: created.data.appointmentTypeId, durationMinutes: 45 })

    assert.equal(
      Number(await scalar('select duration_minutes from jmc.appointment_bookings')), 30,
      'owner item 65: "A type change does not rewrite the duration already recorded"')
    assert.equal(
      Number(await scalar('select duration_minutes from jmc.appointment_types')), 45,
      'and the type itself did change, or the test is proving nothing')
  })

  test('a nurse cannot create or change an appointment type', async () => {
    const { nurse } = await clinic()
    await assert.rejects(() => as(nurse, 'create_appointment_type', { name: 'Anything' }),
      /role cannot perform/)
  })
})

describe('owner item 66: how far ahead the clinic books', () => {
  test('ninety clinic days ahead is accepted', async () => {
    const { doctor, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Review', scheduledAt: await at(90, '10:00') })
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1)
  })

  test('ninety-one is refused, and the refusal says how far away it is', async () => {
    const { doctor, patientId } = await clinic()
    const tooFar = await at(91, '10:00')
    await assert.rejects(
      () => book(doctor, { patientId, reason: 'Review', scheduledAt: tooFar }),
      /91 days away and the clinic books 90 days ahead/,
    )
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 0)
  })

  test('yesterday is refused; today is not', async () => {
    const { doctor, patientId } = await clinic()
    const yesterday = await at(-1, '10:00')
    await assert.rejects(
      () => book(doctor, { patientId, reason: 'Review', scheduledAt: yesterday }),
      /in the past/,
    )
    // Today at midnight is already behind by the time any test runs, and that
    // is deliberately allowed: a patient booked for 10:00 and written in at
    // 10:05 is the ordinary shape of a busy morning.
    await book(doctor, { patientId, reason: 'Review', scheduledAt: await at(0, '00:01') })
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1)
  })

  test('the same horizon applies to a reschedule', async () => {
    const { doctor, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Review', scheduledAt: await at(1, '10:00') })
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))

    const tooFar = await at(91, '10:00')
    await assert.rejects(
      () => as(doctor, 'reschedule_appointment',
        { bookingId, scheduledAt: tooFar, reason: 'Patient asked' }),
      /books 90 days ahead/,
    )
  })

  test('a naive time is read as the clinic’s, not as the server’s', async () => {
    const { doctor, patientId } = await clinic()
    const day = await clinicDate(1)
    await book(doctor, { patientId, reason: 'Review', scheduledAt: `${day}T09:15` })

    const back = String(await scalar(
      `select to_char(scheduled_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')
         from jmc.appointment_bookings`))
    assert.equal(back, `${day} 09:15`,
      'the server runs five and a half hours behind the clinic and must not move the appointment')
  })
})

describe('owner item 67: overbooking is off by default', () => {
  async function twoAtTen() {
    const context = await clinic()
    await as(context.doctor, 'create_patient',
      { name: 'Second Patient', age: 22, sex: 'female', phone: '+919990000002' })
    const secondId = String(await scalar('select id from jmc.patients where name=$1', ['Second Patient']))
    const slot = await at(1, '10:00')
    await book(context.doctor, { patientId: context.patientId, reason: 'Fever', scheduledAt: slot })
    return { ...context, secondId, slot }
  }

  test('a nurse meets an occupied slot and is told who has it', async () => {
    const { nurse, secondId, slot } = await twoAtTen()
    await assert.rejects(
      () => book(nurse, { patientId: secondId, reason: 'Cough', scheduledAt: slot }),
      (error) => {
        assert.equal(error.code, 'SLOT_ALREADY_TAKEN')
        assert.match(String(error.message), /Booked Patient already has that time/)
        return true
      },
    )
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1)
  })

  test('a nurse cannot overbook even with a reason', async () => {
    const { nurse, secondId, slot } = await twoAtTen()
    await assert.rejects(
      () => book(nurse, {
        patientId: secondId, reason: 'Cough', scheduledAt: slot,
        overrideReason: 'The doctor said it was fine',
      }),
      (error) => {
        assert.equal(error.code, 'SLOT_ALREADY_TAKEN')
        return true
      },
      'owner item 67: "A nurse cannot overbook."',
    )
  })

  test('a doctor without a reason is asked for one rather than refused outright', async () => {
    const { doctor, secondId, slot } = await twoAtTen()
    await assert.rejects(
      () => book(doctor, { patientId: secondId, reason: 'Cough', scheduledAt: slot }),
      (error) => {
        assert.equal(error.code, 'OVERRIDE_REASON_REQUIRED')
        assert.match(String(error.message), /Overbooking is off by default/)
        return true
      },
    )
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1)
  })

  test('a doctor with a reason may overbook, and the reason is on the record', async () => {
    const { doctor, secondId, slot } = await twoAtTen()
    const result = await book(doctor, {
      patientId: secondId, reason: 'Cough', scheduledAt: slot,
      overrideReason: 'Child with a high fever, seeing both together',
    })

    assert.equal(result.data.overbooked, true)
    const [placed] = await rows(
      `select overbooked, overbooked_reason, booked_by from jmc.appointment_bookings
        where patient_id = $1`, [secondId])
    assert.equal(placed.overbooked, true)
    assert.equal(placed.overbooked_reason, 'Child with a high fever, seeing both together')
    assert.equal(placed.booked_by, doctor.id, 'owner item 67: the actor is recorded')

    const [event] = await rows(
      `select e.overbooked, e.override_reason from jmc.appointment_events e
         join jmc.appointment_bookings b on b.id = e.booking_id
        where b.patient_id = $1`, [secondId])
    assert.equal(event.overbooked, true)
    assert.equal(event.override_reason, 'Child with a high fever, seeing both together',
      'the override is columns of its own now, not a sentence buried in a detail string')
  })

  test('two bookings for one slot in the same breath produce one overbooking decision', async () => {
    /*
     * The conflict check is inside the write transaction, under an advisory
     * lock on the doctor. Without the lock both callers read an empty slot,
     * both find no conflict, and the clinic ends the morning holding two
     * appointments neither of which was recorded as an override — which is
     * exactly the case owner item 67 exists to make visible.
     */
    const { doctor, secondId } = await twoAtTen()
    await as(doctor, 'create_patient',
      { name: 'Third Patient', age: 55, sex: 'male', phone: '+919990000003' })
    const thirdId = String(await scalar('select id from jmc.patients where name=$1', ['Third Patient']))
    // A slot nobody has booked yet, on a day nothing else in this test touches.
    // Nothing is deleted to make room: `appointment_events` is append-only by
    // trigger, and a test that tears down history is a test that would hide
    // exactly the rows it is here to check.
    const later = await at(2, '11:00')
    const before = Number(await scalar('select count(*)::int from jmc.appointment_bookings'))

    const both = await Promise.allSettled([
      book(doctor, { patientId: secondId, reason: 'Cough', scheduledAt: later }),
      book(doctor, { patientId: thirdId, reason: 'Rash', scheduledAt: later }),
    ])

    const succeeded = both.filter((outcome) => outcome.status === 'fulfilled')
    const refused = both.filter((outcome) => outcome.status === 'rejected')
    assert.equal(succeeded.length, 1, 'exactly one may take an empty slot without an override')
    assert.equal(refused.length, 1)
    assert.equal(refused[0].reason.code, 'OVERRIDE_REASON_REQUIRED',
      'and the loser is told the slot is taken rather than quietly sharing it')
    assert.equal(
      Number(await scalar('select count(*)::int from jmc.appointment_bookings')), before + 1)
  })
})

describe('owner item 68: cancelling and rescheduling', () => {
  async function booked(staff, context, daysAhead = 1) {
    await book(staff, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(daysAhead, '10:00'),
    })
    return String(await scalar('select id from jmc.appointment_bookings order by created_at desc limit 1'))
  }

  test('a nurse may cancel before check-in, and nothing is deleted', async () => {
    const context = await clinic()
    const bookingId = await booked(context.doctor, context)

    await as(context.nurse, 'cancel_appointment', { bookingId, reason: 'Patient telephoned' })

    const [row] = await rows('select status from jmc.appointment_bookings where id=$1', [bookingId])
    assert.equal(row.status, 'cancelled')
    const [event] = await rows(
      `select event, from_status, to_status, reason, actor_id from jmc.appointment_events
        where booking_id=$1 and event='cancelled'`, [bookingId])
    assert.deepEqual(
      { event: event.event, from: event.from_status, to: event.to_status, reason: event.reason, by: event.actor_id },
      {
        event: 'cancelled', from: 'booked', to: 'cancelled',
        reason: 'Patient telephoned', by: context.nurse.id,
      },
      'owner item 68: "the prior state, actor, time, and reason remain in append-only history"')
  })

  test('a reschedule keeps the previous time in the history', async () => {
    const context = await clinic()
    const bookingId = await booked(context.doctor, context)
    const before = String(await scalar('select scheduled_at from jmc.appointment_bookings where id=$1', [bookingId]))

    await as(context.nurse, 'reschedule_appointment', {
      bookingId, scheduledAt: await at(3, '11:30'), reason: 'Patient asked for a later day',
    })

    const [event] = await rows(
      `select scheduled_at_before, scheduled_at_after, reason from jmc.appointment_events
        where booking_id=$1 and event='rescheduled'`, [bookingId])
    assert.equal(new Date(event.scheduled_at_before).toISOString(), new Date(before).toISOString())
    assert.notEqual(
      new Date(event.scheduled_at_after).toISOString(), new Date(before).toISOString())
    assert.equal(event.reason, 'Patient asked for a later day')
    assert.equal(
      String(await scalar('select status from jmc.appointment_bookings where id=$1', [bookingId])), 'booked')
  })

  test('after check-in a nurse is refused and a doctor is not', async () => {
    const context = await clinic()
    const bookingId = await booked(context.doctor, context, 0)
    await as(context.nurse, 'check_in_appointment', { bookingId })

    await assert.rejects(
      () => as(context.nurse, 'cancel_appointment', { bookingId, reason: 'Patient left' }),
      (error) => {
        assert.equal(error.code, 'CHECKED_IN_ALREADY')
        return true
      },
      'owner item 68: after check-in, only doctor or admin',
    )

    await as(context.doctor, 'cancel_appointment', { bookingId, reason: 'Patient left before being seen' })
    assert.equal(
      String(await scalar('select status from jmc.appointment_bookings where id=$1', [bookingId])), 'cancelled')
  })

  test('cancelling after check-in takes the patient out of the queue too', async () => {
    const context = await clinic()
    const bookingId = await booked(context.doctor, context, 0)
    await as(context.nurse, 'check_in_appointment', { bookingId })
    const arrivalId = String(await scalar(
      'select id from jmc.appointments where booking_id=$1', [bookingId]))

    await as(context.doctor, 'cancel_appointment', { bookingId, reason: 'Patient left before being seen' })

    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [arrivalId])), 'cancelled',
      'a queue that still holds somebody who has gone home is a queue that is wrong about the building')
    const [event] = await rows(
      `select reason, detail from jmc.appointment_events where arrival_id=$1 and event='cancelled'`,
      [arrivalId])
    assert.equal(event.reason, 'Patient left before being seen')
  })

  test('a visit whose consultation is signed cannot be cancelled', async () => {
    const context = await clinic()
    const bookingId = await booked(context.doctor, context, 0)
    await as(context.nurse, 'check_in_appointment', { bookingId })
    const arrivalId = String(await scalar(
      'select id from jmc.appointments where booking_id=$1', [bookingId]))
    await as(context.doctor, 'sign_consultation', {
      patientId: context.patientId, appointmentId: arrivalId,
      complaint: 'Fever', diagnosis: 'Viral fever', notes: '', advice: 'Rest',
    })

    await assert.rejects(
      () => as(context.doctor, 'cancel_appointment', { bookingId, reason: 'Changed my mind' }),
      (error) => {
        assert.equal(error.code, 'VISIT_ALREADY_FINISHED')
        return true
      },
    )
    assert.equal(
      String(await scalar('select status from jmc.appointments where id=$1', [arrivalId])), 'done',
      'and the signed visit is untouched')
  })

  test('a cancelled appointment cannot be moved, and cancelling it again is a repeat', async () => {
    const context = await clinic()
    const bookingId = await booked(context.doctor, context)
    await as(context.doctor, 'cancel_appointment', { bookingId, reason: 'Patient telephoned' })

    const laterDay = await at(2, '10:00')
    await assert.rejects(
      () => as(context.doctor, 'reschedule_appointment',
        { bookingId, scheduledAt: laterDay, reason: 'Again' }),
      (error) => {
        assert.equal(error.code, 'APPOINTMENT_CLOSED')
        return true
      },
      'moving a closed record is two acts disagreeing',
    )

    /*
     * Cancelling it again under a NEW reference is a second act, and a second
     * act on a closed booking is a conflict. A RETRY — the same reference — is
     * what replays, and that is the block below on receipts.
     *
     * Slice 2 had this the other way round: it read the booking's current
     * status and called any repeat a duplicate, which meant a genuinely new
     * request and a lost reply were indistinguishable.
     */
    await assert.rejects(
      () => as(context.doctor, 'cancel_appointment', { bookingId, reason: 'Again' }),
      (error) => {
        assert.equal(error.code, 'APPOINTMENT_CLOSED')
        return true
      },
    )
    assert.equal(Number(await scalar(
      `select count(*)::int from jmc.appointment_events
        where booking_id=$1 and event='cancelled'`, [bookingId])), 1,
      'one act, one history row')
  })

  test('the same request under the same reference is one move', async () => {
    /*
     * Slice 2 decided this by comparing the booking's CURRENT time, which is
     * the heuristic the acceptance correction removed: it made a lost reply
     * and a deliberate re-request indistinguishable, and it silently ignored a
     * request that changed the appointment type at the same time. The
     * reference decides now.
     */
    const context = await clinic()
    const bookingId = await booked(context.doctor, context)
    const day = await at(3, '11:30')
    const idempotencyKey = randomUUID()
    const request = {
      bookingId, scheduledAt: day, reason: 'Patient asked for a later day', idempotencyKey,
    }

    const first = await as(context.doctor, 'reschedule_appointment', request)
    const second = await as(context.doctor, 'reschedule_appointment', request)

    assert.equal(first.data.duplicate, undefined)
    assert.equal(second.data.duplicate, true)
    assert.equal(Number(await scalar(
      `select count(*)::int from jmc.appointment_events
        where booking_id=$1 and event='rescheduled'`, [bookingId])), 1,
      'the history must not say it was moved twice')
  })
})

describe('owner item 69: what a no-show is', () => {
  test('nothing marks one automatically', async () => {
    const { doctor, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(-0, '00:01') })

    // The booking is hours past its time. Nothing in the clinic runs on a
    // timer, so it is still `booked` and stays `booked` until somebody says
    // otherwise. This test fails the day anybody adds a sweep.
    assert.equal(String(await scalar('select status from jmc.appointment_bookings')), 'booked')
  })

  test('a no-show cannot be confirmed inside the first half hour', async () => {
    const { doctor, patientId } = await clinic()
    await rows(
      `insert into jmc.appointment_bookings
         (id, patient_id, doctor_id, scheduled_at, duration_minutes, reason, status, booked_by)
       values ($1,$2,$3, now() - interval '20 minutes', 15, 'Fever', 'booked', $3)`,
      [randomUUID(), patientId, doctor.id],
    )
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))

    await assert.rejects(
      () => as(doctor, 'mark_no_show', { bookingId }),
      (error) => {
        assert.equal(error.code, 'TOO_EARLY_FOR_NO_SHOW')
        assert.match(String(error.message), /30 minutes after that/)
        return true
      },
      'owner item 69: eligible thirty minutes after the scheduled start',
    )
    assert.equal(String(await scalar('select status from jmc.appointment_bookings')), 'booked')
  })

  test('after half an hour a nurse may confirm it, and it is recorded against them', async () => {
    const { doctor, nurse, patientId } = await clinic()
    await rows(
      `insert into jmc.appointment_bookings
         (id, patient_id, doctor_id, scheduled_at, duration_minutes, reason, status, booked_by)
       values ($1,$2,$3, now() - interval '40 minutes', 15, 'Fever', 'booked', $3)`,
      [randomUUID(), patientId, doctor.id],
    )
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))

    await as(nurse, 'mark_no_show', { bookingId, reason: 'Nobody came' })

    assert.equal(String(await scalar('select status from jmc.appointment_bookings')), 'no_show')
    const [event] = await rows(
      `select actor_id, reason, from_status, to_status from jmc.appointment_events
        where booking_id=$1 and event='no_show'`, [bookingId])
    assert.deepEqual(
      { by: event.actor_id, reason: event.reason, from: event.from_status, to: event.to_status },
      { by: nurse.id, reason: 'Nobody came', from: 'booked', to: 'no_show' })
  })

  test('confirming a no-show twice is a repeat, and writes one history row', async () => {
    const { doctor, nurse, patientId } = await clinic()
    await rows(
      `insert into jmc.appointment_bookings
         (id, patient_id, doctor_id, scheduled_at, duration_minutes, reason, status, booked_by)
       values ($1,$2,$3, now() - interval '40 minutes', 15, 'Fever', 'booked', $3)`,
      [randomUUID(), patientId, doctor.id],
    )
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))

    const idempotencyKey = randomUUID()
    await as(nurse, 'mark_no_show', { bookingId, reason: 'Nobody came', idempotencyKey })

    // The retry: same reference, replayed, nothing written.
    const retry = await as(nurse, 'mark_no_show', { bookingId, reason: 'Nobody came', idempotencyKey })
    assert.equal(retry.data.duplicate, true)

    // A second, genuinely new request on a closed booking is a conflict.
    await assert.rejects(
      () => as(nurse, 'mark_no_show', { bookingId, reason: 'Nobody came' }),
      (error) => {
        assert.equal(error.code, 'APPOINTMENT_CLOSED')
        return true
      },
    )
    assert.equal(Number(await scalar(
      `select count(*)::int from jmc.appointment_events
        where booking_id=$1 and event='no_show'`, [bookingId])), 1)
  })

  test('a patient who checked in did not fail to attend', async () => {
    const context = await clinic()
    await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(0, '00:01'),
    })
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))
    await as(context.nurse, 'check_in_appointment', { bookingId })

    await assert.rejects(
      () => as(context.nurse, 'mark_no_show', { bookingId }),
      (error) => {
        assert.equal(error.code, 'APPOINTMENT_CLOSED')
        assert.match(String(error.message), /did not fail to attend/)
        return true
      },
    )
  })
})

describe('owner item 70: one queue, ordered by when people actually arrived', () => {
  test('a booking is not in the queue until it is checked in', async () => {
    const { doctor, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(0, '09:00') })

    assert.deepEqual(await effectsFor(patientId), {
      bookings: 1, arrivals: 0, encounters: 0, invoices: 0, events: ['booked'],
    }, 'owner item 70: "A future booking does not enter the live queue until check-in"')
  })

  test('check-in makes an ordinary queue row, with a token from the same series', async () => {
    const { doctor, nurse, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(0, '09:00') })
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))

    const result = await as(nurse, 'check_in_appointment', { bookingId })

    assert.match(result.data.token, /^JMC-\d{4,}$/)
    const [arrival] = await rows(
      `select token, status, reason, booking_id, scheduled_at from jmc.appointments where patient_id=$1`,
      [patientId])
    assert.equal(arrival.status, 'waiting')
    assert.equal(arrival.reason, 'Fever', 'the reason travels from the booking onto the queue row')
    assert.equal(arrival.booking_id, bookingId)
    assert.match(arrival.scheduled_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      'the queue orders on this column as TEXT, so every writer must use one shape')

    assert.deepEqual(await effectsFor(patientId), {
      bookings: 1, arrivals: 1, encounters: 0, invoices: 0, events: ['booked', 'checked_in'],
    })
  })

  test('a patient booked for nine and arriving at eleven goes behind the walk-in who came at ten', async () => {
    const context = await clinic('Booked Nine')
    await as(context.doctor, 'create_patient',
      { name: 'Walked In Ten', age: 30, sex: 'female', phone: '+919990000004' })
    const walkInId = String(await scalar('select id from jmc.patients where name=$1', ['Walked In Ten']))

    await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(0, '09:00'),
    })
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))

    // The walk-in turns up first.
    await as(context.nurse, 'create_appointment',
      { patientId: walkInId, reason: 'Cough', scheduledAt: new Date().toISOString() })
    // The booked patient turns up afterwards.
    await as(context.nurse, 'check_in_appointment', { bookingId })

    const queue = await rows(
      `select p.name from jmc.appointments a join jmc.patients p on p.id = a.patient_id
        where a.status = 'waiting' order by a.urgent desc, a.scheduled_at`)
    assert.deepEqual(queue.map((row) => row.name), ['Walked In Ten', 'Booked Nine'],
      'owner item 70: ordered by actual arrival, not by the time they were booked for')
  })

  test('checking in twice returns the same token and adds nothing', async () => {
    const { doctor, nurse, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(0, '09:00') })
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))

    const idempotencyKey = randomUUID()
    const first = await as(nurse, 'check_in_appointment', { bookingId, idempotencyKey })
    const second = await as(nurse, 'check_in_appointment', { bookingId, idempotencyKey })

    assert.equal(second.data.token, first.data.token)
    assert.equal(second.data.arrivalId, first.data.arrivalId)
    assert.equal(second.data.duplicate, true)
    assert.equal(second.data.superseded, false, 'and it still stands')

    // A second, genuinely new check-in of a patient already in the queue is a
    // conflict rather than a repeat: two references are two requests.
    await assert.rejects(
      () => as(nurse, 'check_in_appointment', { bookingId }),
      (error) => {
        assert.equal(error.code, 'CHECKED_IN_ALREADY')
        return true
      },
    )
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.appointments where patient_id=$1', [patientId])), 1)
  })

  test('one reference sent twice in the same breath makes one queue entry', async () => {
    /*
     * A double tap, or a retry racing the request it is retrying. One person,
     * one reference: the same staff member, because the reference names one
     * attempt by one person and the test below is the other case.
     */
    const { doctor, nurse, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(0, '09:00') })
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))

    const idempotencyKey = randomUUID()
    const both = await Promise.allSettled([
      as(nurse, 'check_in_appointment', { bookingId, idempotencyKey }),
      as(nurse, 'check_in_appointment', { bookingId, idempotencyKey }),
    ])

    assert.deepEqual(both.map((outcome) => outcome.status), ['fulfilled', 'fulfilled'],
      `neither caller is shown a constraint name; both are told what the clinic holds: ${
        both.filter((o) => o.status === 'rejected').map((o) => o.reason?.code ?? o.reason?.message)}`)
    const tokens = new Set(both.map((outcome) => outcome.value.data.token))
    assert.equal(tokens.size, 1, 'one arrival, one token')
    assert.equal(
      both.filter((outcome) => outcome.value.data.duplicate === true).length, 1,
      'and exactly one of the two is told it was a repeat')
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.appointments where patient_id=$1', [patientId])), 1)
  })

  test('two people sharing one reference is a reused reference, not a retry', async () => {
    /*
     * The reference names one attempt by one person, so the actor is part of
     * what it names. Two staff sending the same one is the same client fault
     * as two different requests sending it: answering the second with the
     * first's outcome would attribute a check-in to the wrong person.
     */
    const { doctor, nurse, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(0, '09:00') })
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))
    const idempotencyKey = randomUUID()

    await as(nurse, 'check_in_appointment', { bookingId, idempotencyKey })
    await assert.rejects(
      () => as(doctor, 'check_in_appointment', { bookingId, idempotencyKey }),
      (error) => {
        assert.equal(error.code, 'APPOINTMENT_REFERENCE_REUSED')
        return true
      },
    )
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.appointments where patient_id=$1', [patientId])), 1)
  })

  test('check-in writes the audit event a nurse’s image access is derived from', async () => {
    /*
     * `jmc.nurse_care_involvement` derives "this nurse was involved in that
     * patient's care" partly from `entity_type='appointment'` and
     * `action='appointment.created'`, because the queue table records no
     * author. A check-in writing a different action would quietly deny a nurse
     * access to the clinical images of every patient they arrived through the
     * calendar.
     */
    const { doctor, nurse, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(0, '09:00') })
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))
    await as(nurse, 'check_in_appointment', { bookingId })

    const [involvement] = await rows(
      `select involvement from jmc.nurse_care_involvement where nurse_id=$1 and patient_id=$2`,
      [nurse.id, patientId])
    assert.equal(involvement?.involvement, 'arrival')
  })

  test('a doctor may move an urgent patient up, with a reason on the record', async () => {
    const context = await clinic('First In')
    await as(context.doctor, 'create_patient',
      { name: 'Came Later', age: 8, sex: 'male', phone: '+919990000005' })
    const laterId = String(await scalar('select id from jmc.patients where name=$1', ['Came Later']))

    await as(context.nurse, 'create_appointment',
      { patientId: context.patientId, reason: 'Cough', scheduledAt: new Date().toISOString() })
    await as(context.nurse, 'create_appointment',
      { patientId: laterId, reason: 'High fever', scheduledAt: new Date().toISOString() })
    const laterArrival = String(await scalar(
      'select id from jmc.appointments where patient_id=$1', [laterId]))

    await as(context.doctor, 'set_queue_priority',
      { appointmentId: laterArrival, reason: 'Child with a fever of 40' })

    const queue = await rows(
      `select p.name from jmc.appointments a join jmc.patients p on p.id = a.patient_id
        where a.status = 'waiting' order by a.urgent desc, a.urgent_at, a.scheduled_at`)
    assert.deepEqual(queue.map((row) => row.name), ['Came Later', 'First In'])

    const [row] = await rows(
      'select urgent, urgent_reason, urgent_by from jmc.appointments where id=$1', [laterArrival])
    assert.deepEqual(
      { urgent: row.urgent, reason: row.urgent_reason, by: row.urgent_by },
      { urgent: true, reason: 'Child with a fever of 40', by: context.doctor.id })

    const [audited] = await rows(
      `select summary from jmc.audit_events where action='appointment.prioritized'`)
    assert.match(audited.summary, /Child with a fever of 40/)
  })

  test('a nurse and an administrator cannot move a patient up the queue', async () => {
    const context = await clinic()
    await as(context.nurse, 'create_appointment',
      { patientId: context.patientId, reason: 'Cough', scheduledAt: new Date().toISOString() })
    const arrivalId = String(await scalar('select id from jmc.appointments'))

    for (const staff of [context.nurse, context.admin, context.pharmacist]) {
      await assert.rejects(
        () => as(staff, 'set_queue_priority', { appointmentId: arrivalId, reason: 'Looks unwell' }),
        /role cannot perform/,
        `${staff.name} must not make a clinical judgement about who is sicker`)
    }
  })

  test('urgency reaches the snapshot as a flag, and the reason does not', async () => {
    const context = await clinic()
    await as(context.nurse, 'create_appointment',
      { patientId: context.patientId, reason: 'Cough', scheduledAt: new Date().toISOString() })
    const arrivalId = String(await scalar('select id from jmc.appointments'))
    await as(context.doctor, 'set_queue_priority',
      { appointmentId: arrivalId, reason: 'Chest pain, looks grey' })

    const { readSnapshot } = await import('../../supabase/functions/_shared/snapshot.ts')
    const seen = await readSnapshot({
      staffId: context.pharmacist.id, name: 'Pharmacist', username: 'pha',
      roles: ['pharmacy'], lastSeen: new Date().toISOString(),
      canPublishClinicalTemplates: false, theme: 'paper',
    })
    const row = seen.appointments.find((item) => item.id === arrivalId)
    assert.equal(row.urgent, true, 'the counter can order a queue it is shown')
    assert.equal(
      JSON.stringify(seen).includes('Chest pain'), false,
      'and the WHOLE snapshot, not just the row, is free of the clinical sentence; '
      + 'asserting the mapped row only re-states the two lines above it')
  })
})

describe('owner item 71: who owns availability', () => {
  async function published(doctor) {
    // Every weekday, nine to one, from today.
    const ids = []
    for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
      const window = await as(doctor, 'publish_availability', {
        kind: 'open', weekday: String(weekday), startsAt: '09:00', endsAt: '13:00',
      })
      ids.push(window.data.availabilityId)
    }
    return ids
  }

  test('a nurse cannot publish or retire availability', async () => {
    const { nurse } = await clinic('Booked Patient', { hours: false })
    await assert.rejects(
      () => as(nurse, 'publish_availability',
        { kind: 'open', weekday: '1', startsAt: '09:00', endsAt: '13:00' }),
      /role cannot perform/)
  })

  test('with nothing published a nurse books nothing at all', async () => {
    /*
     * Slice 2 let a nurse book ANY hour of a day with no published window, on
     * the reasoning that item 71 would otherwise refuse them everything until
     * somebody drew a timetable. The acceptance review reproduced a nurse
     * booking a patient for three in the morning and pointed at the policy,
     * which says "within published availability" and admits no exception.
     *
     * The clinic is not locked out. A doctor or an admin books it, with the
     * recorded override the next test checks, and publishing hours is simply
     * the first thing a clinic does.
     */
    const { doctor, nurse, patientId } = await clinic('Booked Patient', { hours: false })
    const threeInTheMorning = await at(1, '03:00')

    await assert.rejects(
      () => book(nurse, { patientId, reason: 'Fever', scheduledAt: threeInTheMorning }),
      (error) => {
        assert.equal(error.code, 'OUTSIDE_PUBLISHED_AVAILABILITY')
        return true
      },
    )
    // Not even with a reason: owner item 67 gives a nurse no override at all.
    await assert.rejects(
      () => book(nurse, {
        patientId, reason: 'Fever', scheduledAt: threeInTheMorning,
        overrideReason: 'The doctor said it was fine',
      }),
      (error) => {
        assert.equal(error.code, 'OUTSIDE_PUBLISHED_AVAILABILITY')
        return true
      },
    )
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 0)

    // The doctor's route, which is what keeps the clinic working on day one.
    const placed = await book(doctor, {
      patientId, reason: 'Fever', scheduledAt: threeInTheMorning,
      overrideReason: 'Nothing published yet; seeing them before the morning clinic',
    })
    assert.equal(placed.data.outsideAvailability, true)
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1)
  })

  test('a nurse rescheduling is held to the published hours too', async () => {
    const { doctor, nurse, patientId } = await clinic('Booked Patient', { hours: false })
    const day = await clinicDate(2)
    const weekday = String(await scalar(`select extract(dow from $1::date)::int`, [day]))
    await as(doctor, 'publish_availability',
      { kind: 'open', weekday, startsAt: '09:00', endsAt: '13:00' })

    const booking = await book(nurse, {
      patientId, reason: 'Fever', scheduledAt: `${day}T10:00`,
    })
    const outside = `${day}T22:30`

    await assert.rejects(
      () => as(nurse, 'reschedule_appointment', {
        bookingId: booking.data.bookingId, scheduledAt: outside, reason: 'Patient asked',
      }),
      (error) => {
        assert.equal(error.code, 'OUTSIDE_PUBLISHED_AVAILABILITY')
        return true
      },
      'owner item 71 governs rescheduling in the same sentence as booking')

    // And inside them is fine.
    await as(nurse, 'reschedule_appointment', {
      bookingId: booking.data.bookingId, scheduledAt: `${day}T11:00`, reason: 'Patient asked',
    })
    assert.equal(
      String(await scalar(
        `select to_char(scheduled_at at time zone 'Asia/Kolkata', 'HH24:MI')
           from jmc.appointment_bookings`)),
      '11:00')
  })

  test('once hours are published a nurse books inside them and is refused outside', async () => {
    const { doctor, nurse, patientId } = await clinic('Booked Patient', { hours: false })
    await published(doctor)

    await book(nurse, { patientId, reason: 'Fever', scheduledAt: await at(1, '10:00') })
    const lateEvening = await at(2, '22:30')
    await assert.rejects(
      () => book(nurse, { patientId, reason: 'Fever', scheduledAt: lateEvening }),
      (error) => {
        assert.equal(error.code, 'OUTSIDE_PUBLISHED_AVAILABILITY')
        return true
      },
    )
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1)
  })

  test('a doctor outside published hours is asked why, not refused outright', async () => {
    const { doctor, patientId } = await clinic('Booked Patient', { hours: false })
    const day = await clinicDate(2)
    const weekday = String(await scalar(`select extract(dow from $1::date)::int`, [day]))
    await as(doctor, 'publish_availability',
      { kind: 'open', weekday, startsAt: '09:00', endsAt: '13:00' })
    const lateEvening = `${day}T22:30`

    await assert.rejects(
      () => book(doctor, { patientId, reason: 'Fever', scheduledAt: lateEvening }),
      (error) => {
        assert.equal(error.code, 'OVERRIDE_REASON_REQUIRED')
        assert.match(String(error.message), /outside the published hours/)
        return true
      },
      'the conflict arm of this refusal was tested and the availability arm was not')
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 0)
  })

  test('two published sessions that meet are one stretch of published time', async () => {
    /*
     * A clinic that publishes a morning and an afternoon session is the
     * ordinary shape, and the first version asked whether ONE window contained
     * the whole appointment — so a fifteen-minute appointment at 12:55, with
     * 09:00–13:00 and 13:00–17:00 both published, was refused as outside
     * published hours although every minute of it is published. Found by the
     * independent review, against the real database.
     */
    const { doctor, nurse, patientId } = await clinic('Booked Patient', { hours: false })
    const day = await clinicDate(2)
    const weekday = String(await scalar(`select extract(dow from $1::date)::int`, [day]))
    for (const [startsAt, endsAt] of [['09:00', '13:00'], ['13:00', '17:00']]) {
      await as(doctor, 'publish_availability', { kind: 'open', weekday, startsAt, endsAt })
    }

    // Straddling the join between them.
    await book(nurse, { patientId, reason: 'Fever', scheduledAt: `${day}T12:55` })
    // Exactly at each edge.
    await book(nurse, { patientId, reason: 'Fever', scheduledAt: `${day}T09:00` })
    await book(nurse, { patientId, reason: 'Fever', scheduledAt: `${day}T16:45` })
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 3)

    // And past the far end is still outside.
    const overTheEnd = `${day}T16:50`
    await assert.rejects(
      () => book(nurse, { patientId, reason: 'Fever', scheduledAt: overTheEnd }),
      (error) => {
        assert.equal(error.code, 'OUTSIDE_PUBLISHED_AVAILABILITY')
        return true
      },
    )
  })

  test('a doctor may book outside published hours, and the booking says so', async () => {
    const { doctor, patientId } = await clinic('Booked Patient', { hours: false })
    await published(doctor)

    const result = await book(doctor, {
      patientId, reason: 'Fever', scheduledAt: await at(2, '22:30'),
      overrideReason: 'Seeing them after the evening clinic',
    })
    assert.equal(result.data.outsideAvailability, true)
    assert.equal(
      String(await scalar('select overbooked_reason from jmc.appointment_bookings')),
      'Seeing them after the evening clinic')
  })

  test('one dated window opens that day and no other', async () => {
    /*
     * The independent review walked this. `published` used to be a
     * schema-wide existence check — "has this doctor published anything, ever"
     * — so a doctor who published one Thursday clinic refused a nurse on every
     * other day of the year, and a weekly window whose effective range had run
     * out refused them for ever with nothing on any screen to say why.
     */
    const { doctor, nurse, patientId } = await clinic('Booked Patient', { hours: false })
    const thursday = await clinicDate(2)
    await as(doctor, 'publish_availability',
      { kind: 'open', onDate: thursday, startsAt: '09:00', endsAt: '13:00' })

    // Inside the one day that IS published.
    await book(nurse, { patientId, reason: 'Fever', scheduledAt: `${thursday}T10:00` })
    // Outside it, on the same day, is refused: that day has published hours.
    const lateThatDay = `${thursday}T22:30`
    await assert.rejects(
      () => book(nurse, { patientId, reason: 'Fever', scheduledAt: lateThatDay }),
      (error) => {
        assert.equal(error.code, 'OUTSIDE_PUBLISHED_AVAILABILITY')
        return true
      },
    )
    // And a day nobody has published is closed, not open at every hour.
    const anotherDay = await at(3, '10:00')
    await assert.rejects(
      () => book(nurse, { patientId, reason: 'Fever', scheduledAt: anotherDay }),
      (error) => {
        assert.equal(error.code, 'OUTSIDE_PUBLISHED_AVAILABILITY')
        return true
      },
    )
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1)
  })

  test('a weekly window whose range has run out opens nothing', async () => {
    const { doctor, nurse, patientId } = await clinic('Booked Patient', { hours: false })
    const expired = await clinicDate(-30)
    await rows(
      `insert into jmc.provider_availability
         (id, doctor_id, kind, weekday, starts_at, ends_at, effective_from, effective_to, created_by)
       select $1, $2, 'open', extract(dow from $3::date)::int, '09:00', '13:00',
              $3::date - 30, $3::date, $2`,
      [randomUUID(), doctor.id, expired],
    )

    const afterItRanOut = await at(2, '10:00')
    await assert.rejects(
      () => book(nurse, { patientId, reason: 'Fever', scheduledAt: afterItRanOut }),
      (error) => {
        assert.equal(error.code, 'OUTSIDE_PUBLISHED_AVAILABILITY')
        return true
      },
      'an expired timetable opens nothing, and nothing retires it automatically')
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 0)
  })

  test('a day the weekly pattern does not cover is closed to a nurse', async () => {
    /*
     * A doctor who publishes Tuesdays has opened Tuesdays. Every other day is
     * closed to a nurse, which is what "within published availability" means
     * and what a clinic with fixed clinic days looks like.
     */
    const { doctor, nurse, patientId } = await clinic('Booked Patient', { hours: false })
    const target = await clinicDate(2)
    const otherWeekday = String(
      (Number(await scalar(`select extract(dow from $1::date)::int`, [target])) + 1) % 7)
    await as(doctor, 'publish_availability',
      { kind: 'open', weekday: otherWeekday, startsAt: '09:00', endsAt: '13:00' })

    const inTheGap = `${target}T10:00`
    await assert.rejects(
      () => book(nurse, { patientId, reason: 'Fever', scheduledAt: inTheGap }),
      (error) => {
        assert.equal(error.code, 'OUTSIDE_PUBLISHED_AVAILABILITY')
        return true
      },
    )
  })

  test('a blocked window subtracts from an open one', async () => {
    const { doctor, nurse, patientId } = await clinic('Booked Patient', { hours: false })
    await published(doctor)
    const blockedDay = await clinicDate(2)
    await as(doctor, 'publish_availability', {
      kind: 'blocked', onDate: blockedDay, startsAt: '11:00', endsAt: '12:00', note: 'Away',
    })

    await book(nurse, { patientId, reason: 'Fever', scheduledAt: `${blockedDay}T10:00` })
    await assert.rejects(
      () => book(nurse, { patientId, reason: 'Fever', scheduledAt: `${blockedDay}T11:15` }),
      (error) => {
        assert.equal(error.code, 'OUTSIDE_PUBLISHED_AVAILABILITY')
        assert.match(String(error.message), /blocked/)
        return true
      },
    )
  })

  test('changing availability never moves or cancels a booking already made', async () => {
    const { doctor, patientId } = await clinic('Booked Patient', { hours: false })
    const windows = await published(doctor)
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(2, '10:00') })
    const before = await rows(
      'select id, scheduled_at, status from jmc.appointment_bookings order by id')

    await as(doctor, 'retire_availability', { availabilityId: windows[0], reason: 'Hours changing' })
    await as(doctor, 'publish_availability', {
      kind: 'blocked', onDate: await clinicDate(2), startsAt: '09:00', endsAt: '13:00', note: 'Closed',
    })

    const after = await rows('select id, scheduled_at, status from jmc.appointment_bookings order by id')
    assert.deepEqual(
      after.map((row) => ({ ...row, scheduled_at: new Date(row.scheduled_at).toISOString() })),
      before.map((row) => ({ ...row, scheduled_at: new Date(row.scheduled_at).toISOString() })),
      'owner item 71: "An availability change never silently cancels or moves an existing booking"')
  })
})

describe('booking is idempotent, like everything else that matters', () => {
  test('the same reference twice is one appointment', async () => {
    const { doctor, patientId } = await clinic()
    const idempotencyKey = randomUUID()
    const scheduledAt = await at(1, '10:00')

    const first = await book(doctor, { patientId, reason: 'Fever', scheduledAt, idempotencyKey })
    const second = await book(doctor, { patientId, reason: 'Fever', scheduledAt, idempotencyKey })

    assert.equal(second.data.bookingId, first.data.bookingId)
    assert.equal(second.data.duplicate, true)
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1)
  })

  test('the same reference against a different appointment is refused, not answered', async () => {
    const { doctor, patientId } = await clinic()
    const idempotencyKey = randomUUID()
    const anotherDay = await at(2, '10:00')
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(1, '10:00'), idempotencyKey })

    await assert.rejects(
      () => book(doctor, { patientId, reason: 'Fever', scheduledAt: anotherDay, idempotencyKey }),
      (error) => {
        assert.equal(error.code, 'APPOINTMENT_REFERENCE_REUSED')
        return true
      },
      'answering with the first appointment would silently lose the second',
    )
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1)
  })

  test('a reference whose booking was cancelled says so rather than "already booked"', async () => {
    const { doctor, patientId } = await clinic()
    const idempotencyKey = randomUUID()
    const scheduledAt = await at(1, '10:00')
    const first = await book(doctor, { patientId, reason: 'Fever', scheduledAt, idempotencyKey })
    await as(doctor, 'cancel_appointment',
      { bookingId: first.data.bookingId, reason: 'Patient telephoned' })

    const retry = await book(doctor, { patientId, reason: 'Fever', scheduledAt, idempotencyKey })
    assert.equal(retry.data.duplicate, true)
    assert.equal(retry.data.currentStatus, 'cancelled',
      'the replay says what the booking IS, not only what it was')
    assert.equal(retry.data.bookingId, first.data.bookingId)
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1,
      'and nothing was booked again')
  })

  test('two tablets sending one reference in the same breath make one appointment', async () => {
    const { doctor, patientId } = await clinic()
    const request = {
      patientId, reason: 'Fever', scheduledAt: await at(1, '10:00'), idempotencyKey: randomUUID(),
    }

    const both = await Promise.allSettled([book(doctor, request), book(doctor, request)])
    assert.deepEqual(both.map((outcome) => outcome.status), ['fulfilled', 'fulfilled'])
    assert.equal(
      both.filter((outcome) => outcome.value.data.duplicate === true).length, 1,
      'exactly one of the two is told it was a repeat')
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1)
  })
})

describe('the counter has no part in the appointment book', () => {
  test('every command refuses a pharmacist', async () => {
    const context = await clinic()
    await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(0, '09:00'),
    })
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))
    const laterDay = await at(2, '10:00')
    const window = await as(context.doctor, 'publish_availability',
      { kind: 'open', weekday: '1', startsAt: '09:00', endsAt: '13:00' })

    const attempts = [
      ['create_appointment_type', { name: 'Anything' }],
      ['update_appointment_type', { appointmentTypeId: 'whatever', durationMinutes: 20 }],
      ['publish_availability', { kind: 'open', weekday: '1', startsAt: '09:00', endsAt: '13:00' }],
      ['retire_availability', { availabilityId: window.data.availabilityId, reason: 'No' }],
      ['book_appointment', { patientId: context.patientId, reason: 'Fever', scheduledAt: laterDay }],
      ['reschedule_appointment', { bookingId, scheduledAt: laterDay, reason: 'No' }],
      ['cancel_appointment', { bookingId, reason: 'No' }],
      ['mark_no_show', { bookingId }],
      ['check_in_appointment', { bookingId }],
      ['set_queue_priority', { appointmentId: 'whatever', reason: 'No' }],
    ]
    for (const [action, payload] of attempts) {
      await assert.rejects(
        () => as(context.pharmacist, action, payload),
        /role cannot perform/,
        `a pharmacist must not be able to ${action}`)
    }
    assert.equal(
      String(await scalar('select status from jmc.appointment_bookings where id=$1', [bookingId])),
      'booked', 'and none of them changed anything')
  })
})

describe('the calendar and the patient’s own history', () => {
  test('a day reads back who is expected, and the published hours', async () => {
    const { doctor, patientId } = await clinic('Booked Patient', { hours: false })
    const day = await clinicDate(1)
    // Published for the weekday that day actually falls on, asked of the
    // database rather than worked out from the machine's clock.
    const weekday = String(await scalar(`select extract(dow from $1::date)::int`, [day]))
    await as(doctor, 'publish_availability',
      { kind: 'open', weekday, startsAt: '09:00', endsAt: '13:00' })
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: `${day}T10:00` })

    const { body } = await edgeGet('workspace', `?view=calendar&from=${day}`, await tokenFor(doctor))
    assert.equal(body.ok, true)
    assert.equal(body.calendar.bookings.length, 1)
    assert.equal(body.calendar.bookings[0].patientName, 'Booked Patient')
    assert.equal(body.calendar.bookings[0].status, 'booked')
    assert.equal(body.calendar.bookings[0].lastEvent.event, 'booked')
    assert.equal(body.calendar.availability.length, 1)
    assert.equal(body.calendar.availability[0].startsAt, '09:00')
    assert.equal(body.calendar.truncated, false)
    assert.ok(patientId)
  })

  test('a range wider than the booking horizon is refused rather than answered', async () => {
    const { doctor } = await clinic()
    const { status, body } = await edgeGet(
      'workspace', `?view=calendar&from=${await clinicDate(0)}&to=${await clinicDate(120)}`,
      await tokenFor(doctor))
    assert.equal(status, 400)
    assert.match(body.message, /up to ninety days/)
  })

  test('a checked-in booking carries its queue token on the calendar', async () => {
    const { doctor, nurse, patientId } = await clinic()
    const day = await clinicDate(0)
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: `${day}T09:00` })
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))
    const checkIn = await as(nurse, 'check_in_appointment', { bookingId })

    const { body } = await edgeGet('workspace', `?view=calendar&from=${day}`, await tokenFor(doctor))
    assert.equal(body.calendar.bookings[0].status, 'checked_in')
    assert.equal(body.calendar.bookings[0].arrivalToken, checkIn.data.token)
    assert.equal(body.calendar.bookings[0].arrivalStatus, 'waiting')
  })

  test('a cancelled appointment is on the patient’s history with the reason it was cancelled for', async () => {
    const { doctor, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(1, '10:00') })
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))
    await as(doctor, 'cancel_appointment', { bookingId, reason: 'Patient telephoned' })

    const { body } = await edgeGet(
      'workspace', `?view=appointments&patientId=${patientId}`, await tokenFor(doctor))
    assert.equal(body.appointments.length, 1)
    assert.equal(body.appointments[0].status, 'cancelled')
    assert.deepEqual(
      body.appointments[0].history.map((entry) => [entry.event, entry.reason]),
      [['booked', 'Fever'], ['cancelled', 'Patient telephoned']],
      'owner item 68: nothing is deleted and the history reads back')
  })

  test('a pharmacist is refused the calendar and the history', async () => {
    const { pharmacist, patientId } = await clinic()
    const token = await tokenFor(pharmacist)
    for (const view of [`calendar&from=${await clinicDate(0)}`, `appointments&patientId=${patientId}`]) {
      const { status } = await edgeGet('workspace', `?view=${view}`, token)
      assert.equal(status, 403, `the counter has no queue station and no calendar: ${view}`)
    }
  })
})

describe('the work lists behind the counts', () => {
  test('today’s expected patients leave the list when they check in', async () => {
    const { doctor, nurse, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(0, '09:00') })
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))
    const token = await tokenFor(nurse)

    const before = await edgeGet(
      'workspace', '?view=list&list=list.appointments_today', token)
    assert.equal(before.body.list.count, 1)

    await as(nurse, 'check_in_appointment', { bookingId })

    const after = await edgeGet('workspace', '?view=list&list=list.appointments_today', token)
    assert.equal(after.body.list.count, 0, 'they are in the queue now, not on the calendar')
    const queue = await edgeGet('workspace', '?view=list&list=list.today_queue', token)
    assert.equal(queue.body.list.count, 1)
  })

  test('tomorrow is not on today’s list', async () => {
    const { doctor, nurse, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(1, '09:00') })

    const { body } = await edgeGet(
      'workspace', '?view=list&list=list.appointments_today', await tokenFor(nurse))
    assert.equal(body.list.count, 0)
  })

  test('a booking past its half hour is offered for no-show review, and stays checkable-in', async () => {
    const { doctor, nurse, patientId } = await clinic()
    await rows(
      `insert into jmc.appointment_bookings
         (id, patient_id, doctor_id, scheduled_at, duration_minutes, reason, status, booked_by)
       values ($1,$2,$3, now() - interval '45 minutes', 15, 'Fever', 'booked', $3)`,
      [randomUUID(), patientId, doctor.id],
    )
    const token = await tokenFor(nurse)

    const review = await edgeGet('workspace', '?view=list&list=list.no_show_review', token)
    assert.equal(review.body.list.count, 1)
    assert.ok(review.body.list.rows[0].minutes_late >= 45)

    const expected = await edgeGet('workspace', '?view=list&list=list.appointments_today', token)
    assert.equal(expected.body.list.count, 1,
      'a late patient is still the person about to walk through the door')
    assert.equal(expected.body.list.rows[0].late, true)
  })

  test('the queue list carries the urgency the snapshot withholds', async () => {
    const context = await clinic('First In')
    await as(context.doctor, 'create_patient',
      { name: 'Came Later', age: 8, sex: 'male', phone: '+919990000006' })
    const laterId = String(await scalar('select id from jmc.patients where name=$1', ['Came Later']))
    await as(context.nurse, 'create_appointment',
      { patientId: context.patientId, reason: 'Cough', scheduledAt: new Date().toISOString() })
    await book(context.doctor, {
      patientId: laterId, reason: 'High fever', scheduledAt: await at(0, '09:00'),
    })
    const bookingId = String(await scalar('select id from jmc.appointment_bookings'))
    await as(context.nurse, 'check_in_appointment', { bookingId })
    const laterArrival = String(await scalar(
      'select id from jmc.appointments where patient_id=$1', [laterId]))
    await as(context.doctor, 'set_queue_priority',
      { appointmentId: laterArrival, reason: 'Child with a fever of 40' })

    const { body } = await edgeGet(
      'workspace', '?view=list&list=list.today_queue', await tokenFor(context.doctor))
    assert.deepEqual(body.list.rows.map((row) => row.patient_name), ['Came Later', 'First In'],
      'urgent first, then arrival order')
    assert.equal(body.list.rows[0].urgent, true)
    assert.equal(body.list.rows[0].urgent_reason, 'Child with a fever of 40')
    assert.equal(body.list.rows[0].urgent_by, 'Doctor')
    assert.ok(body.list.rows[0].urgent_at)
    assert.equal(body.list.rows[0].booking_id, bookingId,
      'and the list says who was expected and who walked in')
    assert.equal(body.list.rows[1].urgent, false)
    assert.equal(body.list.rows[1].booking_id, null)
  })

  test('every count is the size of the list it opens', async () => {
    const { doctor, nurse, patientId } = await clinic()
    await book(doctor, { patientId, reason: 'Fever', scheduledAt: await at(0, '09:00') })
    const token = await tokenFor(nurse)

    const { body } = await edgeGet('workspace', '?view=workload', token)
    for (const id of ['list.appointments_today', 'list.no_show_review']) {
      const counted = body.counts.find((entry) => entry.id === id)
      const opened = await edgeGet('workspace', `?view=list&list=${id}`, token)
      assert.equal(counted.count, opened.body.list.count, id)
      assert.equal(opened.body.list.rows.length, opened.body.list.count, id)
    }
  })
})

describe('the queue token can no longer be shared by two waiting patients', () => {
  test('a second open row holding one token is refused by the database', async () => {
    const { doctor, nurse, patientId } = await clinic()
    await as(nurse, 'create_appointment',
      { patientId, reason: 'Cough', scheduledAt: new Date().toISOString() })
    const [existing] = await rows('select id, token from jmc.appointments')

    await assert.rejects(
      () => rows(
        `insert into jmc.appointments (id, patient_id, token, reason, scheduled_at, status, created_at)
         values ($1,$2,$3,'Cough',$4,'waiting',$4)`,
        [randomUUID(), patientId, existing.token, new Date().toISOString()],
      ),
      /appointments_open_token_unique/,
      'two waiting patients holding JMC-0004 is how one is called in for the other',
    )

    // And the finished ones are untouched, which is the whole reason the index
    // is partial: historical duplicates are damage, not a reason to fail.
    await rows(`update jmc.appointments set status='done' where id=$1`, [existing.id])
    await rows(
      `insert into jmc.appointments (id, patient_id, token, reason, scheduled_at, status, created_at)
       values ($1,$2,$3,'Cough',$4,'done',$4)`,
      [randomUUID(), patientId, existing.token, new Date().toISOString()],
    )
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.appointments where token=$1', [existing.token])), 2)
    assert.ok(doctor)
  })
})

describe('a reference is carried out once, whatever happens to the reply', () => {
  /*
   * The acceptance review reproduced every failure in this block against the
   * clinic's own database. Slice 2 decided "have I already done this?" by
   * reading the booking's CURRENT state, which is a guess that expires,
   * because the whole reason a retry arrives late is that the state moved.
   */
  async function booked(context, hhmm = '10:00') {
    const at1 = await at(1, hhmm)
    const result = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: at1,
    })
    return result.data.bookingId
  }

  test('a stale reschedule retry cannot drag an appointment backwards', async () => {
    const context = await clinic()
    const bookingId = await booked(context)
    const eleven = await at(1, '11:00')
    const twelve = await at(1, '12:00')

    // Move to 11:00 under its own reference. The reply is lost.
    const lostKey = randomUUID()
    await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: eleven, reason: 'Patient asked', idempotencyKey: lostKey,
    })
    // Somebody moves it to 12:00.
    await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: twelve, reason: 'Doctor running late',
    })

    // The lost reply's retry arrives.
    const retry = await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: eleven, reason: 'Patient asked', idempotencyKey: lostKey,
    })

    assert.equal(retry.data.duplicate, true)
    assert.equal(
      String(await scalar(
        `select to_char(scheduled_at at time zone 'Asia/Kolkata', 'HH24:MI')
           from jmc.appointment_bookings where id=$1`, [bookingId])),
      '12:00',
      'the appointment stays where the NEWER act put it')
    assert.equal(retry.data.currentScheduledAt.slice(-5), '12:00',
      'and the replay says so rather than only replaying the past')
    assert.equal(Number(await scalar(
      `select count(*)::int from jmc.appointment_events
        where booking_id=$1 and event='rescheduled'`, [bookingId])), 2,
      'two moves happened, so there are two transitions and not a third')
  })

  test('a stale check-in retry mints no second token and does not re-open the booking', async () => {
    const context = await clinic()
    const today = await at(0, '09:00')
    const first = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: today,
    })
    const bookingId = first.data.bookingId

    const lostKey = randomUUID()
    const checkedIn = await as(context.nurse, 'check_in_appointment', {
      bookingId, idempotencyKey: lostKey,
    })
    const originalToken = checkedIn.data.token

    // The appointment is moved, which cancels the arrival and re-opens the booking.
    await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: await at(2, '10:00'), reason: 'Patient asked to come another day',
    })

    // The lost check-in's retry arrives.
    const retry = await as(context.nurse, 'check_in_appointment', {
      bookingId, idempotencyKey: lostKey,
    })

    assert.equal(retry.data.duplicate, true)
    assert.equal(retry.data.token, originalToken, 'it is told what it did')
    assert.equal(retry.data.superseded, true, 'and that it no longer stands')
    assert.equal(retry.data.currentArrivalStatus, 'cancelled')
    assert.equal(retry.data.currentBookingStatus, 'booked')

    const arrivals = await rows(
      `select token, status from jmc.appointments where booking_id=$1 order by created_at`,
      [bookingId])
    assert.deepEqual(
      arrivals.map((row) => ({ token: row.token, status: row.status })),
      [{ token: originalToken, status: 'cancelled' }],
      'no JMC-0002, and the cancelled arrival stays cancelled')
    assert.equal(
      String(await scalar('select status from jmc.appointment_bookings where id=$1', [bookingId])),
      'booked',
      'and the booking was not dragged back into checked_in')
  })

  test('and a genuinely new check-in afterwards still works', async () => {
    const context = await clinic()
    const today = await at(0, '09:00')
    const first = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: today,
    })
    const bookingId = first.data.bookingId
    const lostKey = randomUUID()
    await as(context.nurse, 'check_in_appointment', { bookingId, idempotencyKey: lostKey })
    await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: await at(0, '11:00'), reason: 'Later today',
    })

    // A new attempt, under a reference of its own.
    const again = await as(context.nurse, 'check_in_appointment', { bookingId })
    assert.equal(again.data.duplicate, undefined)
    assert.notEqual(again.data.token, undefined)
    assert.equal(
      Number(await scalar(
        `select count(*)::int from jmc.appointments
          where booking_id=$1 and status <> 'cancelled'`, [bookingId])), 1)
  })

  test('two tablets sending one reference get one result', async () => {
    const context = await clinic()
    const scheduledAt = await at(1, '10:00')
    const request = {
      patientId: context.patientId, reason: 'Fever', scheduledAt, idempotencyKey: randomUUID(),
    }

    const both = await Promise.allSettled([
      book(context.doctor, request),
      book(context.doctor, request),
    ])
    assert.deepEqual(both.map((outcome) => outcome.status), ['fulfilled', 'fulfilled'])
    const ids = new Set(both.map((outcome) => outcome.value.data.bookingId))
    assert.equal(ids.size, 1)
    assert.equal(
      both.filter((outcome) => outcome.value.data.duplicate === true).length, 1)
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1)
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.appointment_command_receipts where command=$1',
      ['book_appointment'])), 1)
  })

  test('a different request under one reference is refused, on every command', async () => {
    const context = await clinic()
    const bookingId = await booked(context, '09:00')
    // A slot nothing else in this test has taken, so the first call of each
    // pair succeeds and the SECOND is the thing being tested.
    const scheduledAt = await at(1, '16:00')
    const other = await at(2, '16:00')

    // All ten, because "on every command" was five when the independent review
    // counted them.
    const created = await as(context.doctor, 'create_appointment_type',
      { name: 'For the reuse test', durationMinutes: 20 })
    const window = await as(context.doctor, 'publish_availability',
      { kind: 'open', weekday: '4', startsAt: '09:00', endsAt: '13:00' })
    const secondBooking = (await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(4, '09:30'),
    })).data.bookingId
    const thirdBooking = (await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(5, '09:30'),
    })).data.bookingId
    await as(context.nurse, 'create_appointment',
      { patientId: context.patientId, reason: 'Cough', scheduledAt: new Date().toISOString() })
    const arrivalId = String(await scalar(
      `select id from jmc.appointments where patient_id=$1 and status='waiting'`,
      [context.patientId]))
    await rows(
      `update jmc.appointment_bookings set scheduled_at = now() - interval '40 minutes'
        where id = $1`, [thirdBooking])

    const pairs = [
      ['book_appointment',
        { patientId: context.patientId, reason: 'Fever', scheduledAt },
        { patientId: context.patientId, reason: 'Cough', scheduledAt }],
      ['reschedule_appointment',
        { bookingId, scheduledAt: other, reason: 'One' },
        { bookingId, scheduledAt: other, reason: 'Two' }],
      ['cancel_appointment',
        { bookingId, reason: 'One' },
        { bookingId, reason: 'Two' }],
      ['create_appointment_type',
        { name: 'First type' },
        { name: 'Second type' }],
      ['update_appointment_type',
        { appointmentTypeId: created.data.appointmentTypeId, durationMinutes: 25 },
        { appointmentTypeId: created.data.appointmentTypeId, durationMinutes: 35 }],
      ['publish_availability',
        { kind: 'open', weekday: '1', startsAt: '09:00', endsAt: '13:00' },
        { kind: 'open', weekday: '2', startsAt: '09:00', endsAt: '13:00' }],
      ['retire_availability',
        { availabilityId: window.data.availabilityId, reason: 'One' },
        { availabilityId: window.data.availabilityId, reason: 'Two' }],
      ['mark_no_show',
        { bookingId: thirdBooking, reason: 'One' },
        { bookingId: thirdBooking, reason: 'Two' }],
      ['check_in_appointment',
        { bookingId: secondBooking },
        { bookingId: thirdBooking }],
      ['set_queue_priority',
        { appointmentId: arrivalId, reason: 'One' },
        { appointmentId: arrivalId, reason: 'Two' }],
    ]

    for (const [command, firstPayload, secondPayload] of pairs) {
      const idempotencyKey = randomUUID()
      await as(context.doctor, command, { ...firstPayload, idempotencyKey })
      await assert.rejects(
        () => as(context.doctor, command, { ...secondPayload, idempotencyKey }),
        (error) => {
          assert.equal(error.code, 'APPOINTMENT_REFERENCE_REUSED', command)
          return true
        },
        `${command} must not answer a different request with an earlier one's outcome`)
    }
  })

  test('every appointment command refuses a request with no reference at all', async () => {
    const context = await clinic()
    const bookingId = await booked(context)
    const window = await as(context.doctor, 'publish_availability',
      { kind: 'open', weekday: '1', startsAt: '09:00', endsAt: '13:00' })
    const laterDay = await at(2, '10:00')

    const attempts = [
      ['create_appointment_type', { name: 'Anything' }],
      ['update_appointment_type', { appointmentTypeId: 'x', durationMinutes: 20 }],
      ['publish_availability', { kind: 'open', weekday: '3', startsAt: '09:00', endsAt: '13:00' }],
      ['retire_availability', { availabilityId: window.data.availabilityId, reason: 'No' }],
      ['book_appointment',
        { patientId: context.patientId, reason: 'Fever', scheduledAt: laterDay }],
      ['reschedule_appointment', { bookingId, scheduledAt: laterDay, reason: 'No' }],
      ['cancel_appointment', { bookingId, reason: 'No' }],
      ['mark_no_show', { bookingId }],
      ['check_in_appointment', { bookingId }],
      ['set_queue_priority', { appointmentId: 'x', reason: 'No' }],
    ]
    for (const [command, payload] of attempts) {
      await assert.rejects(
        () => rawAs(context.doctor, command, payload),
        /reference of its own/,
        `${command} has no deployed caller, so there is nobody to be compatible with`)
    }
  })

  test('a stale update to an appointment type cannot revert a newer one', async () => {
    const context = await clinic()
    const created = await as(context.doctor, 'create_appointment_type',
      { name: 'Review', durationMinutes: 20 })
    const appointmentTypeId = created.data.appointmentTypeId

    const lostKey = randomUUID()
    await as(context.doctor, 'update_appointment_type',
      { appointmentTypeId, durationMinutes: 30, idempotencyKey: lostKey })
    await as(context.doctor, 'update_appointment_type',
      { appointmentTypeId, durationMinutes: 45 })

    const retry = await as(context.doctor, 'update_appointment_type',
      { appointmentTypeId, durationMinutes: 30, idempotencyKey: lostKey })
    assert.equal(retry.data.duplicate, true)
    assert.equal(Number(await scalar('select duration_minutes from jmc.appointment_types')), 45,
      'a lost reply must not undo the act that followed it')
  })

  test('a stale priority retry cannot re-raise a patient somebody put back', async () => {
    const context = await clinic()
    await as(context.nurse, 'create_appointment',
      { patientId: context.patientId, reason: 'Cough', scheduledAt: new Date().toISOString() })
    const arrivalId = String(await scalar('select id from jmc.appointments'))

    const lostKey = randomUUID()
    await as(context.doctor, 'set_queue_priority',
      { appointmentId: arrivalId, reason: 'Chest pain', idempotencyKey: lostKey })
    await as(context.doctor, 'set_queue_priority',
      { appointmentId: arrivalId, urgent: false, reason: 'Settled, back in order' })

    const retry = await as(context.doctor, 'set_queue_priority',
      { appointmentId: arrivalId, reason: 'Chest pain', idempotencyKey: lostKey })
    assert.equal(retry.data.duplicate, true)
    assert.equal(await scalar('select urgent from jmc.appointments where id=$1', [arrivalId]), false,
      'the newer decision stands')

    /*
     * And the REPLY says so, which is the half the first version of this test
     * did not look at. It asserted the database and let the answer through
     * unchecked, so a replay saying "Moved up the queue" about a patient
     * somebody had put back would have passed — and `urgent` is the field that
     * decides who is called next. The independent review caught it.
     */
    assert.equal(retry.data.superseded, true)
    assert.equal(retry.data.currentUrgent, false)
    assert.equal(retry.data.currentVisitStatus, 'waiting')
  })

  test('a stale retry says so for a booking, a move and a cancellation', async () => {
    /*
     * The contract promises `superseded` generally. It used to be reachable
     * from check-in alone: `bookingStanding` returned it only when the booking
     * row was MISSING, and nothing ever deletes one. So a reschedule retry
     * arriving after a newer move replayed "Moved to 11:00" with no flag at
     * all, and a screen reading the contract printed eleven o'clock as a live
     * fact. Each command answers its own question now.
     *
     * Three of the ten here, which is what the name says. The name used to say
     * "every command that can be superseded" and the third acceptance review
     * was right that it did not: the appointment type, the queue priority and
     * the availability window were not touched, and two of those three were
     * where the untruthful answers actually were. They are in "superseded
     * describes the whole effect" at the end of this file.
     */
    const context = await clinic()
    const bookingId = (await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(1, '09:00'),
    })).data.bookingId

    // A move, superseded by a later move.
    const moveKey = randomUUID()
    const eleven = await at(1, '11:00')
    await as(context.doctor, 'reschedule_appointment',
      { bookingId, scheduledAt: eleven, reason: 'One', idempotencyKey: moveKey })
    await as(context.doctor, 'reschedule_appointment',
      { bookingId, scheduledAt: await at(1, '12:00'), reason: 'Two' })
    const staleMove = await as(context.doctor, 'reschedule_appointment',
      { bookingId, scheduledAt: eleven, reason: 'One', idempotencyKey: moveKey })
    assert.equal(staleMove.data.superseded, true,
      'a move that has been moved again does not still stand')
    assert.match(staleMove.data.currentScheduledAt, /12:00$/)

    // A cancellation, which does still stand.
    const cancelKey = randomUUID()
    await as(context.doctor, 'cancel_appointment',
      { bookingId, reason: 'Patient telephoned', idempotencyKey: cancelKey })
    const staleCancel = await as(context.doctor, 'cancel_appointment',
      { bookingId, reason: 'Patient telephoned', idempotencyKey: cancelKey })
    assert.equal(staleCancel.data.superseded, false)
    assert.equal(staleCancel.data.currentStatus, 'cancelled')

    // And a booking, superseded by the cancellation above.
    const bookKey = randomUUID()
    const second = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(2, '09:00'),
      idempotencyKey: bookKey,
    })
    await as(context.doctor, 'cancel_appointment',
      { bookingId: second.data.bookingId, reason: 'Also telephoned' })
    const staleBook = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(2, '09:00'),
      idempotencyKey: bookKey,
    })
    assert.equal(staleBook.data.superseded, true)
    assert.equal(staleBook.data.currentStatus, 'cancelled')
  })

  test('the receipt and the effect commit together, or neither does', async () => {
    /*
     * The failure has to come from INSIDE the transaction, which the first
     * version of this test did not arrange: it drove a horizon refusal, which
     * at the time ran before `once` opened anything, so it proved only that a
     * validation failure writes no receipt. The independent review pointed
     * that out.
     *
     * The horizon is inside `work()` now — the second correction moved it, so
     * that a receipt is reachable after the clinic day has turned — which
     * would make that first version accidentally valid today. It is still not
     * the test to write: a conflict refused by `clearSlot` fails after the
     * advisory lock has been taken and rows have been read, which is the shape
     * that would leave a receipt behind if the two were not one transaction.
     */
    const context = await clinic()
    const idempotencyKey = randomUUID()
    const taken = await at(1, '10:00')
    await as(context.doctor, 'create_patient',
      { name: 'Slot Holder', age: 22, sex: 'female', phone: '+919990000031' })
    const holderId = String(await scalar('select id from jmc.patients where name=$1', ['Slot Holder']))
    await book(context.doctor, { patientId: holderId, reason: 'Cough', scheduledAt: taken })

    await assert.rejects(
      () => book(context.doctor, {
        patientId: context.patientId, reason: 'Fever', scheduledAt: taken, idempotencyKey,
      }),
      (error) => {
        assert.equal(error.code, 'OVERRIDE_REASON_REQUIRED')
        return true
      },
    )
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.appointment_command_receipts where idempotency_key=$1',
      [idempotencyKey])), 0,
      'a refused command leaves no receipt, or the reference would be spent on nothing')

    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.appointment_bookings where patient_id=$1',
      [context.patientId])), 0, 'and no booking either')

    // And the reference is still usable, because nothing was recorded under it.
    const ok = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(1, '15:00'), idempotencyKey,
    })
    assert.equal(ok.data.duplicate, undefined)
  })
})

describe('what a reschedule actually changes', () => {
  test('the same time with a different type applies the change and records it once', async () => {
    /*
     * Slice 2 treated "same scheduled_at" as a duplicate and returned without
     * doing anything, so a request that moved an appointment into a
     * forty-five-minute type AT THE SAME TIME silently kept the old type and
     * the old duration. Time is not the whole of what a reschedule changes.
     */
    const context = await clinic()
    const longer = await as(context.doctor, 'create_appointment_type',
      { name: 'Long review', durationMinutes: 45 })
    const scheduledAt = await at(1, '10:00')
    const booking = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt,
    })
    const bookingId = booking.data.bookingId

    const moved = await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt, reason: 'Needs longer',
      appointmentTypeId: longer.data.appointmentTypeId,
    })
    assert.equal(moved.data.duplicate, undefined, 'this is not a repeat of anything')

    const [row] = await rows(
      'select duration_minutes, appointment_type_id from jmc.appointment_bookings where id=$1',
      [bookingId])
    assert.equal(Number(row.duration_minutes), 45)
    assert.equal(row.appointment_type_id, longer.data.appointmentTypeId)

    const [event] = await rows(
      `select duration_before, duration_after, appointment_type_before, appointment_type_after
         from jmc.appointment_events where booking_id=$1 and event='rescheduled'`, [bookingId])
    assert.equal(Number(event.duration_before), 15)
    assert.equal(Number(event.duration_after), 45)
    assert.equal(event.appointment_type_before, null)
    assert.equal(event.appointment_type_after, longer.data.appointmentTypeId)
    assert.equal(Number(await scalar(
      `select count(*)::int from jmc.appointment_events
        where booking_id=$1 and event='rescheduled'`, [bookingId])), 1)
  })

  test('moving out of a conflict clears the override the booking was made under', async () => {
    const context = await clinic()
    await as(context.doctor, 'create_patient',
      { name: 'Slot Holder', age: 22, sex: 'female', phone: '+919990000007' })
    const holderId = String(await scalar('select id from jmc.patients where name=$1', ['Slot Holder']))
    const taken = await at(1, '10:00')
    await book(context.doctor, { patientId: holderId, reason: 'Cough', scheduledAt: taken })

    const overbooked = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: taken,
      overrideReason: 'Two children, one parent',
    })
    const bookingId = overbooked.data.bookingId
    assert.equal(overbooked.data.overbooked, true)

    // Move it to an empty slot. The flags and the reason must go with it.
    await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: await at(1, '15:00'), reason: 'Found a free slot',
    })

    const [row] = await rows(
      'select overbooked, outside_availability, overbooked_reason from jmc.appointment_bookings where id=$1',
      [bookingId])
    assert.deepEqual(
      { overbooked: row.overbooked, outside: row.outside_availability, reason: row.overbooked_reason },
      { overbooked: false, outside: false, reason: '' },
      'an appointment in an empty slot must not go on claiming it was overbooked')

    const [event] = await rows(
      `select overbooked, outside_availability, override_reason from jmc.appointment_events
        where booking_id=$1 and event='rescheduled'`, [bookingId])
    assert.equal(event.overbooked, false)
    assert.equal(event.override_reason, '')
  })

  test('moving into a conflict sets the override, with its own reason on the event', async () => {
    const context = await clinic()
    await as(context.doctor, 'create_patient',
      { name: 'Slot Holder', age: 22, sex: 'female', phone: '+919990000008' })
    const holderId = String(await scalar('select id from jmc.patients where name=$1', ['Slot Holder']))
    const taken = await at(1, '10:00')
    await book(context.doctor, { patientId: holderId, reason: 'Cough', scheduledAt: taken })

    const booking = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(1, '15:00'),
    })
    const bookingId = booking.data.bookingId
    assert.equal(booking.data.overbooked, false)

    const moved = await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: taken, reason: 'Parent can only come at ten',
      overrideReason: 'Seeing both children together',
    })
    assert.equal(moved.data.overbooked, true)

    const [row] = await rows(
      'select overbooked, overbooked_reason from jmc.appointment_bookings where id=$1', [bookingId])
    assert.equal(row.overbooked, true)
    assert.equal(row.overbooked_reason, 'Seeing both children together')

    const [event] = await rows(
      `select overbooked, override_reason from jmc.appointment_events
        where booking_id=$1 and event='rescheduled'`, [bookingId])
    assert.equal(event.overbooked, true)
    assert.equal(event.override_reason, 'Seeing both children together')
  })

  test('the override reason is part of what a reference names', async () => {
    const context = await clinic()
    await as(context.doctor, 'create_patient',
      { name: 'Slot Holder', age: 22, sex: 'female', phone: '+919990000009' })
    const holderId = String(await scalar('select id from jmc.patients where name=$1', ['Slot Holder']))
    const taken = await at(1, '10:00')
    await book(context.doctor, { patientId: holderId, reason: 'Cough', scheduledAt: taken })

    const idempotencyKey = randomUUID()
    await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: taken,
      overrideReason: 'Two children, one parent', idempotencyKey,
    })
    await assert.rejects(
      () => book(context.doctor, {
        patientId: context.patientId, reason: 'Fever', scheduledAt: taken,
        overrideReason: 'A completely different justification', idempotencyKey,
      }),
      (error) => {
        assert.equal(error.code, 'APPOINTMENT_REFERENCE_REUSED')
        return true
      },
      'two requests differing only in why an override was allowed are two decisions')
  })

  test('the database refuses a flag with no sentence, and a sentence with no flag', async () => {
    const context = await clinic()
    const booking = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(1, '10:00'),
    })
    const bookingId = booking.data.bookingId

    await assert.rejects(
      () => rows(
        `update jmc.appointment_bookings set outside_availability = true where id = $1`, [bookingId]),
      /override_is_explained/,
      'owner item 67 requires a reason for the override, and outside-hours is one')

    await assert.rejects(
      () => rows(
        `update jmc.appointment_bookings set overbooked_reason = 'left over' where id = $1`,
        [bookingId]),
      /override_is_explained/,
      'and a reason with no override behind it reads on a screen as an override that is not there')
  })
})

describe('a stored receipt is reachable before anything mutable is consulted', () => {
  /*
   * The third acceptance review reproduced both of these. A retry arrives
   * precisely when the clinic has moved, so anything that asks about the
   * clinic NOW has to run after the receipt rather than in front of it —
   * otherwise a committed act reports itself as a failure.
   */
  /*
   * ── WHAT CAN AND CANNOT BE SHOWN HERE ────────────────────────────────────
   *
   * The clinic day comes from `now()` in Postgres, so a suite cannot watch a
   * receipt survive midnight. What it can watch is the ORDER, which is the
   * whole of the production change: whichever question the clinic is asked
   * about a reference, the stored receipt is consulted first and answers it.
   *
   * The two below put the horizon after the receipt. Both send a day that is
   * genuinely in the past under a reference that has already been spent, so
   * the truthful answer is that the reference is spent. Before the correction
   * the horizon ran in front of `once()` and answered instead — the tablet was
   * told a date was in the past when what had actually happened was that its
   * earlier request had committed, which is the one thing it needed to know.
   *
   * The pair after them move the roster, which the suite CAN do, and show the
   * identical retry replaying across it.
   */
  test('a spent reference answers for itself, before the calendar does', async () => {
    const context = await clinic()
    const bookingId = (await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(1, '10:00'),
    })).data.bookingId
    const idempotencyKey = randomUUID()

    await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: await at(1, '11:00'), reason: 'Moved', idempotencyKey,
    })
    const events = Number(await scalar(
      `select count(*)::int from jmc.appointment_events where booking_id=$1`, [bookingId]))

    const yesterday = await at(-1, '11:00')
    await assert.rejects(
      () => as(context.doctor, 'reschedule_appointment', {
        bookingId, scheduledAt: yesterday, reason: 'Moved', idempotencyKey,
      }),
      (error) => {
        assert.equal(error.code, 'APPOINTMENT_REFERENCE_REUSED',
          'the reference is what is wrong here, and the receipt is what knows it')
        return true
      },
    )
    assert.equal(Number(await scalar(
      `select count(*)::int from jmc.appointment_events where booking_id=$1`, [bookingId])), events,
      'and nothing was written')
  })

  test('and a booking under a spent reference answers the same way', async () => {
    const context = await clinic()
    const idempotencyKey = randomUUID()
    await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(1, '10:00'), idempotencyKey,
    })
    const yesterday = await at(-1, '10:00')
    await assert.rejects(
      () => book(context.doctor, {
        patientId: context.patientId, reason: 'Fever', scheduledAt: yesterday, idempotencyKey,
      }),
      (error) => {
        assert.equal(error.code, 'APPOINTMENT_REFERENCE_REUSED')
        return true
      },
    )
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1)
  })

  test('a nurse\u2019s booking replays after a second doctor joins the clinic', async () => {
    /*
     * With one doctor, `doctorId` may be omitted. Resolving that default reads
     * the roster, which is mutable — so it went in the fingerprint, and the
     * exact retry after a locum was added was refused with "say which doctor
     * this appointment is with" about a booking that had already been made.
     */
    const context = await clinic()
    const idempotencyKey = randomUUID()
    const scheduledAt = await at(1, '10:00')
    const first = await book(context.nurse, {
      patientId: context.patientId, reason: 'Fever', scheduledAt, idempotencyKey,
    })

    await makeStaff({ name: 'Locum', roles: ['doctor'], username: 'loc', pin: '5751' })

    const retry = await book(context.nurse, {
      patientId: context.patientId, reason: 'Fever', scheduledAt, idempotencyKey,
    })
    assert.equal(retry.data.duplicate, true)
    assert.equal(retry.data.bookingId, first.data.bookingId)
    assert.equal(retry.data.doctorId, context.doctor.id,
      'and it names the doctor it was actually booked with, as a result rather than as a guess')
    assert.equal(Number(await scalar('select count(*)::int from jmc.appointment_bookings')), 1)
  })

  test('and publishing availability replays after the roster changes too', async () => {
    /*
     * Published by the ADMIN, deliberately. A doctor who names nobody resolves
     * to themselves and a locum arriving changes nothing for them; an admin
     * resolves to "the only doctor there is", which a locum ends. That is the
     * roster being mutable, which is the whole point.
     */
    const context = await clinic('Booked Patient', { hours: false })
    const idempotencyKey = randomUUID()
    const request = { kind: 'open', weekday: '1', startsAt: '09:00', endsAt: '13:00', idempotencyKey }

    const first = await as(context.admin, 'publish_availability', request)
    await makeStaff({ name: 'Locum', roles: ['doctor'], username: 'loc', pin: '5752' })

    const retry = await as(context.admin, 'publish_availability', request)
    assert.equal(retry.data.duplicate, true)
    assert.equal(retry.data.availabilityId, first.data.availabilityId)
    assert.equal(Number(await scalar('select count(*)::int from jmc.provider_availability')), 1)
  })

  test('a materially different request under the same reference is still refused', async () => {
    const context = await clinic()
    const idempotencyKey = randomUUID()
    await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(1, '10:00'), idempotencyKey,
    })
    const elsewhere = await at(2, '10:00')
    await assert.rejects(
      () => book(context.doctor, {
        patientId: context.patientId, reason: 'Fever', scheduledAt: elsewhere, idempotencyKey,
      }),
      (error) => {
        assert.equal(error.code, 'APPOINTMENT_REFERENCE_REUSED')
        return true
      },
      'moving the receipt earlier must not make it answer a different request')
  })

  test('authorization is not bypassed, and a refused first attempt writes no receipt', async () => {
    const context = await clinic()
    const idempotencyKey = randomUUID()
    const scheduledAt = await at(1, '10:00')

    await assert.rejects(
      () => book(context.pharmacist, {
        patientId: context.patientId, reason: 'Fever', scheduledAt, idempotencyKey,
      }),
      /role cannot perform/,
      'the role check still runs before everything, including the receipt')
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.appointment_command_receipts where idempotency_key=$1',
      [idempotencyKey])), 0)

    // And the reference is unspent, so the right person can use it.
    const ok = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt, idempotencyKey,
    })
    assert.equal(ok.data.duplicate, undefined)
  })
})

describe('superseded describes the whole effect, not one field of it', () => {
  test('a move to the same time with a different type supersedes the earlier move', async () => {
    /*
     * `moveStillStands` compared the scheduled instant alone, so a second
     * reschedule to the SAME time with a longer type replayed the thirty-minute
     * outcome, reported the current duration as forty-five, and said
     * `superseded: false` in the same breath.
     */
    const context = await clinic()
    const thirty = (await as(context.doctor, 'create_appointment_type',
      { name: 'Thirty', durationMinutes: 30 })).data.appointmentTypeId
    const fortyFive = (await as(context.doctor, 'create_appointment_type',
      { name: 'Forty five', durationMinutes: 45 })).data.appointmentTypeId
    const bookingId = (await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(1, '09:00'),
    })).data.bookingId
    const target = await at(1, '11:00')
    const idempotencyKey = randomUUID()

    await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: target, reason: 'One', appointmentTypeId: thirty, idempotencyKey,
    })
    await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: target, reason: 'Two', appointmentTypeId: fortyFive,
    })

    const retry = await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: target, reason: 'One', appointmentTypeId: thirty, idempotencyKey,
    })
    assert.equal(retry.data.duplicate, true)
    assert.equal(retry.data.durationMinutes, 30, 'it replays what it did')
    assert.equal(retry.data.currentDurationMinutes, 45)
    assert.equal(retry.data.currentAppointmentTypeId, fortyFive)
    assert.equal(retry.data.superseded, true, 'and says that is no longer what the clinic holds')
  })

  test('two types of the same length are still two types', async () => {
    const context = await clinic()
    const first = (await as(context.doctor, 'create_appointment_type',
      { name: 'Review', durationMinutes: 30 })).data.appointmentTypeId
    const second = (await as(context.doctor, 'create_appointment_type',
      { name: 'Dressing', durationMinutes: 30 })).data.appointmentTypeId
    const bookingId = (await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt: await at(1, '09:00'),
    })).data.bookingId
    const target = await at(1, '11:00')
    const idempotencyKey = randomUUID()

    await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: target, reason: 'One', appointmentTypeId: first, idempotencyKey,
    })
    await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: target, reason: 'Two', appointmentTypeId: second,
    })

    const retry = await as(context.doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: target, reason: 'One', appointmentTypeId: first, idempotencyKey,
    })
    assert.equal(retry.data.superseded, true,
      'comparing durations alone would have called these the same appointment')
  })

  test('a stale type update says so, and a creation does not borrow its rule', async () => {
    const context = await clinic()
    const created = await as(context.doctor, 'create_appointment_type',
      { name: 'Review', durationMinutes: 20 })
    const appointmentTypeId = created.data.appointmentTypeId

    const updateKey = randomUUID()
    await as(context.doctor, 'update_appointment_type',
      { appointmentTypeId, durationMinutes: 30, idempotencyKey: updateKey })
    await as(context.doctor, 'update_appointment_type',
      { appointmentTypeId, durationMinutes: 45 })

    const staleUpdate = await as(context.doctor, 'update_appointment_type',
      { appointmentTypeId, durationMinutes: 30, idempotencyKey: updateKey })
    assert.equal(staleUpdate.data.duplicate, true)
    assert.equal(staleUpdate.data.currentDurationMinutes, 45)
    assert.equal(staleUpdate.data.superseded, true,
      'an update stands only while what it set still says what it set')

    // A rename it never asked about does not supersede it.
    const durationKey = randomUUID()
    await as(context.doctor, 'update_appointment_type',
      { appointmentTypeId, durationMinutes: 50, idempotencyKey: durationKey })
    await as(context.doctor, 'update_appointment_type', { appointmentTypeId, name: 'Long review' })
    const stillStands = await as(context.doctor, 'update_appointment_type',
      { appointmentTypeId, durationMinutes: 50, idempotencyKey: durationKey })
    assert.equal(stillStands.data.superseded, false,
      'it said nothing about the name, so a rename is not its business')

    // And a creation answers the SAME question, because its reply is
    // "Another added, 20 minutes" and not "a row exists".
    const createKey = randomUUID()
    const second = await as(context.doctor, 'create_appointment_type',
      { name: 'Another', durationMinutes: 20, idempotencyKey: createKey })
    await as(context.doctor, 'update_appointment_type',
      { appointmentTypeId: second.data.appointmentTypeId, durationMinutes: 35 })
    const createRetry = await as(context.doctor, 'create_appointment_type',
      { name: 'Another', durationMinutes: 20, idempotencyKey: createKey })
    assert.equal(createRetry.message, 'Another added, 20 minutes.',
      'it replays what it said')
    assert.equal(createRetry.data.currentDurationMinutes, 35)
    assert.equal(createRetry.data.superseded, true,
      'and says that sentence is no longer true of the clinic')

    // A creation is not superseded by a change it said nothing about; there is
    // nothing it said nothing about except `active`.
    const thirdKey = randomUUID()
    const third = await as(context.doctor, 'create_appointment_type',
      { name: 'Third', durationMinutes: 20, idempotencyKey: thirdKey })
    await as(context.doctor, 'update_appointment_type',
      { appointmentTypeId: third.data.appointmentTypeId, active: false })
    const thirdRetry = await as(context.doctor, 'create_appointment_type',
      { name: 'Third', durationMinutes: 20, idempotencyKey: thirdKey })
    assert.equal(thirdRetry.data.superseded, false)
    assert.equal(thirdRetry.data.currentActive, false)
  })

  test('an instant is compared as an instant, milliseconds and all', async () => {
    /*
     * The driver turns a timestamptz into a JavaScript `Date`, whose
     * `toString()` has no milliseconds. Comparing the recorded instant against
     * that dropped the fraction, so a booking made for 10:30:00.500 and
     * touched by nobody replayed with `superseded: true` — the tablet told its
     * committed booking no longer stood. Any client that does arithmetic and
     * then `toISOString()` sends this.
     */
    const context = await clinic()
    const scheduledAt = `${await clinicDate(1)}T10:30:00.500+05:30`
    const idempotencyKey = randomUUID()

    const first = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt, idempotencyKey,
    })
    const retry = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt, idempotencyKey,
    })

    assert.equal(retry.data.duplicate, true)
    assert.equal(retry.data.bookingId, first.data.bookingId)
    assert.equal(retry.data.superseded, false, 'nothing touched it')
    assert.match(String(retry.data.scheduledAt), /\.500Z$/,
      'and the half second is what was recorded, not a rounding of it')

    // And a real move at the same second, but a different fraction, IS a move.
    const moveKey = randomUUID()
    await as(context.doctor, 'reschedule_appointment', {
      bookingId: first.data.bookingId, reason: 'Nudged',
      scheduledAt: `${await clinicDate(1)}T10:30:00.750+05:30`, idempotencyKey: moveKey,
    })
    const stale = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt, idempotencyKey,
    })
    assert.equal(stale.data.superseded, true)
  })

  test('a window that is published, and one that is retired', async () => {
    /*
     * The two commands the contract gives a `superseded` row to and nothing
     * asserted. Neither can be superseded today — nothing re-activates a
     * window and nothing deletes one — so what these hold is that each says
     * the truthful `false` rather than nothing at all.
     */
    const context = await clinic('Booked Patient', { hours: false })
    const publishKey = randomUUID()
    const request = { kind: 'open', weekday: '3', startsAt: '09:00', endsAt: '13:00' }
    const published = await as(context.doctor, 'publish_availability',
      { ...request, idempotencyKey: publishKey })

    const publishRetry = await as(context.doctor, 'publish_availability',
      { ...request, idempotencyKey: publishKey })
    assert.equal(publishRetry.data.duplicate, true)
    assert.equal(publishRetry.data.currentActive, true)
    assert.equal(publishRetry.data.superseded, false)

    const retireKey = randomUUID()
    const availabilityId = published.data.availabilityId
    await as(context.doctor, 'retire_availability',
      { availabilityId, reason: 'Closed that afternoon', idempotencyKey: retireKey })
    const retireRetry = await as(context.doctor, 'retire_availability',
      { availabilityId, reason: 'Closed that afternoon', idempotencyKey: retireKey })
    assert.equal(retireRetry.data.duplicate, true)
    assert.equal(retireRetry.data.currentActive, false)
    assert.equal(retireRetry.data.superseded, false)

    // And retiring it is what it says: a published window that is no longer
    // published, with the booking made into it untouched.
    assert.equal(Number(await scalar(
      'select count(*)::int from jmc.provider_availability where active')), 0)
  })

  test('a malformed date is judged before the database is asked', async () => {
    /*
     * A GUARD, not a regression, and the distinction is worth the paragraph.
     *
     * `clinicMoment` is the one database round-trip still in front of the
     * receipt, and its blanket catch reported every failure — a reset, a
     * timeout, a deadlock — as "scheduledAt is not a time". On a retry after a
     * transient fault that tells a tablet its date is malformed while its
     * earlier request has already committed, which is the confusion the
     * receipt exists to end. Found by the independent review, and corrected by
     * judging the shape in JavaScript and narrowing the catch to 22007/22008.
     *
     * Reverting that correction does NOT make this test fail, and nothing in
     * this suite can: inducing a connection reset or a statement timeout
     * inside that one statement is not something a test here can arrange. What
     * this holds is the half that is observable — every shape a tablet sends
     * is accepted, and every shape that is not a time is refused in the
     * caller's own words rather than Postgres's.
     */
    const context = await clinic()
    // An absent value is a different sentence, and comes from a different
    // place: `value()` asks for it before this function is reached at all.
    await assert.rejects(
      () => book(context.doctor, { patientId: context.patientId, reason: 'Fever', scheduledAt: '' }),
      /scheduledAt is required/,
    )
    for (const bad of ['not a time', '2026-13-01T10:00', 'Tuesday']) {
      await assert.rejects(
        () => book(context.doctor, {
          patientId: context.patientId, reason: 'Fever', scheduledAt: bad,
        }),
        /is not a time/,
        `"${bad}" is not a time`)
    }
    // The thirtieth of February parses and is still not a day. It reaches the
    // database, comes back 22008, and is still the caller's fault.
    await assert.rejects(
      () => book(context.doctor, {
        patientId: context.patientId, reason: 'Fever', scheduledAt: '2026-02-30T10:00',
      }),
      /is not a time/,
    )
    // And the shapes a tablet actually sends all pass.
    for (const good of [
      `${await clinicDate(1)}T10:00`,
      `${await clinicDate(1)}T10:00:00`,
      `${await clinicDate(1)}T10:00:00.250Z`,
      `${await clinicDate(1)}T10:00:00+05:30`,
    ]) {
      const done = await book(context.doctor, {
        patientId: context.patientId, reason: 'Fever', scheduledAt: good,
        overrideReason: 'Seeing them together',
      })
      assert.ok(done.data.bookingId, good)
    }
  })

  test('a priority stands only while the visit carries what that request set', async () => {
    const context = await clinic()
    await as(context.nurse, 'create_appointment',
      { patientId: context.patientId, reason: 'Cough', scheduledAt: new Date().toISOString() })
    const arrivalId = String(await scalar('select id from jmc.appointments'))

    const idempotencyKey = randomUUID()
    await as(context.doctor, 'set_queue_priority',
      { appointmentId: arrivalId, reason: 'Chest pain', idempotencyKey })
    // Still urgent, for a different reason: a second decision, not this one.
    await as(context.doctor, 'set_queue_priority',
      { appointmentId: arrivalId, reason: 'Breathing badly' })

    const retry = await as(context.doctor, 'set_queue_priority',
      { appointmentId: arrivalId, reason: 'Chest pain', idempotencyKey })
    assert.equal(retry.data.superseded, true,
      'the flag is unchanged and the decision behind it is not this one')
    assert.equal(retry.data.currentUrgentReason, 'Breathing badly')
  })

  test('a booking is superseded by a move, not only by a cancellation', async () => {
    const context = await clinic()
    const idempotencyKey = randomUUID()
    const scheduledAt = await at(1, '10:00')
    const first = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt, idempotencyKey,
    })
    await as(context.doctor, 'reschedule_appointment',
      { bookingId: first.data.bookingId, scheduledAt: await at(2, '10:00'), reason: 'Moved' })

    const retry = await book(context.doctor, {
      patientId: context.patientId, reason: 'Fever', scheduledAt, idempotencyKey,
    })
    assert.equal(retry.data.superseded, true)
    assert.equal(retry.data.currentStatus, 'booked', 'open, and not where this request put it')
  })
})
