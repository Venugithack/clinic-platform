/**
 * Base-unit conversion. INVENTORY.md §1.
 *
 * A pharmacy buys in boxes and sells in tablets. The doctor writes "6 tablets";
 * the supplier invoices "1 box = 10 strips x 15 tablets". Software that stores
 * "quantity: 4" without knowing what a 4 is will be wrong within a week and
 * unfixable within a month.
 *
 * So: every stock number in the database is in base units, always. Boxes and
 * strips exist only at the edges — the receiving screen and the label — and
 * this module is that edge. Nothing below it knows what a strip is.
 *
 * Pack configuration comes from the BATCH, never the drug: manufacturers change
 * strip sizes between production runs, and if the conversion factor lived on the
 * drug record, one supplier switching 15s to 10s would silently corrupt every
 * historical quantity.
 */

export type PackBasis = 'unit' | 'strip' | 'box';

/** Pack configuration as recorded on a batch. */
export interface PackConfig {
  unitsPerStrip: number;
  stripsPerBox: number;
}

/** How many base units are in one pack of the given kind. */
export function unitsInPack(pack: PackConfig, basis: PackBasis): number {
  switch (basis) {
    case 'unit':
      return 1;
    case 'strip':
      return pack.unitsPerStrip;
    case 'box':
      return pack.unitsPerStrip * pack.stripsPerBox;
  }
}

/**
 * Convert a quantity the counter typed into base units for the ledger.
 * This is the only direction that writes; everything stored is already base.
 */
export function toBaseUnits(qty: number, basis: PackBasis, pack: PackConfig): number {
  if (!Number.isInteger(qty) || qty < 0) {
    throw new RangeError(`quantity must be a non-negative integer, got ${qty}`);
  }
  return qty * unitsInPack(pack, basis);
}

export interface Decomposed {
  boxes: number;
  strips: number;
  loose: number;
}

/**
 * Present a base-unit quantity the way a pharmacist counts it.
 *
 * Loose-strip tracking falls out of this for free and never drifts, because it
 * is computed on the way out rather than stored: 47 on hand at 15 to a strip is
 * 3 strips and 2 loose, always, without a second column to disagree with.
 */
export function decompose(
  qtyBase: number,
  pack: PackConfig,
  options: { boxes?: boolean } = {},
): Decomposed {
  const perStrip = pack.unitsPerStrip;
  const perBox = perStrip * pack.stripsPerBox;

  let remaining = qtyBase;
  let boxes = 0;

  if (options.boxes) {
    boxes = Math.floor(remaining / perBox);
    remaining -= boxes * perBox;
  }

  const strips = Math.floor(remaining / perStrip);
  const loose = remaining - strips * perStrip;

  return { boxes, strips, loose };
}

/** "3 strips + 2 loose", "19 strips", "9 tablets". */
export function formatQty(
  qtyBase: number,
  pack: PackConfig,
  baseUnitLabel = 'loose',
  options: { boxes?: boolean } = {},
): string {
  const { boxes, strips, loose } = decompose(qtyBase, pack, options);
  const parts: string[] = [];

  if (boxes > 0) parts.push(`${boxes} ${boxes === 1 ? 'box' : 'boxes'}`);
  if (strips > 0) parts.push(`${strips} ${strips === 1 ? 'strip' : 'strips'}`);
  if (loose > 0 || parts.length === 0) parts.push(`${loose} ${baseUnitLabel}`);

  return parts.join(' + ');
}

/**
 * Money is handled in integer paise throughout. Floating-point rupees drift,
 * and this is a number a customer reads off a printed bill.
 */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * What a line of loose units costs, in paise.
 *
 * The hard invariant: a line total can never exceed MRP x packs sold. Rounding
 * a loose-tablet price UP past the printed MRP is a legal problem, not a
 * rounding problem — so the paise-rounded figure is clamped to the exact
 * pro-rata ceiling.
 *
 * This mirrors app.dispense() in supabase/migrations. The database is
 * authoritative and computes the figure that is actually billed; this function
 * exists so the counter screen can show the same number before committing, and
 * the two must not disagree. Change one, change both.
 */
export function lineAmountPaise(
  qtyBase: number,
  mrpPaise: number,
  pack: PackConfig,
  basis: PackBasis,
): number {
  const perPack = unitsInPack(pack, basis);
  const exact = (mrpPaise * qtyBase) / perPack;
  const cap = Math.floor(exact);
  return Math.min(Math.round(exact), cap);
}

/**
 * What one base unit cost, from what the invoice actually says.
 *
 * A supplier invoice is priced per pack — "rate 28.50" against a strip — and
 * `stock_batches.cost_per_base_unit` is per tablet. This is that division, and
 * it lives here because this module is the edge where packs stop existing
 * (INVENTORY.md §1). Four decimal places, because that is the precision the
 * column keeps and valuation is a sum over thousands of units.
 */
export function packCostToBaseUnitCost(
  packCostPaise: number,
  pack: PackConfig,
  basis: PackBasis,
): number {
  const perPack = unitsInPack(pack, basis);
  return Math.round((packCostPaise / 100 / perPack) * 10_000) / 10_000;
}

/** Per-base-unit price, for display only. Never used to compute a line total. */
export function unitPricePaise(
  mrpPaise: number,
  pack: PackConfig,
  basis: PackBasis,
): number {
  return mrpPaise / unitsInPack(pack, basis);
}
