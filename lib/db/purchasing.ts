/**
 * Purchase orders, read side. PLAN.md §12.5.
 */
import { db } from './index';

export type PurchaseOrderStatus =
  | 'draft'
  | 'sent'
  | 'acknowledged'
  | 'partial'
  | 'received'
  | 'cancelled';

export interface OpenOrder {
  po_id: string;
  po_no: string | null;
  status: PurchaseOrderStatus;
  supplier_id: string;
  supplier_name: string;
  whatsapp_number: string | null;
  estimated_total: number;
  created_at: string;
  sent_at: string | null;
  acknowledged_at: string | null;
  expected_on: string | null;
  supplier_reply: string | null;
  sends: number;
  lines: number;
  outstanding_qty_base: number;
}

/** Drafts first — they are the ones waiting on a person. */
export async function openOrders(): Promise<OpenOrder[]> {
  const { data, error } = await db()
    .from('purchase_orders_open')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  const rank: Record<string, number> = {
    draft: 0,
    partial: 1,
    acknowledged: 2,
    sent: 3,
  };
  return ((data ?? []) as OpenOrder[]).sort(
    (a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9),
  );
}

export interface OrderLine {
  po_line_id: string;
  po_id: string;
  drug_id: string;
  drug_name: string;
  strength: string;
  base_unit: 'tablet' | 'ml' | 'piece';
  default_units_per_strip: number | null;
  default_strips_per_box: number | null;
  ordered_qty_base: number;
  suggested_qty_base: number | null;
  expected_cost_per_base_unit: number | null;
  received_qty_base: number;
  outstanding_qty_base: number;
}

export async function orderLines(poId: string): Promise<OrderLine[]> {
  const { data, error } = await db()
    .from('purchase_order_lines')
    .select('*')
    .eq('po_id', poId)
    .order('drug_name');

  if (error) throw new Error(error.message);
  return (data ?? []) as OrderLine[];
}

export interface SentMessage {
  id: string;
  to_number: string;
  body: string;
  status: string;
  at: string;
}

/**
 * What was actually sent, and when.
 *
 * Worth showing on the screen rather than keeping in the audit log: the whole
 * point of a deep link is that the doctor sends it from his own phone, so the
 * only place the clinic can check what went out is this record.
 */
export async function messagesFor(poId: string): Promise<SentMessage[]> {
  const { data, error } = await db()
    .from('wa_messages')
    .select('id, to_number, body, status, at')
    .eq('ref_type', 'purchase_order')
    .eq('ref_id', poId)
    .order('at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as SentMessage[];
}
