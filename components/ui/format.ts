/**
 * Every value that would matter if it were transcribed wrong is formatted in
 * exactly one place, so a quantity reads the same on the counter, in the
 * register and on the printed receipt.
 */

const DATE_TIME = new Intl.DateTimeFormat('en-IN', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

const DATE = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

const MONTH_YEAR = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric' })

const MONEY = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })

export function formatDate(value: string) {
  return DATE_TIME.format(new Date(value))
}

export function formatDay(value: string) {
  return DATE.format(new Date(value))
}

/**
 * An expiry is printed on the strip as a month and a year, so it is read back
 * the same way. A bare day/month made a long-dead batch read as a near miss in
 * the reference application; this is that fix carried over.
 */
export function formatExpiry(value: string) {
  return MONTH_YEAR.format(new Date(value))
}

export function money(value: number) {
  return MONEY.format(value)
}

/** `partially_delivered` → `partially delivered`. Status words, never codes. */
export function words(value: string) {
  return value.replaceAll('_', ' ')
}

/**
 * The date it is in the clinic, not the date it is in Greenwich.
 *
 * `new Date().toISOString()` is UTC and IST runs five and a half hours ahead of
 * it, so from midnight until half past five every morning the UTC date is still
 * yesterday. Three screens were deciding what "today" meant that way: the shelf
 * read a batch that expired last night as good, the day book bucketed the
 * night's cash into the wrong day, and the register offered the wrong month.
 * One definition, in the place that already owns every other value that would
 * matter if it were transcribed wrong.
 */
const CLINIC_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function clinicDay(value: Date): string {
  const parts = new Map(CLINIC_DAY.formatToParts(value).map((part) => [part.type, part.value]))
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`
}

/** Today's date in the clinic, as a plain YYYY-MM-DD to compare against. */
export function clinicToday(): string {
  return clinicDay(new Date())
}

/**
 * Which clinic day a stored instant fell on.
 *
 * Every timestamp in this schema is an ISO string in UTC, so asking whether one
 * `startsWith(today)` compares a clinic date against a Greenwich one and drops
 * the takings between midnight and 05:30 into the previous day. The instant has
 * to be converted before the day can be read off it.
 */
export function clinicDayOf(value: string): string {
  return clinicDay(new Date(value))
}
