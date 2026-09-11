/**
 * Reading a tablet's payload, and the two checks every command starts with.
 *
 * These were private to commands.ts until Slice 3 gave the formulary, packages,
 * receiving and stock their own module. Two copies of `requireRole` is how one
 * of them ends up subtly weaker than the other, so there is one copy and both
 * modules import it.
 *
 * Everything here refuses rather than coerces. A quantity that is not a whole
 * number, a choice that is not one of the offered choices and a date that is
 * not a date are all mistakes worth a sentence, and none of them should reach
 * a table as a zero, an empty string or a NaN.
 */
import { hasRole } from './auth.ts'
import { db } from './db.ts'
import type { Role, SessionView } from './types.ts'

export type Payload = Record<string, unknown>

export function value(payload: Payload, key: string) {
  const result = payload[key]
  if (result == null || String(result).trim() === '') throw new Error(`${key} is required.`)
  return String(result).trim()
}

export function optional(payload: Payload, key: string) {
  return String(payload[key] ?? '').trim()
}

export function numberValue(payload: Payload, key: string, minimum = 0) {
  const result = Number(payload[key])
  if (!Number.isFinite(result) || result < minimum) throw new Error(`${key} must be at least ${minimum}.`)
  return result
}

export function booleanValue(payload: Payload, key: string) {
  return payload[key] === true || payload[key] === 1 || payload[key] === 'true'
}

export function optionalPositiveInteger(payload: Payload, key: string): number | undefined {
  const raw = optional(payload, key)
  if (!raw) return undefined
  const result = Number(raw)
  if (!Number.isInteger(result) || result <= 0) throw new Error(`${key} must be a whole number above zero.`)
  return result
}

export function optionalDate(payload: Payload, key: string): string | undefined {
  const result = optional(payload, key)
  if (!result) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) {
    throw new Error(`${key} is not a valid date.`)
  }
  return result
}

export function requireRole(session: SessionView, ...roles: Role[]) {
  if (!hasRole(session, ...roles)) throw new Error('Your role cannot perform this action.')
}

export function requireChoice<T extends string>(
  payload: Payload,
  key: string,
  choices: readonly T[],
  fallback?: T,
) {
  // A missing value takes the fallback where one is offered — a medicine added
  // before the schedule field existed should become 'unset', not fail to save.
  const raw = String(payload[key] ?? '').trim()
  if (!raw && fallback !== undefined) return fallback

  const result = value(payload, key) as T
  if (!choices.includes(result)) throw new Error(`${key} is not valid.`)
  return result
}

/**
 * The next number in a printed series — OTC-0008, PO-0042, JMC-0004.
 *
 * This used to count the rows in the table and add one, which fails in two
 * different ways that both end at the same place. Two tablets ringing up a sale
 * in the same second read the same count and mint the same receipt number; the
 * second insert dies on the unique index and the counter is told "The request
 * could not be completed." for a sale that was perfectly good. And a deleted
 * row lowers the count, so the series walks backwards over numbers that are
 * already printed on paper and written in somebody's ledger.
 *
 * Queue tokens are the quiet half of the same bug. `appointments.token` carries
 * no unique index, so nothing objects at all: two waiting patients simply hold
 * the same number, and one of them is called in for the other's consultation.
 *
 * A Postgres sequence hands each number to exactly one caller no matter what
 * else is happening, and it does so OUTSIDE the transaction — a sale that rolls
 * back burns its number and leaves a gap in the receipts. That is the right way
 * round: a missing number is a question somebody asks, a repeated one is two
 * documents that cannot be told apart afterwards.
 */
const SERIES = {
  JMC: 'appointment_token_seq',
  OTC: 'otc_receipt_seq',
  PO: 'purchase_order_seq',
  RET: 'supplier_return_seq',
  ST: 'stock_take_seq',
  RX: 'prescription_number_seq',
  // Slice 3.
  GRN: 'goods_receipt_seq',
  OC: 'opening_count_seq',
  // Slice 4.
  DSP: 'dispense_seq',
  INV: 'invoice_seq',
  RCP: 'receipt_seq',
} as const

/**
 * How wide each series is printed.
 *
 * A floor rather than a cap: the series is allowed to outgrow it, and
 * INV-1000000 is still readable where a wrapped number would not be. Six for
 * anything a patient keeps — a prescription, a bill, a receipt — because those
 * are the ones somebody reads back over a telephone.
 */
const WIDTH: Partial<Record<keyof typeof SERIES, number>> = {
  RX: 6, INV: 6, RCP: 6, DSP: 6,
}

export async function sequence(prefix: keyof typeof SERIES) {
  // A bigint arrives as a string, and padStart wants one anyway. Four digits is
  // the floor rather than the width: the series is allowed to outgrow it, and
  // OTC-10000 is still readable where a wrapped number would not be.
  const row = (await db
    .prepare(`select nextval('jmc.${SERIES[prefix]}') as value`)
    .get()) as { value: string | number }
  return `${prefix}-${String(row.value).padStart(WIDTH[prefix] ?? 4, '0')}`
}
