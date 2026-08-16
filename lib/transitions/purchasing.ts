/**
 * Purchasing transitions. INVENTORY.md §8, PLAN.md §5.3 rule 4.
 *
 * There is one function here and it creates drafts. Not because sending is hard
 * — it is one more RPC — but because the moment a suggested quantity can reach
 * a supplier without a person looking at it, one bad reorder level costs the
 * clinic real money and nobody finds out until the boxes arrive. Sending is M5,
 * and it starts with a human's tap (WHATSAPP.md §9).
 */
import { appSchema } from '@/lib/db';
import { toTransitionError } from './errors';

export interface DraftOrderLine {
  drugId: string;
  supplierId: string;
  /** What is actually being ordered — the doctor's number, not the view's. */
  qtyBase: number;
  /** What the system proposed, kept beside it so it can be judged later. */
  suggestedQtyBase?: number;
  expectedCostPerBaseUnit?: number;
}

/** Returns how many draft orders were created — one per supplier. */
export async function draftPurchaseOrders(lines: DraftOrderLine[]): Promise<number> {
  const { data, error } = await appSchema().rpc('draft_purchase_orders', {
    p_lines: lines.map((line) => ({
      drug_id: line.drugId,
      supplier_id: line.supplierId,
      qty_base: line.qtyBase,
      suggested_qty_base: line.suggestedQtyBase ?? null,
      expected_cost_per_base_unit: line.expectedCostPerBaseUnit ?? null,
    })),
  });

  if (error) throw toTransitionError(error);
  return Number(data);
}
