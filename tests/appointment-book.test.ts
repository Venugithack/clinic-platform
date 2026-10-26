/**
 * The appointment station's arithmetic: clinic time, published hours, and
 * what a replay says about the present.
 *
 * Each of these is a place a screen goes quietly wrong. A `datetime-local`
 * value read in the tablet's own zone books the morning clinic for the
 * afternoon; a weekly window applied on the wrong weekday tells a nurse the
 * doctor is in when he is not; and a replayed check-in printed without its
 * "since changed" puts a patient in a queue they have left.
 *
 * The process zone is set to one far from India for the whole file, so a
 * helper that leans on the machine's clock rather than the clinic's fails
 * here rather than only on a tablet somebody bought abroad.
 */
process.env.TZ = 'America/Los_Angeles'

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  clinicClock,
  clinicDayOfInstant,
  clinicLocalInput,
  clinicSpan,
  dayLabel,
  describeReplay,
  hoursForDay,
  isClinicLocalInput,
  noShowEligible,
  shiftDay,
  weekdayOf,
} from '../lib/appointment-book.ts'
import type { AvailabilityWindow } from '../lib/types.ts'

describe('the clinic clock, whatever the tablet thinks', () => {
  test('an instant is read back as the desk would type it, in IST', () => {
    // 04:30 UTC is 10:00 in Chennai; Los Angeles would say 21:30 the day before.
    assert.equal(clinicLocalInput('2026-09-25T04:30:00.000Z'), '2026-09-25T10:00')
    assert.equal(clinicClock('2026-09-25T04:30:00.000Z'), '10:00')
    assert.equal(clinicDayOfInstant('2026-09-24T19:00:00.000Z'), '2026-09-25', 'after 18:30 UTC it is tomorrow in the clinic')
  })

  test('a span is on the clinic clock and crosses the hour correctly', () => {
    assert.equal(clinicSpan('2026-09-25T04:15:00.000Z', 15), '09:45–10:00')
    assert.equal(clinicSpan('not a time', 15), '')
  })

  test('what the form sends is checked as the contract spells it, and never parsed', () => {
    assert.equal(isClinicLocalInput('2026-09-25T10:30'), true)
    assert.equal(isClinicLocalInput('2026-09-25T10:30:15'), true)
    assert.equal(isClinicLocalInput('2026-09-25'), false, 'a half-filled picker')
    assert.equal(isClinicLocalInput('2026-09-25T10:30Z'), false, 'a zone would make it absolute')
  })

  test('days move as calendar days, across months and years', () => {
    assert.equal(shiftDay('2026-09-30', 1), '2026-10-01')
    assert.equal(shiftDay('2026-01-01', -1), '2025-12-31')
    assert.equal(weekdayOf('2026-09-25'), 5, 'a Friday, whatever zone this machine is in')
    assert.match(dayLabel('2026-09-25'), /^Friday,? 25 September 2026$/)
  })
})

describe('owner item 69: when a no-show may be confirmed', () => {
  const start = Date.parse('2026-09-25T04:30:00.000Z')
  test('not before thirty minutes after the start', () => {
    assert.equal(noShowEligible('2026-09-25T04:30:00.000Z', start + 29 * 60_000), false)
    assert.equal(noShowEligible('2026-09-25T04:30:00.000Z', start + 30 * 60_000), true)
  })
})

describe('published hours are expanded, not invented', () => {
  const doctor = 'doctor-1'
  const window = (fields: Partial<AvailabilityWindow>): AvailabilityWindow => ({
    availabilityId: Math.random().toString(36),
    doctorId: doctor,
    kind: 'open',
    startsAt: '09:00',
    endsAt: '13:00',
    note: '',
    ...fields,
  })

  test('a weekly window applies on its weekday inside its effective range', () => {
    const fridays = window({ weekday: 5, effectiveFrom: '2026-09-01', effectiveTo: '2026-09-30' })
    assert.equal(hoursForDay([fridays], '2026-09-25')[0]?.open.length, 1)
    assert.deepEqual(hoursForDay([fridays], '2026-09-24'), [], 'a Thursday')
    assert.deepEqual(hoursForDay([fridays], '2026-10-02'), [], 'a Friday after it ended')
    assert.deepEqual(
      hoursForDay([window({ weekday: 5, effectiveFrom: '2026-10-01' })], '2026-09-25'),
      [],
      'a Friday before it began',
    )
  })

  test('a dated window applies on its date alone, and blocked time is kept separate', () => {
    const hours = hoursForDay(
      [
        window({ weekday: 5, effectiveFrom: '2026-09-01' }),
        window({ onDate: '2026-09-25', kind: 'blocked', startsAt: '11:00', endsAt: '11:30', note: 'Wedding' }),
        window({ onDate: '2026-09-26', kind: 'blocked', startsAt: '09:00', endsAt: '10:00' }),
      ],
      '2026-09-25',
    )
    assert.equal(hours.length, 1)
    assert.equal(hours[0].open.length, 1)
    assert.deepEqual(hours[0].blocked.map((entry) => entry.note), ['Wedding'])
  })

  test('a day with nothing published is reported as nothing, never as a default', () => {
    assert.deepEqual(hoursForDay([], '2026-09-25'), [])
  })
})

describe('a replay is two facts', () => {
  test('a check-in that still stands adds nothing', () => {
    const reading = describeReplay('check_in_appointment', {
      token: 'JMC-0001', duplicate: true, superseded: false,
      currentArrivalStatus: 'waiting', currentBookingStatus: 'checked_in',
    })
    assert.deepEqual(reading, { duplicate: true, superseded: false })
  })

  test('a check-in since undone names the token and says the patient is not in the queue under it', () => {
    const reading = describeReplay('check_in_appointment', {
      token: 'JMC-0001', duplicate: true, superseded: true,
      currentArrivalStatus: 'cancelled', currentBookingStatus: 'booked',
    })
    assert.equal(reading.superseded, true)
    assert.match(reading.now ?? '', /JMC-0001 is cancelled/)
    assert.match(reading.now ?? '', /not in the queue under JMC-0001/)
    assert.match(reading.now ?? '', /booked, and not in the queue/)
  })

  test('a move since overtaken says where the booking is now, in clinic time as sent', () => {
    const reading = describeReplay('reschedule_appointment', {
      scheduledAt: '2026-09-25T05:30:00.000Z', duplicate: true, superseded: true,
      currentStatus: 'booked', currentScheduledAt: '2026-09-25 12:00',
    })
    assert.match(reading.now ?? '', /at 2026-09-25 12:00/)
  })

  test('a first answer is neither', () => {
    assert.deepEqual(describeReplay('book_appointment', { bookingId: 'b' }), { duplicate: false, superseded: false })
    assert.deepEqual(describeReplay('book_appointment', undefined), { duplicate: false, superseded: false })
  })
})
