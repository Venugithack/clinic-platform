/**
 * The appointment station's arithmetic, with no screen in it.
 *
 * Three things here would be easy to get subtly wrong inside a component and
 * are unit-tested instead:
 *
 *   1. **Clinic time, not browser time.** A booking is sent as the
 *      `datetime-local` string the desk typed — `2026-09-25T10:30` — and the
 *      server reads that as clinic-local (`SLICE2_FRONTEND_CONTRACT.md` §4).
 *      Nothing here ever passes that string through `new Date()`, which would
 *      read it in the tablet's own zone and move a morning appointment to the
 *      afternoon on any device not set to India. Instants coming back are
 *      shown through `Intl` pinned to Asia/Kolkata for the same reason.
 *   2. **Published hours are expanded, not invented.** The calendar read
 *      returns each window once; which windows apply to a day is worked out
 *      here, exactly as §5 describes, and a day with none is reported as a day
 *      with none — never as nine to five.
 *   3. **A replay is two facts.** What the reference did, and whether it
 *      still holds. `describeReplay` keeps both, so a token issued by a
 *      check-in that has since been undone is never printed as a patient in
 *      the queue.
 */
import type { AvailabilityWindow } from '@/lib/types'

export const CLINIC_ZONE = 'Asia/Kolkata'

/** Owner item 69: a booking may be confirmed as a no-show thirty minutes after its start. */
export const NO_SHOW_AFTER_MINUTES = 30

/** Owner item 65: the default length of an appointment, and the only one this station books. */
export const DEFAULT_APPOINTMENT_MINUTES = 15

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/

/* ─────────────────────────────────────────────────────────── days ── */

/** A calendar day moved by whole days, without any clock or zone involved. */
export function shiftDay(day: string, days: number): string {
  const match = YMD.exec(day)
  if (!match) return day
  const moved = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days))
  return moved.toISOString().slice(0, 10)
}

/** 0 Sunday … 6 Saturday, the numbering `provider_availability.weekday` uses. */
export function weekdayOf(day: string): number {
  const match = YMD.exec(day)
  if (!match) return -1
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
}

const DAY_LABEL = new Intl.DateTimeFormat('en-IN', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

/** `Thursday, 25 September 2026` — a calendar day, read as one. */
export function dayLabel(day: string): string {
  const match = YMD.exec(day)
  if (!match) return day
  return DAY_LABEL.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))))
}

/* ───────────────────────────────────────────────────── clinic clock ── */

const PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: CLINIC_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function clinicParts(instant: Date): Record<string, string> {
  return Object.fromEntries(PARTS.formatToParts(instant).map((part) => [part.type, part.value]))
}

/**
 * An instant as the desk would type it back: `YYYY-MM-DDTHH:MM`, clinic-local.
 *
 * What the reschedule form starts from, so moving a booking by ten minutes is
 * editing its own time rather than retyping it. Empty for anything unreadable.
 */
export function clinicLocalInput(instant: string): string {
  const parsed = new Date(instant)
  if (Number.isNaN(parsed.getTime())) return ''
  const p = clinicParts(parsed)
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/** The clinic day an instant fell on. */
export function clinicDayOfInstant(instant: string): string {
  const local = clinicLocalInput(instant)
  return local ? local.slice(0, 10) : ''
}

/** `10:30`, on the clinic's clock. */
export function clinicClock(instant: string): string {
  const local = clinicLocalInput(instant)
  return local ? local.slice(11, 16) : ''
}

/** `10:30–10:45`, on the clinic's clock. */
export function clinicSpan(instant: string, minutes: number): string {
  const start = new Date(instant)
  if (Number.isNaN(start.getTime())) return ''
  const end = new Date(start.getTime() + minutes * 60_000)
  return `${clinicClock(start.toISOString())}–${clinicClock(end.toISOString())}`
}

/**
 * Whether what the desk typed is the shape the contract takes.
 *
 * `YYYY-MM-DDTHH:MM`, optionally with seconds — exactly what a
 * `datetime-local` input produces. Checked before sending so a half-filled
 * picker is a sentence on the form rather than a refusal from the clinic.
 */
export function isClinicLocalInput(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)
}

/**
 * Minutes past the start of a booking, now. Negative before it starts.
 *
 * Instants compared as instants, so neither zone is involved.
 */
export function minutesPast(instant: string, now: number = Date.now()): number {
  const start = Date.parse(instant)
  if (!Number.isFinite(start)) return Number.NaN
  return Math.floor((now - start) / 60_000)
}

/**
 * Owner item 69. A person may confirm a no-show once thirty minutes have gone
 * by; nothing happens at thirty minutes by itself, and this only decides
 * whether the control is offered. The command decides whether it is allowed.
 */
export function noShowEligible(instant: string, now: number = Date.now()): boolean {
  const past = minutesPast(instant, now)
  return Number.isFinite(past) && past >= NO_SHOW_AFTER_MINUTES
}

/* ─────────────────────────────────────────────────── published hours ── */

export type DayHours = {
  doctorId: string
  open: AvailabilityWindow[]
  blocked: AvailabilityWindow[]
}

/**
 * Which published windows apply to one clinic day, per doctor.
 *
 * §5 of the contract, verbatim: a `weekday` window applies on that weekday
 * inside `effectiveFrom`…`effectiveTo`; an `onDate` window applies on that
 * date; `blocked` subtracts from whatever `open` windows overlap it. The
 * subtraction is left to the reader — both lists are returned, with their
 * notes — because "open nine to one, blocked eleven to half past" is what a
 * nurse needs to see, and a computed "nine to eleven, half past eleven to
 * one" hides why.
 *
 * ISO dates compare correctly as strings, which is the only arithmetic here.
 */
export function hoursForDay(windows: AvailabilityWindow[], day: string): DayHours[] {
  const weekday = weekdayOf(day)
  const applies = (window: AvailabilityWindow) => {
    if (window.onDate) return window.onDate === day
    if (window.weekday === undefined || window.weekday !== weekday) return false
    if (window.effectiveFrom && window.effectiveFrom > day) return false
    if (window.effectiveTo && window.effectiveTo < day) return false
    return true
  }

  const byDoctor = new Map<string, DayHours>()
  for (const window of windows) {
    if (!applies(window)) continue
    const entry = byDoctor.get(window.doctorId) ?? { doctorId: window.doctorId, open: [], blocked: [] }
    if (window.kind === 'blocked') entry.blocked.push(window)
    else entry.open.push(window)
    byDoctor.set(window.doctorId, entry)
  }

  for (const entry of byDoctor.values()) {
    entry.open.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    entry.blocked.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  }
  return [...byDoctor.values()]
}

/* ─────────────────────────────────────────────────────────── replays ── */

const STATUS_WORD: Record<string, string> = {
  booked: 'booked, and not in the queue',
  checked_in: 'checked in',
  cancelled: 'cancelled',
  no_show: 'closed as not attended',
}

const ARRIVAL_WORD: Record<string, string> = {
  waiting: 'waiting in the queue',
  in_consult: 'with the doctor',
  done: 'finished',
  cancelled: 'cancelled',
}

export type ReplayReading = {
  /** The clinic answered with an outcome it had already recorded. */
  duplicate: boolean
  /** What was recorded no longer describes the clinic. */
  superseded: boolean
  /**
   * The sentence about now, when it differs from what was recorded. Never a
   * reassurance: absent means "nothing to add", not "all is well".
   */
  now?: string
}

/**
 * What a replayed — or recovered — outcome says about the present.
 *
 * `data` is a command's `data` as it arrived: the original result, with
 * `duplicate`, `superseded` and the `current…` fields merged over it
 * (§4.0). `currentScheduledAt` is clinic-local `YYYY-MM-DD HH:MM` for
 * printing and is printed as it is; it is never compared with `scheduledAt`.
 */
export function describeReplay(act: string, data: Record<string, unknown> | undefined): ReplayReading {
  const record = data ?? {}
  const duplicate = record.duplicate === true
  const superseded = record.superseded === true
  if (!superseded) return { duplicate, superseded }

  if (act === 'check_in_appointment') {
    const token = typeof record.token === 'string' ? record.token : 'That token'
    const arrival = typeof record.currentArrivalStatus === 'string'
      ? ARRIVAL_WORD[record.currentArrivalStatus] ?? record.currentArrivalStatus
      : 'no longer in the queue'
    const booking = typeof record.currentBookingStatus === 'string'
      ? STATUS_WORD[record.currentBookingStatus] ?? record.currentBookingStatus
      : ''
    return {
      duplicate,
      superseded,
      now:
        `${token} is ${arrival}${booking ? `, and the appointment is ${booking}` : ''}. ` +
        `The patient is not in the queue under ${token}.`,
    }
  }

  const status = typeof record.currentStatus === 'string'
    ? STATUS_WORD[record.currentStatus] ?? record.currentStatus
    : ''
  const at = typeof record.currentScheduledAt === 'string' ? record.currentScheduledAt : ''
  const flags = [
    record.currentOverbooked === true ? 'overbooked' : '',
    record.currentOutsideAvailability === true ? 'outside the published hours' : '',
  ].filter(Boolean)

  return {
    duplicate,
    superseded,
    now:
      `It has changed since: the appointment is now ${status || 'different'}` +
      `${at ? `, at ${at}` : ''}${flags.length ? ` (${flags.join(', ')})` : ''}.`,
  }
}
