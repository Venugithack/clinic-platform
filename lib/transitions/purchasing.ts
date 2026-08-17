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

/**
 * Replace a draft's lines with what a person actually decided to order.
 *
 * Only a draft. A sent order is a thing a supplier is holding, and editing it
 * silently is how two people end up with different orders.
 */
export async function setPoLines(
  poId: string,
  lines: Array<{
    drugId: string;
    qtyBase: number;
    suggestedQtyBase?: number;
    expectedCostPerBaseUnit?: number;
  }>,
): Promise<number> {
  const { data, error } = await appSchema().rpc('set_po_lines', {
    p_po_id: poId,
    p_lines: lines.map((line) => ({
      drug_id: line.drugId,
      qty_base: line.qtyBase,
      suggested_qty_base: line.suggestedQtyBase ?? null,
      expected_cost_per_base_unit: line.expectedCostPerBaseUnit ?? null,
    })),
  });

  if (error) throw toTransitionError(error);
  return Number(data);
}

export interface SentOrder {
  order_id: string;
  order_no: string;
  send_to_number: string;
  message_body: string;
  message_id: string;
  send_count: number;
}

/**
 * The one tap (PLAN.md §10.4).
 *
 * Records the message and hands back the text. It deliberately does NOT return
 * a URL: percent-encoding is a transport detail that belongs at the edge
 * (lib/whatsapp), while the text recorded here is the record of what was
 * ordered. The doctor sends it; this app never learns whether he did.
 */
export async function sendPurchaseOrder(poId: string): Promise<SentOrder> {
  const { data, error } = await appSchema().rpc('send_purchase_order', {
    p_po_id: poId,
  });

  if (error) throw toTransitionError(error);

  // A `returns table` function comes back as an array of one row.
  const rows = data as SentOrder[] | SentOrder;
  return Array.isArray(rows) ? (rows[0] as SentOrder) : rows;
}

/** The acknowledgement, typed in by whoever read the reply. */
export async function recordSupplierReply(
  poId: string,
  reply: string,
  expectedOn?: string,
): Promise<void> {
  const { error } = await appSchema().rpc('record_supplier_reply', {
    p_po_id: poId,
    p_reply: reply,
    p_expected_on: expectedOn ?? null,
  });

  if (error) throw toTransitionError(error);
}

export async function cancelPurchaseOrder(poId: string, reason: string): Promise<void> {
  const { error } = await appSchema().rpc('cancel_purchase_order', {
    p_po_id: poId,
    p_reason: reason,
  });

  if (error) throw toTransitionError(error);
}
