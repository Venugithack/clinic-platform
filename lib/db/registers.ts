/**
 * The registers. PLAN.md §15.2.
 *
 * Reads only — there is nothing to write. A register is an arrangement of what
 * already happened, and if one needed a write to be correct then the thing it
 * reports on was recorded wrong.
 *
 * Every date filter here is on a CLINIC day, computed in the clinic's own
 * timezone by the views. Filtering on a UTC timestamp would split every
 * evening's dispensing across two dates, which an inspector would notice.
 */
import { db } from './index';

export interface H1Row extends Record<string, unknown> {
  dispense_line_id: string;
  dispensed_at: string;
  dispensed_on: string;
  patient_name: string | null;
  patient_address: string | null;
  patient_phone: string | null;
  drug_name: string;
  strength: string;
  qty_base: number;
  batch_no: string;
  expiry: string;
  prescriber_name: string | null;
  prescriber_reg_no: string | null;
  dispensed_by: string | null;
  address_missing: boolean;
}

export async function h1Register(from: string, to: string): Promise<H1Row[]> {
  const { data, error } = await db()
    .from('h1_register')
    .select('*')
    .gte('dispensed_on', from)
    .lte('dispensed_on', to)
    .order('dispensed_at');

  if (error) throw new Error(error.message);
  return (data ?? []) as H1Row[];
}

export interface SalesRow extends Record<string, unknown> {
  bill_id: string;
  bill_no: string;
  billed_on: string;
  patient_name: string | null;
  consult_fee: number;
  medicines_total: number;
  discount: number;
  round_off: number;
  total: number;
  status: string;
  method: string | null;
  raised_by: string | null;
}

export async function salesRegister(from: string, to: string): Promise<SalesRow[]> {
  const { data, error } = await db()
    .from('sales_register')
    .select('*')
    .gte('billed_on', from)
    .lte('billed_on', to)
    .order('created_at');

  if (error) throw new Error(error.message);
  return (data ?? []) as SalesRow[];
}

export interface PurchaseRow extends Record<string, unknown> {
  grn_id: string;
  received_on: string;
  invoice_no: string | null;
  invoice_date: string | null;
  awaiting_invoice: boolean;
  supplier_name: string | null;
  supplier_gstin: string | null;
  po_no: string | null;
  total: number;
  received_by: string | null;
  lines: number;
  qty_base: number;
}

export async function purchaseRegister(from: string, to: string): Promise<PurchaseRow[]> {
  const { data, error } = await db()
    .from('purchase_register')
    .select('*')
    .gte('received_on', from)
    .lte('received_on', to)
    .order('received_at');

  if (error) throw new Error(error.message);
  return (data ?? []) as PurchaseRow[];
}

export interface WriteoffRow extends Record<string, unknown> {
  movement_id: string;
  written_off_on: string;
  drug_name: string;
  strength: string;
  batch_no: string;
  expiry: string;
  qty_base_written_off: number;
  value_at_cost: number;
  reason: string | null;
  written_off_by: string | null;
}

export async function expiryWriteoffs(from: string, to: string): Promise<WriteoffRow[]> {
  const { data, error } = await db()
    .from('expiry_writeoff_register')
    .select('*')
    .gte('written_off_on', from)
    .lte('written_off_on', to)
    .order('at');

  if (error) throw new Error(error.message);
  return (data ?? []) as WriteoffRow[];
}

export interface TraceRow extends Record<string, unknown> {
  batch_id: string;
  batch_no: string;
  drug_name: string;
  strength: string;
  expiry: string;
  dispensed_at: string;
  qty_base: number;
  patient_name: string | null;
  patient_phone: string | null;
  is_counter_sale: boolean;
  dispensed_by: string | null;
}

/**
 * The recall query. Not date-bounded on purpose: a recall covers a batch for as
 * long as that batch has been leaving the shelf, and a date range is exactly
 * how somebody misses the first three people who got it.
 */
export async function batchTrace(batchNo: string): Promise<TraceRow[]> {
  const trimmed = batchNo.trim();
  if (trimmed.length < 2) return [];

  const { data, error } = await db()
    .from('batch_trace')
    .select('*')
    .ilike('batch_no', `%${trimmed}%`)
    .order('dispensed_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as TraceRow[];
}
