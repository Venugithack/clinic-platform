/**
 * What is on the shelf, and what it is worth. INVENTORY.md §4.
 *
 * Every other stock screen in this build is a screen for DOING something —
 * receiving books stock in, stock-take counts it, expiry writes it off, reorder
 * buys more. Stock is visible on them only as a side effect of the job in hand.
 * This module is the other half: looking something up, with no job attached and
 * nothing to commit.
 *
 * `stock_valuation` has existed, commented and granted, since M8 and was read
 * by nothing. It is the right source and not a new query, because it is the one
 * the ledger reconciles against: on-hand at weighted average cost, expired
 * batches excluded the same way `available_stock` excludes them. A second
 * hand-rolled sum here would be a second answer to the same question, and the
 * two would disagree the first week somebody wrote off a batch.
 *
 * Nothing in this file writes. Rule 2 — one writer — and the writer for stock
 * is the ledger, through the transitions.
 */
import { db } from './index';
import { drugsByIds, type DrugRow } from './drugs';

/** A row of `stock_valuation`, exactly as the view defines it. */
export interface Valuation {
  drug_id: string;
  drug_name: string;
  schedule: 'OTC' | 'H' | 'H1' | 'X';
  batches: number;
  qty_base_on_hand: number;
  value_at_cost: number;
  earliest_expiry: string;
}

/**
 * A valuation row with the catalogue detail the shelf list needs.
 *
 * `stock_valuation` is keyed by drug and carries the name, but not the pack
 * configuration — so a bare row can say "180" and not "18 strips", and 180 is
 * the wrong unit to read out at a shelf. It also has no salt, and salt is how a
 * drug is actually looked for: the doctor thinks "amoxicillin" and the box says
 * Augmentin (lib/db/drugs.ts says the same thing about search).
 */
export interface ShelfRow extends Valuation {
  generic: string | null;
  salt_composition: string;
  strength: string;
  form: string;
  base_unit: 'tablet' | 'ml' | 'piece';
  units_per_strip: number;
  strips_per_box: number;
}

/**
 * The whole shelf, in one read, sorted by name.
 *
 * Sorted alphabetically and not by value: this is a place to find a drug, and a
 * list that reorders itself as stock moves is one you cannot learn. The money
 * question — what is all this worth — is a total, and a total does not need the
 * list sorted to answer it.
 *
 * Unpaginated on purpose. A general practice dispensary carries a few hundred
 * lines, the view is already aggregated to one row per drug, and holding the
 * whole thing lets the search filter locally — which is what makes typing feel
 * instant on a tablet over clinic wifi. If a shelf ever outgrows that, the fix
 * is a server-side search, not a page-at-a-time browse nobody can scan.
 */
export async function shelf(): Promise<ShelfRow[]> {
  const { data, error } = await db().from('stock_valuation').select('*');

  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as Valuation[]).map((row) => ({
    ...row,
    // PostgREST hands numerics back as JSON numbers, but the sums here are the
    // ones a doctor reconciles against a ledger — parse rather than assume.
    qty_base_on_hand: Number(row.qty_base_on_hand),
    value_at_cost: Number(row.value_at_cost),
    batches: Number(row.batches),
  }));

  const catalogue = await drugsByIds(rows.map((row) => row.drug_id));

  return rows
    .map((row) => withCatalogue(row, catalogue.get(row.drug_id)))
    .sort((a, b) => a.drug_name.localeCompare(b.drug_name));
}

/**
 * Pack configuration defaults to 1×1 when the catalogue has none.
 *
 * That is not a guess dressed as data: at 1 unit to a strip `formatQty` prints
 * base units and says nothing about strips, which is the honest rendering of
 * "we do not know how this one is packed". Inventing 10 would print a strip
 * count that is wrong at the shelf.
 */
function withCatalogue(row: Valuation, drug: DrugRow | undefined): ShelfRow {
  return {
    ...row,
    generic: drug?.generic ?? null,
    salt_composition: drug?.salt_composition ?? '',
    strength: drug?.strength ?? '',
    form: drug?.form ?? '',
    base_unit: drug?.base_unit ?? 'piece',
    units_per_strip: drug?.default_units_per_strip ?? 1,
    strips_per_box: drug?.default_strips_per_box ?? 1,
  };
}

/**
 * Brand, generic and salt — the three things somebody might type, matching what
 * the prescribing search already matches on so the two surfaces do not disagree
 * about what "Augmentin" finds.
 *
 * No minimum length here, unlike `searchDrugs`. That one costs a round trip per
 * keystroke; this filters a list already in hand, so a single character can
 * narrow the shelf and there is no reason to make somebody type three.
 */
export function matches(row: ShelfRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;

  return [row.drug_name, row.generic, row.salt_composition, row.strength]
    .some((field) => (field ?? '').toLowerCase().includes(needle));
}

export interface ShelfBatch {
  batch_id: string;
  drug_id: string;
  batch_no: string;
  expiry: string;
  qty_base_on_hand: number;
  cost_per_base_unit: number;
  mrp: number;
  units_per_strip: number;
  strips_per_box: number;
  units_in_pack: number;
}

/**
 * The batches behind one drug's number, earliest expiry first.
 *
 * FEFO order — the same order `app.dispense` allocates in — so the top of this
 * list is the batch the next sale will actually come out of. Sorting by receipt
 * date or batch number would put a different batch at the top from the one the
 * pharmacist is about to hand over.
 */
export async function batchesForDrug(drugId: string): Promise<ShelfBatch[]> {
  const { data, error } = await db()
    .from('available_stock')
    .select('*')
    .eq('drug_id', drugId)
    .order('expiry', { ascending: true });

  if (error) throw new Error(error.message);

  return ((data ?? []) as ShelfBatch[]).map((batch) => ({
    ...batch,
    qty_base_on_hand: Number(batch.qty_base_on_hand),
    cost_per_base_unit: Number(batch.cost_per_base_unit),
    mrp: Number(batch.mrp),
  }));
}

/** What the shelf is worth in total, and over how many lines. */
export function shelfTotals(rows: ShelfRow[]): {
  drugs: number;
  batches: number;
  value: number;
} {
  return {
    drugs: rows.length,
    batches: rows.reduce((sum, row) => sum + row.batches, 0),
    value: rows.reduce((sum, row) => sum + row.value_at_cost, 0),
  };
}
