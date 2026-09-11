/**
 * Rupees, counted in paise.
 *
 * The database columns are `numeric(12,2)` as of Slice 3, which is exact. That
 * exactness survives the round trip only if nothing in between turns an amount
 * into a JavaScript number and adds it up: `0.1 + 0.2` is 0.30000000000000004
 * in this language as much as in any other, and a day's takings is a few
 * hundred additions.
 *
 * So amounts are integers of paise everywhere inside the backend, converted at
 * the two edges — parsed on the way in from the tablet, formatted on the way
 * out to `numeric`. `postgres` returns `numeric` as a string precisely so the
 * value is not silently narrowed; `parseMoney` is the only thing that should
 * read one.
 *
 * Nothing here is clever. It is here so that there is exactly one place that
 * knows a rupee has a hundred parts.
 */

/** An amount in whole paise. Always an integer; may be negative for a credit. */
export type Paise = number

/** Twelve digits of `numeric(12,2)` is ten before the point. */
const MAX_PAISE = 9_999_999_999_99

/**
 * Read an amount from a tablet payload or a `numeric` column.
 *
 * Accepts `30`, `"30"`, `"30.00"`, `30.5`, `"₹30.50"`. Refuses anything with
 * more than two decimal places rather than rounding it: a third decimal in a
 * price is a typo or a unit confusion, and silently dropping it is how a
 * ₹1.005 becomes a rupee in one place and two in another.
 */
export function parseMoney(input: unknown, label: string, { min = 0 }: { min?: number } = {}): Paise {
  const raw = String(input ?? '').trim().replace(/^₹\s*/, '').replace(/,/g, '')
  if (raw === '') throw new Error(`${label} is required.`)

  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(raw)
  if (!match) {
    if (/^-?\d+\.\d{3,}$/.test(raw)) {
      throw new Error(`${label} has more than two decimal places. The smallest amount is one paisa.`)
    }
    throw new Error(`${label} is not an amount in rupees.`)
  }

  const sign = match[1] === '-' ? -1 : 1
  const paise = sign * (Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0')))

  if (!Number.isSafeInteger(paise) || Math.abs(paise) > MAX_PAISE) {
    throw new Error(`${label} is larger than this clinic's ledger can hold.`)
  }
  if (paise < min * 100) {
    throw new Error(min === 0 ? `${label} cannot be negative.` : `${label} must be at least ₹${min}.`)
  }
  return paise
}

/** The same, but an absent value is allowed and comes back as undefined. */
export function parseOptionalMoney(
  input: unknown,
  label: string,
  options?: { min?: number },
): Paise | undefined {
  const raw = String(input ?? '').trim()
  return raw === '' ? undefined : parseMoney(raw, label, options)
}

/** What goes into a `numeric(12,2)` parameter: "1234.50", never 1234.5. */
export function money(paise: Paise): string {
  assertInteger(paise, 'money')
  const sign = paise < 0 ? '-' : ''
  const absolute = Math.abs(paise)
  return `${sign}${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

/** What goes on a screen or into an audit summary. */
export function rupees(paise: Paise): string {
  return `₹${money(paise)}`
}

/** An amount repeated a whole number of times. Exact by construction. */
export function times(paise: Paise, count: number): Paise {
  assertInteger(paise, 'amount')
  assertInteger(count, 'count')
  const total = paise * count
  if (!Number.isSafeInteger(total)) throw new Error('That total is larger than this ledger can hold.')
  return total
}

/** Adds amounts. Present so that no caller is tempted to use `reduce` on floats. */
export function sum(amounts: Paise[]): Paise {
  let total = 0
  for (const amount of amounts) {
    assertInteger(amount, 'amount')
    total += amount
  }
  if (!Number.isSafeInteger(total)) throw new Error('That total is larger than this ledger can hold.')
  return total
}

/**
 * The price of part of a package.
 *
 * A strip of fifteen marked ₹30 makes one tablet ₹2 exactly; a strip of
 * fourteen does not. The approval pack's price rule is to calculate with exact
 * decimals and round ONCE at the line, so this multiplies first and divides
 * last — `round(amount × quantity ÷ factor)` — rather than rounding a unit
 * price and multiplying the error up.
 *
 * Half-up, which is what a pharmacist does with a coin, and what
 * `numeric`'s own `round()` does, so a figure computed here and a figure
 * computed in SQL agree.
 */
export function proRata(paise: Paise, quantity: number, factor: number): Paise {
  assertInteger(paise, 'amount')
  assertInteger(quantity, 'quantity')
  assertInteger(factor, 'package factor')
  if (factor <= 0) throw new Error('A package factor is a positive whole number.')
  if (quantity < 0) throw new Error('A quantity cannot be negative.')

  const numerator = paise * quantity
  if (!Number.isSafeInteger(numerator)) {
    throw new Error('That line is larger than this ledger can price exactly.')
  }
  const sign = numerator < 0 ? -1 : 1
  return sign * Math.floor((Math.abs(numerator) * 2 + factor) / (factor * 2))
}

function assertInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`An internal ${label} was not a whole number of paise.`)
  }
}
