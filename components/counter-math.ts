import type {
  ClinicSnapshot,
  InvoiceLineView,
  InvoiceView,
  MedicineView,
  PackageLevelView,
  PackageVersionView,
  PrescriptionItemView,
  PrescriptionView,
} from '@/lib/types'
import type { Tone } from '@/components/ui'
import { plural } from './formulary-workspace'

/**
 * The counter's arithmetic, with no screen attached to it.
 *
 * Everything here used to live inside the 1800-line component that draws the
 * pharmacy counter, where each function was a closure over one station's state
 * and none of it could be read, reasoned about or reused without the JSX around
 * it. That is a bad place for the only code that decides how many tablets leave
 * the shelf and what they are worth — a restructure of the screen should never
 * be an invitation to reimplement `remainingOf`.
 *
 * So: pure functions over the snapshot. No React, no state, no side effects.
 * The screen decides what to show; these decide what is true.
 */

/* ============================================================ prescriptions */

export const SUPPLY_STATE: Record<
  NonNullable<PrescriptionItemView['supplyState']>,
  { word: string; tone: Tone }
> = {
  waiting: { word: 'Waiting', tone: 'attn' },
  part_supplied: { word: 'Part supplied', tone: 'attn' },
  supplied: { word: 'Supplied', tone: 'free' },
  patient_declined: { word: 'Patient declined', tone: 'plain' },
  doctor_cancelled: { word: 'Doctor cancelled', tone: 'plain' },
  needs_review: { word: 'Needs review', tone: 'stop' },
}

/** A line with something still to be done about it, one way or the other. */
export function isPending(item: PrescriptionItemView): boolean {
  if (item.supplyState) {
    return (
      item.supplyState === 'waiting' ||
      item.supplyState === 'part_supplied' ||
      item.supplyState === 'needs_review'
    )
  }
  return !item.cancelled
}

/** A line the counter may actually put on the scale right now. */
export function isSupplyable(item: PrescriptionItemView): boolean {
  if (item.supplyState) return item.supplyState === 'waiting' || item.supplyState === 'part_supplied'
  return !item.cancelled && !item.needsReview
}

export function remainingOf(item: PrescriptionItemView): number {
  if (item.remaining !== undefined) return item.remaining
  return Math.max((item.quantity ?? 0) - (item.supplied ?? 0), 0)
}

/**
 * What `Supply now` holds for this line.
 *
 * Untouched means the whole remainder, because that is what a pharmacist
 * reaching for a prescription is nearly always about to do. Emptied means zero
 * rather than the remainder: clearing the box is a deliberate "not this line",
 * and reading it as "all of it" would hand over medicine nobody asked for.
 */
export function typedFor(item: PrescriptionItemView, give: Record<string, string>): number {
  const remaining = remainingOf(item)
  const raw = item.prescriptionLineId ? give[item.prescriptionLineId] : undefined
  if (raw === undefined) return remaining
  if (raw.trim() === '') return 0
  return Math.min(Math.max(Math.floor(Number(raw)) || 0, 0), remaining)
}

/** Digits only, and never above what is left to supply. */
export function capQuantity(raw: string, remaining: number): string {
  const digits = raw.replace(/[^0-9]/g, '')
  if (digits === '') return ''
  return String(Math.min(Math.max(Number(digits), 0), Math.max(remaining, 0)))
}

/**
 * The narrow door policy register 21 leaves open, asked of the formulary.
 *
 * The backend enforces all of this in `dispense_rx` and is the authority; this
 * is the screen's copy of the same question, so that a pharmacist is never
 * offered a product the clinic will refuse and never has to guess why a
 * substitution is impossible. Four conditions, all of them:
 *
 *   - the prescribed product is in the active formulary at all;
 *   - it was prescribed GENERICALLY, meaning it carries no brand name;
 *   - it is linked to a clinical drug, so "the same medicine" has an answer
 *     rather than an opinion;
 *   - some other active product points at that same clinical drug and has
 *     stock on the shelf.
 *
 * Anything else is `blocked`, and the screen's word for blocked is
 * "Doctor amendment required". The pharmacist may not decide it; the doctor may.
 */
export type Substitution =
  | { kind: 'open'; prescribed: MedicineView; candidates: MedicineView[] }
  | { kind: 'blocked'; reason: string }

export function substituteOptions(
  data: ClinicSnapshot,
  item: PrescriptionItemView,
): Substitution {
  const prescribed = data.medicines.find((medicine) => medicine.id === item.medicineId)
  if (!prescribed) {
    return {
      kind: 'blocked',
      reason: `${item.medicineName} is not in the clinic formulary, so nothing can be proved to be the same medicine as it.`,
    }
  }
  if (prescribed.brandName) {
    return {
      kind: 'blocked',
      reason: `${prescribed.name} was prescribed by brand (${prescribed.brandName}). A brand-specific order is supplied exactly as written.`,
    }
  }
  if (!prescribed.clinicalDrugId) {
    return {
      kind: 'blocked',
      reason: `${prescribed.name} is not linked to a clinical drug, so no equivalent can be checked against it.`,
    }
  }
  const candidates = data.medicines
    .filter(
      (medicine) =>
        medicine.active &&
        medicine.id !== prescribed.id &&
        Boolean(medicine.clinicalDrugId) &&
        medicine.clinicalDrugId === prescribed.clinicalDrugId &&
        medicine.totalAvailable > 0,
    )
    .sort((a, b) => b.totalAvailable - a.totalAvailable || a.name.localeCompare(b.name))

  if (candidates.length === 0) {
    return {
      kind: 'blocked',
      reason: `Nothing else on the shelf is ${prescribed.clinicalDrugName || 'the same clinical drug'} as ${prescribed.name}.`,
    }
  }
  return { kind: 'open', prescribed, candidates }
}

/** Ingredient, strength, form and route, never collapsed into a brand. */
export function medicineIdentity(medicine: MedicineView): string {
  return [
    medicine.genericName || medicine.name,
    medicine.strength,
    medicine.dosageForm,
    medicine.route,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** How much of a patient's prescribed medicine is still uncollected. */
export function stillToCollect(
  prescriptions: PrescriptionView[],
  patientId: string,
): { lines: number; units: number } {
  let lines = 0
  let units = 0
  for (const rx of prescriptions) {
    if (rx.patientId !== patientId) continue
    for (const item of rx.items) {
      if (!isSupplyable(item)) continue
      const remaining = remainingOf(item)
      if (remaining <= 0) continue
      lines += 1
      units += remaining
    }
  }
  return { lines, units }
}

/* ================================================================= packages */

/** The key a medicine with no verified package counts its loose units under. */
export const LOOSE = '__loose'

/** Biggest package first — a box reads before a strip before a tablet. */
export function topDown(levels: PackageLevelView[]): PackageLevelView[] {
  return [...levels].sort((a, b) => b.depth - a.depth)
}

export function packageOf(
  data: ClinicSnapshot,
  medicine: MedicineView | undefined,
): PackageVersionView | undefined {
  if (!medicine?.activePackageVersionId) return undefined
  return data.packages.find((version) => version.id === medicine.activePackageVersionId)
}

/** What the typed counts come to in base units, and how to say it out loud. */
export function countsToBase(levels: PackageLevelView[], counts: Record<string, string>) {
  let total = 0
  const said: string[] = []
  const problems: string[] = []
  for (const level of topDown(levels)) {
    const raw = (counts[level.levelName] ?? '').trim()
    if (raw === '') continue
    const count = Number(raw)
    if (!Number.isInteger(count) || count < 0) {
      problems.push(`The number of ${plural(level.levelName, 2)} must be a whole number.`)
      continue
    }
    if (count === 0) continue
    if (count % level.minimumSaleMultiple !== 0) {
      problems.push(`${level.levelName} is sold in multiples of ${level.minimumSaleMultiple}.`)
      continue
    }
    total += level.baseFactor * count
    said.push(`${count} ${plural(level.levelName, count)}`)
  }
  return { total, said: said.join(' + '), problems }
}

/** The `entry` a counter-sale line carries. Zero counts are left out. */
export function countsToEntry(levels: PackageLevelView[], counts: Record<string, string>) {
  return topDown(levels)
    .map((level) => ({
      levelName: level.levelName,
      count: Number((counts[level.levelName] ?? '').trim()),
    }))
    .filter((row) => Number.isInteger(row.count) && row.count > 0)
}

/** Base units counted on a line, whether by package level or loose. */
export function countedQuantity(
  version: PackageVersionView | undefined,
  levels: PackageLevelView[],
  counts: Record<string, string>,
): number {
  if (version) return countsToBase(levels, counts).total
  return Math.floor(Number((counts[LOOSE] ?? '').trim() || 0)) || 0
}

/* =================================================================== prices */

/**
 * What this quantity would come to at today's shelf prices.
 *
 * The same first-expiry-first walk the server does, so the figure on the screen
 * is the figure on the bill in the ordinary case — but it is read off a
 * snapshot that may be fifteen seconds old, and it is labelled an estimate for
 * exactly that reason. The bill is whatever the server computes when it
 * allocates the batches. Undefined means the shelf cannot cover it.
 */
export function estimatePaise(
  data: ClinicSnapshot,
  medicineId: string,
  quantity: number,
): number | undefined {
  if (quantity <= 0) return 0
  const candidates = data.batches
    .filter(
      (batch) => batch.medicineId === medicineId && batch.pickable && batch.availableQuantity > 0,
    )
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.id.localeCompare(b.id))

  let left = quantity
  let paise = 0
  for (const batch of candidates) {
    if (left === 0) break
    const take = Math.min(batch.availableQuantity, left)
    paise += Math.round(batch.sellingPrice * 100) * take
    left -= take
  }
  return left > 0 ? undefined : paise
}

/* ===================================================================== bill */

/**
 * What one kind of charge comes to on a bill.
 *
 * Summed in paise rather than in rupees, because the counter prints this beside
 * the figure the server computed and two floating-point additions of ₹12.35 do
 * not reliably agree with one.
 */
export function sourcePaise(
  invoice: InvoiceView | undefined,
  source: InvoiceLineView['source'],
): number {
  if (!invoice) return 0
  return invoice.lines
    .filter((line) => line.source === source)
    .reduce((total, line) => total + Math.round(line.amount * 100), 0)
}
