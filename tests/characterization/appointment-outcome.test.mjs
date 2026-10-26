/**
 * What one appointment reference did, asked after the reply was lost.
 *
 * ── WHY THIS READ EXISTS ───────────────────────────────────────────────────
 *
 * The appointment commands already answer a lost reply — to an exact retry
 * under the same reference. A tablet reloaded after the reply went missing
 * does not have the exact request any more, and the station is forbidden to
 * keep the patient, the time and the clinical reason in browser storage just
 * to rebuild it. `view=outcome` could not help: it has never read
 * `appointment_command_receipts`, and told a doctor that nothing in the clinic
 * carried a reference that had in fact made a booking.
 *
 * So the tablet keeps the reference alone and asks
 * `workspace?view=appointment_outcome`. Every test here goes through the real
 * endpoint and the real commands against the scratch database, and each one
 * pins one sentence of `SLICE2_FRONTEND_CONTRACT.md` §4.0a.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, test } from 'node:test'
import postgres from 'postgres'
import { edgeGet } from '../support/backend.mjs'
import {
  as as rawAs, clinicDate, closeClinic, makeStaff, resetClinic, scalar, tokenFor,
} from '../support/clinic.mjs'
import { RECEIPT_LOCK_NAMESPACE } from '../../supabase/functions/_shared/appointments.ts'

after(async () => { await closeClinic() })

const KEYED = new Set([
  'book_appointment', 'reschedule_appointment', 'cancel_appointment',
  'mark_no_show', 'check_in_appointment', 'publish_availability',
])

/** Every appointment command needs a reference; a test that passes one means it. */
const as = (staff, action, payload = {}) => rawAs(
  staff, action,
  KEYED.has(action) && !payload.idempotencyKey ? { ...payload, idempotencyKey: randomUUID() } : payload,
)

/** A clinic with its doors open every day, one doctor, two nurses, one patient. */
async function clinic({ hours = true } = {}) {
  await resetClinic()
  const doctor = await makeStaff({ name: 'Doctor', roles: ['doctor'], username: 'doc', pin: '5731' })
  const nurse = await makeStaff({ name: 'Nurse', roles: ['nurse'], username: 'nur', pin: '5732' })
  const otherNurse = await makeStaff({ name: 'Other Nurse', roles: ['nurse'], username: 'nu2', pin: '5735' })
  const admin = await makeStaff({ name: 'Admin', roles: ['admin'], username: 'adm', pin: '5733' })
  const pharmacist = await makeStaff({ name: 'Pharmacist', roles: ['pharmacy'], username: 'pha', pin: '5734' })
  await as(doctor, 'create_patient', { name: 'Booked Patient', age: 40, sex: 'male', phone: '+919990000001' })
  const patientId = String(await scalar(`select id from jmc.patients where name='Booked Patient'`))
  if (hours) {
    const from = await clinicDate(-30)
    for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
      await as(doctor, 'publish_availability', {
        kind: 'open', weekday: String(weekday), startsAt: '00:00', endsAt: '23:59', effectiveFrom: from,
      })
    }
  }
  return { doctor, nurse, otherNurse, admin, pharmacist, patientId }
}

async function ask(staff, key) {
  const { status, body } = await edgeGet(
    'workspace', `?view=appointment_outcome&key=${encodeURIComponent(key)}`, await tokenFor(staff))
  return { status, outcome: body.outcome, body }
}

const tomorrowAt = async (hhmm) => `${await clinicDate(1)}T${hhmm}`

/**
 * The refusal a command raised. In process the command layer throws a
 * `CommandRefusal`; the `command` endpoint is what turns it into
 * `{ ok: false, code }`, and a refusal is the whole point of these tests.
 */
async function refusalOf(pending) {
  try {
    await pending
  } catch (error) {
    return error
  }
  assert.fail('expected the clinic to refuse this')
}

describe('a reference that committed', () => {
  test('tells its sender what it did, exactly as a replay would', async () => {
    const { nurse, patientId } = await clinic()
    const idempotencyKey = randomUUID()
    const request = { patientId, reason: 'Fever', scheduledAt: await tomorrowAt('10:30'), idempotencyKey }
    const booked = await as(nurse, 'book_appointment', request)
    assert.equal(booked.data.duplicate, undefined)

    const { status, outcome } = await ask(nurse, idempotencyKey)
    assert.equal(status, 200)
    assert.equal(outcome.state, 'committed')
    assert.equal(outcome.command, 'book_appointment')
    assert.equal(outcome.bookingId, booked.data.bookingId)
    assert.equal(outcome.patientId, patientId)
    assert.equal(outcome.message, booked.message)
    assert.equal(outcome.data.superseded, false)
    assert.equal(outcome.data.currentStatus, 'booked')

    // The replay and the read are built from one table of `standing`, so they
    // cannot disagree about whether the booking still stands.
    const replay = await as(nurse, 'book_appointment', request)
    assert.equal(replay.data.duplicate, true)
    const { duplicate: _duplicate, ...replayed } = replay.data
    assert.deepEqual(outcome.data, replayed)
    assert.ok(Number.isFinite(Date.parse(outcome.at)), 'the receipt time is an instant')
  })

  test('a check-in since undone comes back with its token AND the fact that it no longer stands', async () => {
    const { doctor, nurse, patientId } = await clinic()
    const booked = await as(nurse, 'book_appointment', {
      patientId, reason: 'Fever', scheduledAt: `${await clinicDate(0)}T23:30`,
    })
    const bookingId = booked.data.bookingId
    const idempotencyKey = randomUUID()
    const checkedIn = await as(nurse, 'check_in_appointment', { bookingId, idempotencyKey })
    const token = checkedIn.data.token

    // A doctor moves it after check-in, which takes the patient out of the queue.
    await as(doctor, 'reschedule_appointment', {
      bookingId, scheduledAt: await tomorrowAt('11:00'), reason: 'Asked to come back',
    })

    const { outcome } = await ask(nurse, idempotencyKey)
    assert.equal(outcome.state, 'committed')
    assert.equal(outcome.data.token, token, 'what the reference did')
    assert.equal(outcome.data.superseded, true, 'and that it no longer holds')
    assert.equal(outcome.data.currentArrivalStatus, 'cancelled')
    assert.equal(outcome.data.currentBookingStatus, 'booked')
    assert.equal(
      Number(await scalar(`select count(*) from jmc.appointments where booking_id=$1`, [bookingId])), 1,
      'asking created nothing',
    )
  })
})

describe('actor-scoped, not merely role-scoped', () => {
  test('a colleague asking about somebody else’s reference is told only that it is not theirs', async () => {
    const { nurse, otherNurse, doctor, patientId } = await clinic()
    const idempotencyKey = randomUUID()
    await as(nurse, 'book_appointment', {
      patientId, reason: 'Private reason', scheduledAt: await tomorrowAt('09:00'), idempotencyKey,
    })

    for (const colleague of [otherNurse, doctor]) {
      const { status, outcome } = await ask(colleague, idempotencyKey)
      assert.equal(status, 200)
      assert.equal(outcome.state, 'not_yours', colleague.name)
      assert.equal(outcome.data, undefined)
      assert.equal(outcome.message, undefined)
      assert.equal(outcome.bookingId, undefined)
      assert.equal(outcome.patientId, undefined)
      assert.equal(JSON.stringify(outcome).includes('Private reason'), false)
    }

    // And the server agrees it can never be theirs to retry.
    const reused = await refusalOf(as(otherNurse, 'book_appointment', {
      patientId, reason: 'Private reason', scheduledAt: await tomorrowAt('09:00'), idempotencyKey,
    }))
    assert.equal(reused.code, 'APPOINTMENT_REFERENCE_REUSED')
  })

  test('pharmacy is refused at the endpoint, not merely not shown the station', async () => {
    const { pharmacist } = await clinic({ hours: false })
    const { status, body } = await ask(pharmacist, randomUUID())
    assert.equal(status, 403)
    assert.equal(body.ok, false)
  })
})

describe('a reference that did not commit', () => {
  test('a reference nobody has used is reported as nothing recorded', async () => {
    const { nurse } = await clinic({ hours: false })
    const { outcome } = await ask(nurse, randomUUID())
    assert.equal(outcome.state, 'not_committed')
    assert.match(outcome.detail, /same reference/)
  })

  test('a refusal writes no receipt: the reference stays unspent for the corrected request', async () => {
    // No hours published, so a nurse is refused and there is no override.
    const { nurse, doctor, patientId } = await clinic({ hours: false })
    const idempotencyKey = randomUUID()
    const scheduledAt = await tomorrowAt('03:00')
    const refused = await refusalOf(as(nurse, 'book_appointment', { patientId, reason: 'Fever', scheduledAt, idempotencyKey }))
    assert.equal(refused.code, 'OUTSIDE_PUBLISHED_AVAILABILITY')
    assert.equal((await ask(nurse, idempotencyKey)).outcome.state, 'not_committed')

    // The doctor's override path: refused once, asked for a reason, then the
    // SAME reference with the reason — owner item 67's two steps.
    const doctorKey = randomUUID()
    const asked = await refusalOf(as(doctor, 'book_appointment', { patientId, reason: 'Fever', scheduledAt, idempotencyKey: doctorKey }))
    assert.equal(asked.code, 'OVERRIDE_REASON_REQUIRED')
    assert.equal((await ask(doctor, doctorKey)).outcome.state, 'not_committed', 'the question spent nothing')
    const placed = await as(doctor, 'book_appointment', {
      patientId, reason: 'Fever', scheduledAt, idempotencyKey: doctorKey, overrideReason: 'Early surgical review',
    })
    assert.equal(placed.data.outsideAvailability, true)
    const { outcome } = await ask(doctor, doctorKey)
    assert.equal(outcome.state, 'committed')
    assert.equal(outcome.data.currentOutsideAvailability, true)
  })

  test('a request being carried out is in flight, not nothing', async () => {
    const { nurse } = await clinic({ hours: false })
    const idempotencyKey = randomUUID()
    const holder = postgres(process.env.STAGING_DB_URL, { max: 1 })
    try {
      // What `once()` holds between reading the receipt and committing it.
      await holder.unsafe('select pg_advisory_lock($1, hashtext($2))', [RECEIPT_LOCK_NAMESPACE, idempotencyKey])
      const { outcome } = await ask(nurse, idempotencyKey)
      assert.equal(outcome.state, 'in_flight')
    } finally {
      await holder.unsafe('select pg_advisory_unlock($1, hashtext($2))', [RECEIPT_LOCK_NAMESPACE, idempotencyKey])
      await holder.end()
    }
    assert.equal((await ask(nurse, idempotencyKey)).outcome.state, 'not_committed', 'and nothing once it lets go')
  })

  test('another database holding the same lock says nothing about this clinic', async () => {
    const { nurse } = await clinic({ hours: false })
    const idempotencyKey = randomUUID()
    const elsewhere = postgres(process.env.STAGING_DB_URL.replace(/\/[^/]*$/, '/postgres'), { max: 1 })
    try {
      await elsewhere.unsafe('select pg_advisory_lock($1, hashtext($2))', [RECEIPT_LOCK_NAMESPACE, idempotencyKey])
      assert.equal((await ask(nurse, idempotencyKey)).outcome.state, 'not_committed')
    } finally {
      await elsewhere.unsafe('select pg_advisory_unlock($1, hashtext($2))', [RECEIPT_LOCK_NAMESPACE, idempotencyKey])
      await elsewhere.end()
    }
  })
})

describe('the older lookup stops saying something untrue', () => {
  test('view=outcome no longer tells a doctor nothing carries a committed appointment reference', async () => {
    const { doctor, patientId } = await clinic()
    const idempotencyKey = randomUUID()
    await as(doctor, 'book_appointment', { patientId, reason: 'Fever', scheduledAt: await tomorrowAt('10:00'), idempotencyKey })

    const { body } = await edgeGet('workspace', `?view=outcome&key=${idempotencyKey}`, await tokenFor(doctor))
    assert.equal(body.outcome.operation, 'unknown', 'this lookup does not describe the appointment command')
    assert.equal(body.outcome.committed, true, 'a stored receipt proves a command committed')
    assert.match(body.outcome.detail, /appointment outcome lookup/)
  })
})

describe('the calendar speaks the contract’s instant', () => {
  test('scheduledAt is UTC ISO-8601 with milliseconds, not a Date’s toString', async () => {
    const { nurse, patientId } = await clinic()
    const day = await clinicDate(1)
    await as(nurse, 'book_appointment', { patientId, reason: 'Fever', scheduledAt: `${day}T10:30:00.500` })

    const { body } = await edgeGet('workspace', `?view=calendar&from=${day}`, await tokenFor(nurse))
    const [booking] = body.calendar.bookings
    // 10:30:00.500 in Chennai is 05:00:00.500 in UTC.
    assert.equal(booking.scheduledAt, `${day}T05:00:00.500Z`)
    assert.match(booking.lastEvent.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

    const history = await edgeGet('workspace', `?view=appointments&patientId=${patientId}`, await tokenFor(nurse))
    assert.match(history.body.appointments[0].history[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})
