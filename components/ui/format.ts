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
