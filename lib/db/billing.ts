/**
 * Billing reads. PLAN.md §8 M4.
 *
 * Nothing in this module computes a price. Bill lines are copied from
 * dispense_lines by app.raise_bill, which are themselves computed under the MRP
 * ceiling inside app.dispense — so the number on the screen, the number on the
 * printed bill and the number in the ledger are one number that travelled,
 * rather than three that agree until they do not.
 */
import { db } from './index';

export interface ClinicSettings {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  doctor_reg_no: string | null;
  drug_licence_no: string | null;
  gstin: string | null;
  consult_fee: number;
  follow_up_free_days: number | null;
}

export async function clinicSettings(): Promise<ClinicSettings | null> {
  const { data, error } = await db()
    .from('clinic')
    .select(
      'id, name, address, phone, doctor_reg_no, drug_licence_no, gstin, consult_fee, follow_up_free_days',
    )
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as ClinicSettings) ?? null;
}

export interface UnbilledDispense {
  id: string;
  patient_id: string | null;
  patient_name: string;
  prescription_id: string | null;
  /**
   * The visit this dispense belongs to, when there was one.
   *
   * It is here because the consultation fee depends on it: clinic policy — a
   * free follow-up inside a window he sets — can only be applied against a
   * previous visit, so a bill raised without the encounter charges the standard
   * fee or none at all, and the policy silently stops existing.
   */
  encounter_id: string | null;
  is_counter_sale: boolean;
  at: string;
  lines: number;
  amount: number;
}

/**
 * What has left the shelf today and has not been paid for.
 *
 * This is the counter's actual worklist. A dispense with no bill is medicine
 * out of the door and no money in the drawer, so it is deliberately the first
 * thing on the billing screen.
 */
export async function unbilledDispenses(): Promise<UnbilledDispense[]> {
  const { data, error } = await db()
    .from('dispenses')
    .select(
      'id, patient_id, prescription_id, is_counter_sale, at, patients(name), prescriptions(encounter_id), dispense_lines(amount)',
    )
    .is('bill_id', null)
    .order('at', { ascending: false })
    .limit(50);

  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    const lines = (row.dispense_lines as Array<{ amount: number }> | null) ?? [];
    return {
      id: row.id as string,
      patient_id: (row.patient_id as string) ?? null,
      patient_name:
        (row.patients as { name?: string } | null)?.name ??
        (row.is_counter_sale ? 'Counter sale' : 'Walk-in'),
      prescription_id: (row.prescription_id as string) ?? null,
      encounter_id:
        (row.prescriptions as { encounter_id?: string } | null)?.encounter_id ?? null,
      is_counter_sale: row.is_counter_sale as boolean,
      at: row.at as string,
      lines: lines.length,
      amount: lines.reduce((sum, line) => sum + Number(line.amount), 0),
    };
  });
}

export interface BillLine {
  id: string;
  kind: 'consult' | 'medicine' | 'other';
  description: string;
  batch_no: string | null;
  expiry: string | null;
  qty_base: number | null;
  unit_price: number | null;
  amount: number;
  hsn: string | null;
}

export interface Bill {
  id: string;
  bill_no: string;
  patient_id: string | null;
  encounter_id: string | null;
  consult_fee: number;
  consult_fee_basis: 'standard' | 'follow_up_free' | 'manual';
  medicines_total: number;
  discount: number;
  round_off: number;
  total: number;
  status: 'unpaid' | 'paid' | 'cancelled';
  method: 'cash' | 'upi' | 'card' | null;
  paid_at: string | null;
  created_at: string;
  void_reason: string | null;
  patient_name: string | null;
  lines: BillLine[];
}

const BILL_COLUMNS =
  'id, bill_no, patient_id, encounter_id, consult_fee, consult_fee_basis, medicines_total, discount, round_off, total, status, method, paid_at, created_at, void_reason, patients(name), bill_lines(id, kind, description, batch_no, expiry, qty_base, unit_price, amount, hsn)';

function toBill(row: Record<string, unknown>): Bill {
  return {
    ...(row as unknown as Bill),
    patient_name: (row.patients as { name?: string } | null)?.name ?? null,
    lines: ((row.bill_lines as BillLine[]) ?? []).sort((a, b) =>
      a.kind === b.kind ? a.description.localeCompare(b.description) : a.kind === 'consult' ? -1 : 1,
    ),
  };
}

export async function getBill(id: string): Promise<Bill | null> {
  const { data, error } = await db()
    .from('bills')
    .select(BILL_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data ? toBill(data as Record<string, unknown>) : null;
}

/** Today's bills, newest first — the counter's own record of the day. */
export async function billsToday(): Promise<Bill[]> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const { data, error } = await db()
    .from('bills')
    .select(BILL_COLUMNS)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map(toBill);
}

export interface DayBookRow {
  day: string;
  bills: number;
  consult_total: number;
  medicines_total: number;
  discount: number;
  round_off: number;
  net_total: number;
  cash: number;
  upi: number;
  card: number;
  unpaid: number;
  cancelled: number;
}

export async function dayBook(days = 14): Promise<DayBookRow[]> {
  const { data, error } = await db()
    .from('day_book')
    .select('*')
    .order('day', { ascending: false })
    .limit(days);

  if (error) throw new Error(error.message);
  return (data ?? []) as DayBookRow[];
}

export interface TillReconciliation {
  till_id: string;
  status: 'open' | 'closed';
  opened_at: string;
  opened_by_name: string | null;
  opening_float: number;
  cash_sales: number;
  refunds: number;
  pay_ins: number;
  pay_outs: number;
  expected_cash: number;
  counted_cash: number | null;
  variance: number | null;
  closed_at: string | null;
}

/**
 * The open drawer, if there is one.
 *
 * Deliberately not cached anywhere: whether a till is open decides whether cash
 * can be taken at all, and a screen holding a stale answer to that question
 * takes money into a drawer nobody is counting.
 */
export async function openTill(): Promise<TillReconciliation | null> {
  const { data, error } = await db()
    .from('till_reconciliation')
    .select('*')
    .eq('status', 'open')
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as TillReconciliation) ?? null;
}

export async function recentTills(limit = 7): Promise<TillReconciliation[]> {
  const { data, error } = await db()
    .from('till_reconciliation')
    .select('*')
    .order('opened_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []) as TillReconciliation[];
}
