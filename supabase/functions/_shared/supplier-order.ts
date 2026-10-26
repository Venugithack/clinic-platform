import type { Ladder, Level } from './packages.ts'
import { decompose, describeEntry, plural } from './packages.ts'

/**
 * What a supplier order says, in the units a supplier sells in.
 *
 * The ledger counts tablets. A supplier sells strips and boxes. An order that
 * leaves the clinic saying "Paracetamol — 137" is read as 137 boxes by one
 * person and 137 tablets by another, so every quantity that goes into the
 * message carries its unit names, and the base-unit total beside them.
 *
 * Pure on purpose: `create_order` writes with it and `snapshot` reads with it,
 * so the message and the order card cannot describe one line two ways.
 */

/**
 * The pack an order is counted in: the smallest receivable pack above the base
 * unit — a strip, not a loose tablet. A product whose only receivable level is
 * the base (a bottle, a tube) is ordered in that.
 */
export function orderLevel(ladder: Ladder): Level {
  const packs = ladder.levels
    .filter((level) => level.receivable && level.depth > 0)
    .sort((a, b) => a.depth - b.depth)
  return packs[0] ?? ladder.levels[0]
}

/**
 * Whole packs that cover a shortfall, rounding up — nobody can order part of a
 * strip. The rounding is never more than one pack of the order level.
 */
export function packsToCover(
  ladder: Ladder,
  shortfall: number,
): { levelName: string; count: number; baseQuantity: number } {
  if (!Number.isInteger(shortfall) || shortfall <= 0) {
    throw new Error('A shortfall is a whole number of base units above zero.')
  }
  const level = orderLevel(ladder)
  const count = Math.ceil(shortfall / level.baseFactor)
  return { levelName: level.levelName, count, baseQuantity: count * level.baseFactor }
}

/**
 * How an exact base quantity is written into an order: in the order level when
 * it divides evenly, otherwise in the base unit, so a quantity somebody typed
 * by hand is recorded as typed and never silently rounded.
 */
export function orderLevelFor(
  ladder: Ladder,
  baseQuantity: number,
): { levelName: string; count: number } {
  const level = orderLevel(ladder)
  return baseQuantity % level.baseFactor === 0
    ? { levelName: level.levelName, count: baseQuantity / level.baseFactor }
    : { levelName: ladder.levels[0].levelName, count: baseQuantity }
}

/**
 * "1 box and 4 strips (140 tablets)", or "137 tablets" when there is no
 * verified package to count packs with.
 */
export function describeOrdered(ladder: Ladder | null, baseUnit: string, baseQuantity: number): string {
  const total = `${baseQuantity} ${plural(ladder?.baseUnit || baseUnit, baseQuantity)}`
  if (!ladder || ladder.levels.length < 2) return total
  const entries = decompose(ladder, baseQuantity).filter((entry) => entry.count > 0)
  const onlyBase = entries.every((entry) => entry.levelName === ladder.levels[0].levelName)
  return onlyBase ? total : `${describeEntry(entries)} (${total})`
}

/** The message a pharmacist sends from their own WhatsApp. Editable before it goes. */
export function supplierOrderMessage(
  supplierName: string,
  orderNumber: string,
  lines: Array<{ name: string; quantity: string }>,
): string {
  const items = lines.map((line, index) => `${index + 1}. ${line.name} — ${line.quantity}`).join('\n')
  return `Hello ${supplierName},\n\nPlease supply this order for Jayamurugan Clinic (${orderNumber}):\n${items}\n\nPlease confirm availability and expected delivery. Thank you.`
}
