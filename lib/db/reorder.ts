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
