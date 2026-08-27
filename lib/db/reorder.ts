/**
 * Reorder intelligence, read side. INVENTORY.md §8.
 *
 * Everything here is a suggestion. The module deliberately exposes the inputs
 * alongside the output — velocity, lead time and where that lead time came
 * from, how long the shelf lasts — because a proposed quantity with no working
 * shown is one the doctor either rubber-stamps or ignores, and both are worse
 * than a number he can correct.
 */
import { db } from './index';

export interface ReorderSuggestion {
  drug_id: string;
  drug_name: string;
  schedule: 'OTC' | 'H' | 'H1' | 'X';
  base_unit: 'tablet' | 'ml' | 'piece';
  default_units_per_strip: number | null;
  default_strips_per_box: number | null;
  default_supplier_id: string | null;
  supplier_name: string | null;
  qty_base_available: number;
  reorder_level_base: number | null;
  reorder_qty_base: number | null;
  per_day: number;
  base_units_90: number;
  lead_days: number;
  buffer_days: number;
  lead_time_source: 'measured' | 'claimed' | 'assumed';
  times_at_zero: number;
  days_to_cover: number;
  days_of_cover_left: number | null;
  target_base: number;
  suggested_qty_base: number;
  basis: string;
}

/**
 * Emptiest shelf first.
 *
 * Sorting by suggested quantity would put the cheap high-volume drugs on top,
 * which is exactly backwards: the one that runs out on Thursday matters more
 * than the one that needs a big order in three weeks.
 */
export async function reorderSuggestions(): Promise<ReorderSuggestion[]> {
  const { data, error } = await db().from('reorder_suggestions').select('*');

  if (error) throw new Error(error.message);

  return ((data ?? []) as ReorderSuggestion[]).sort((a, b) => {
    const left = a.days_of_cover_left ?? -1;
    const right = b.days_of_cover_left ?? -1;
    if (left !== right) return left - right;
    return a.drug_name.localeCompare(b.drug_name);
  });
}

/**
 * What is already covered by an order that has not closed yet.
 *
 * Reorder intelligence is shelf-based, so a low shelf can correctly remain a
 * suggestion while 300 tablets are already on the way. This second read is the
 * operational guard: show that fact to the person and do not invite them to
 * draft the same medicine again. The transition enforces the same rule so two
 * tablets racing cannot create duplicate commitments.
 */
export async function openOrderQuantities(
  drugIds: string[],
): Promise<Map<string, number>> {
  if (drugIds.length === 0) return new Map();

  const { data, error } = await db()
    .from('purchase_order_lines')
    .select('drug_id, outstanding_qty_base, status')
    .in('drug_id', drugIds)
    .in('status', ['draft', 'sent', 'acknowledged', 'partial']);

  if (error) throw new Error(error.message);

  const byDrug = new Map<string, number>();
  for (const row of data ?? []) {
    const outstanding = Number(row.outstanding_qty_base ?? 0);
    if (outstanding <= 0) continue;
    const drugId = row.drug_id as string;
    byDrug.set(drugId, (byDrug.get(drugId) ?? 0) + outstanding);
  }
  return byDrug;
}

export interface PurchasePrice {
  drug_id: string;
  supplier_id: string | null;
  supplier_name: string | null;
  cost_per_base_unit: number;
  mrp: number;
  received_at: string;
  invoice_no: string | null;
  purchase_no: number;
}

/**
 * "₹42 last time from Kumar, ₹45 from Reddy" — on the line, at the moment he
 * can do something about it (INVENTORY.md §8).
 */
export async function priceHistory(
  drugIds: string[],
): Promise<Map<string, PurchasePrice[]>> {
  if (drugIds.length === 0) return new Map();

  const { data, error } = await db()
    .from('supplier_price_history')
    .select('*')
    .in('drug_id', drugIds)
    .order('received_at', { ascending: false });

  if (error) throw new Error(error.message);

  const byDrug = new Map<string, PurchasePrice[]>();
  for (const row of (data ?? []) as PurchasePrice[]) {
    const existing = byDrug.get(row.drug_id) ?? [];
    existing.push(row);
    byDrug.set(row.drug_id, existing);
  }
  return byDrug;
}

export interface DraftOrder {
  id: string;
  supplier_id: string;
  status: 'draft' | 'sent' | 'acknowledged' | 'partial' | 'received' | 'cancelled';
  estimated_total: number;
  created_at: string;
}

export async function draftOrders(): Promise<DraftOrder[]> {
  const { data, error } = await db()
    .from('purchase_orders')
    .select('id, supplier_id, status, estimated_total, created_at')
    .eq('status', 'draft')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as DraftOrder[];
}
