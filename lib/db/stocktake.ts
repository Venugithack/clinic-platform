/**
 * Stock-take reads. INVENTORY.md §5.
 *
 * Note what is absent: there is no function here that returns the expected
 * quantity during counting. Not because this module chooses not to — the
 * counting role has no privilege on that column, so asking would raise. The
 * variance view returns nothing at all until counting is closed.
 */
import { db } from './index';

export interface OpenStockTake {
  id: string;
  status: 'counting' | 'review' | 'approved' | 'cancelled';
  scope_note: string | null;
  started_at: string;
  recount_threshold_value: number;
}

export async function currentStockTake(): Promise<OpenStockTake | null> {
  const { data, error } = await db()
    .from('stock_takes')
    .select('id, status, scope_note, started_at, recount_threshold_value')
    .in('status', ['counting', 'review'])
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as OpenStockTake) ?? null;
}

export interface CountedLine {
  batch_id: string;
  drug_id: string;
  counted_qty_base: number;
  counted_at: string;
  recount_qty_base: number | null;
}

/** What has been counted so far — the counts, and nothing about the answers. */
export async function countedLines(takeId: string): Promise<CountedLine[]> {
  const { data, error } = await db()
    .from('stock_take_lines')
    .select('batch_id, drug_id, counted_qty_base, counted_at, recount_qty_base')
    .eq('take_id', takeId)
    .order('counted_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as CountedLine[];
}

export interface VarianceLine {
  batch_id: string;
  drug_id: string;
  drug_name: string;
  batch_no: string;
  system_qty_base: number;
  counted_qty_base: number;
  variance_base: number;
  variance_value: number;
  needs_recount: boolean;
}

/**
 * The variance report, sorted by the VALUE of the discrepancy.
 *
 * Not by its size: three missing thyroid tablets matter more than three hundred
 * missing paracetamol, and sorting by count buries the one that matters. This
 * ordering is what makes the report a theft-and-drift detector.
 */
export async function variance(takeId: string): Promise<VarianceLine[]> {
  const { data, error } = await db()
    .from('stock_take_variance')
    .select('*')
    .eq('take_id', takeId);

  if (error) throw new Error(error.message);

  return ((data ?? []) as VarianceLine[]).sort(
    (a, b) => Math.abs(b.variance_value) - Math.abs(a.variance_value),
  );
}

export interface CountableBatch {
  batch_id: string;
  drug_id: string;
  drug_name: string;
  batch_no: string;
  expiry: string;
}

/** The shelf, as a list to walk. Quantities are deliberately not included. */
export async function countableBatches(): Promise<CountableBatch[]> {
  const { data, error } = await db()
    .from('available_stock')
    .select('batch_id, drug_id, batch_no, expiry, drugs(name)')
    .order('batch_no');

  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    batch_id: row.batch_id as string,
    drug_id: row.drug_id as string,
    batch_no: row.batch_no as string,
    expiry: row.expiry as string,
    drug_name: (row.drugs as { name?: string } | null)?.name ?? '',
  }));
}
