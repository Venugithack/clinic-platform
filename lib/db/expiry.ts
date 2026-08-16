/**
 * The expiry desk. INVENTORY.md §6.
 *
 * The ordering in this module is the design. A list of batches sorted by expiry
 * date is what every cheap pharmacy package ships and it is the wrong list: by
 * the time a batch is ninety days from expiring, a supplier who wants their
 * stock back six months early has been unreachable for three. So the list is
 * driven by `return_by` — the date the door shuts — and the batches that can
 * still go back come first, in the order their doors close.
 */
import { db } from './index';

export interface ExpiringBatch {
  batch_id: string;
  drug_id: string;
  drug_name: string;
  batch_no: string;
  expiry: string;
  days_to_expiry: number;
  qty_base_on_hand: number;
  units_per_strip: number;
  strips_per_box: number;
  value_at_cost: number;
  supplier_id: string | null;
  supplier_name: string | null;
  return_window_days: number | null;
  return_by: string | null;
  days_to_return_by: number | null;
  returnable: boolean;
}

/**
 * Returnable first, by whose window closes soonest; then everything else by how
 * close it is to expiring. The second group is not a failure — FEFO is already
 * pushing it out of the door — but it has no deadline anybody can miss, so it
 * sits below the group that does.
 */
export async function expiringSoon(): Promise<ExpiringBatch[]> {
  const { data, error } = await db().from('expiring_soon').select('*');

  if (error) throw new Error(error.message);

  return ((data ?? []) as ExpiringBatch[]).sort((a, b) => {
    if (a.returnable !== b.returnable) return a.returnable ? -1 : 1;
    if (a.returnable && b.returnable) {
      return (a.days_to_return_by ?? 0) - (b.days_to_return_by ?? 0);
    }
    return a.days_to_expiry - b.days_to_expiry;
  });
}

export interface ExpiredBatch {
  batch_id: string;
  drug_id: string;
  drug_name: string;
  batch_no: string;
  expiry: string;
  days_expired: number;
  qty_base_on_hand: number;
  value_at_cost: number;
  supplier_id: string | null;
  supplier_name: string | null;
}

/**
 * The write-off queue.
 *
 * available_stock hides expired batches on purpose, which means that without
 * this list they are on the shelf, on the books, and on no screen at all.
 */
export async function expiredStock(): Promise<ExpiredBatch[]> {
  const { data, error } = await db()
    .from('expired_stock')
    .select('*')
    .order('days_expired', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as ExpiredBatch[];
}

export interface OpenCredit {
  credit_id: string;
  supplier_id: string;
  supplier_name: string;
  return_id: string | null;
  amount_expected: number;
  amount_settled: number;
  outstanding: number;
  opened_at: string;
  days_open: number;
}

/** Oldest first: a credit nobody chases is a discount to the supplier. */
export async function openCredits(): Promise<OpenCredit[]> {
  const { data, error } = await db()
    .from('open_supplier_credits')
    .select('*')
    .order('opened_at', { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as OpenCredit[];
}

export interface SupplierInvoice {
  id: string;
  invoice_no: string | null;
  invoice_date: string | null;
  received_at: string;
  total: number;
}

/** The invoices a credit can be netted off — this supplier's, newest first. */
export async function invoicesForSupplier(supplierId: string): Promise<SupplierInvoice[]> {
  const { data, error } = await db()
    .from('goods_receipts')
    .select('id, invoice_no, invoice_date, received_at, total')
    .eq('supplier_id', supplierId)
    .order('received_at', { ascending: false })
    .limit(10);

  if (error) throw new Error(error.message);
  return (data ?? []) as SupplierInvoice[];
}
