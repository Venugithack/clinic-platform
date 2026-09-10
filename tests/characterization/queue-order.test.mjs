/**
 * The order patients are called in.
 *
 * `appointments.scheduled_at` is TEXT and the queue is `order by
 * scheduled_at`, so the ordering is a string comparison. That is fine while
 * every value has the same shape and silently wrong the moment two do not —
 * and two did. The desk form is an `<input type="datetime-local">` sending
 * `2026-09-11T10:30`, while everything written in code sends
 * `toISOString()`: `2026-09-11T05:30:00.000Z`. Sorted as text,
 * `2026-09-11T0…` beats `2026-09-11T1…`, so an eleven o'clock walk-in sorted
 * above a quarter-past-nine appointment and a patient was called in out of
 * turn. Nothing errored; the queue just looked wrong.
 *
 * Slice 1 made it likelier rather than causing it — the doctor-alone path
 * books from Consult, in code, in ISO — so the fix belongs here.
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import { snapshot } from '../support/backend.mjs'
import { as, closeClinic, makeStaff, resetClinic, rows, scalar, sessionFor } from '../support/clinic.mjs'

after(async () => { await closeClinic() })

async function clinic() {
  await resetClinic()
  const nurse = await makeStaff({ name: 'Nurse', roles: ['nurse'], username: 'nur', pin: '6182' })
  const doctor = await makeStaff({ name: 'Doctor', roles: ['doctor'], username: 'doc', pin: '5731' })

  await as(nurse, 'create_patient', { name: 'Early Bird', age: 40, sex: 'female', phone: '+9990000001' })
  await as(nurse, 'create_patient', { name: 'Mid Morning', age: 41, sex: 'male', phone: '+9990000002' })
  await as(nurse, 'create_patient', { name: 'Late Walkin', age: 42, sex: 'male', phone: '+9990000003' })

  const idOf = async (name) => String(await scalar('select id from jmc.patients where name=$1', [name]))
  return {
    nurse, doctor,
    early: await idOf('Early Bird'),
    mid: await idOf('Mid Morning'),
    late: await idOf('Late Walkin'),
  }
}

/** Today, in the clinic rather than in Greenwich. */
async function clinicDay() {
  return String(await scalar(`select (now() at time zone 'Asia/Kolkata')::date::text`))
}

describe('a time is stored in one shape, whoever wrote it', () => {
  test('a desk booking and a walk-in booked in code sort by real time', async () => {
    const { nurse, doctor, early, mid, late } = await clinic()
    const day = await clinicDay()

    // The desk form's shape: local, no zone.
    await as(nurse, 'create_appointment', { patientId: early, reason: 'Review', scheduledAt: `${day}T09:15` })
    await as(nurse, 'create_appointment', { patientId: mid, reason: 'Fever', scheduledAt: `${day}T10:30` })

    // The doctor-alone path's shape: absolute, UTC. 11:00 clinic time is
    // 05:30Z, which is exactly the value that used to sort to the top.
    const elevenClinicTime = String(await scalar(
      `select to_char((($1 || ' 11:00')::timestamp at time zone 'Asia/Kolkata') at time zone 'utc',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
      [day],
    ))
    await as(doctor, 'create_appointment', { patientId: late, reason: 'Chest pain', scheduledAt: elevenClinicTime })

    const queue = (await snapshot.readSnapshot(sessionFor(doctor))).appointments
    assert.deepEqual(
      queue.map((entry) => entry.patientName),
      ['Early Bird', 'Mid Morning', 'Late Walkin'],
      'the eleven o’clock walk-in must not be called before the quarter-past-nine appointment',
    )
  })

  test('every stored value has the same shape', async () => {
    const { nurse, doctor, early, late } = await clinic()
    const day = await clinicDay()

    await as(nurse, 'create_appointment', { patientId: early, reason: 'Review', scheduledAt: `${day}T09:15` })
    await as(doctor, 'create_appointment', {
      patientId: late, reason: 'Walk-in', scheduledAt: new Date().toISOString(),
    })

    for (const row of await rows('select scheduled_at from jmc.appointments')) {
      assert.match(
        String(row.scheduled_at),
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        `stored as "${row.scheduled_at}", which is a second shape in a column that is sorted as text`,
      )
    }
  })

  test('a naive time is read as clinic time, not as the server’s', async () => {
    const { nurse, early } = await clinic()
    const day = await clinicDay()

    // The server runs UTC. Parsing '09:15' with JavaScript's Date would take
    // it as 09:15Z — 14:45 in the clinic — so the conversion is done by
    // Postgres against Asia/Kolkata instead.
    await as(nurse, 'create_appointment', { patientId: early, reason: 'Review', scheduledAt: `${day}T09:15` })

    const backInClinicTime = String(await scalar(
      `select to_char((scheduled_at::timestamptz) at time zone 'Asia/Kolkata', 'HH24:MI') from jmc.appointments`,
    ))
    assert.equal(backInClinicTime, '09:15')
  })

  test('a time that is not a time is refused before a token is burnt', async () => {
    const { nurse, early } = await clinic()

    await assert.rejects(
      as(nurse, 'create_appointment', { patientId: early, reason: 'Review', scheduledAt: 'tomorrow-ish' }),
      /scheduledAt|invalid input|date\/time/i,
    )

    // The token sequence hands out numbers outside the transaction, so a
    // refusal after `sequence()` would leave a gap in the queue numbering for
    // a patient who was never booked. Normalising first avoids it.
    assert.equal(await scalar('select count(*)::int from jmc.appointments'), 0)
    assert.equal(Number(await scalar('select last_value from jmc.appointment_token_seq')), 1)
  })
})
