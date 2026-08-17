/**
 * Billing and till transitions. PLAN.md §5.3 rule 4 — money never moves
 * unattended, and every one of these is a person deciding something.
 */
import { appSchema } from '@/lib/db';
import { toTransitionError } from './errors';

/**
 * What a billing transition returns: the bill ROW, and deliberately not its
 * lines.
 *
 * A plpgsql function returning `bills` returns exactly that table's columns —
 * there is no `lines` on it, and a caller that assumed otherwise rendered
 * `undefined.map()` and took the whole screen down with it. Reading a bill with
 * its lines is `lib/db/billing.getBill`, and the type here is narrow so that
 * mistake cannot be made twice.
 */
export interface BillRow {
  id: string;
  bill_no: string;
  consult_fee: number;
  medicines_total: number;
  discount: number;
  round_off: number;
  total: number;
  status: 'unpaid' | 'paid' | 'cancelled';
  method: 'cash' | 'upi' | 'card' | null;
}

export interface RaiseBillInput {
  patientId?: string;
  encounterId?: string;
  /** Dispenses already made against this visit; their lines become bill lines. */
  dispenseIds?: string[];
  /** Omitted means clinic policy decides — including a free follow-up. */
  consultFee?: number;
  discount?: number;
  note?: string;
}

export async function raiseBill(input: RaiseBillInput): Promise<BillRow> {
  const { data, error } = await appSchema().rpc('raise_bill', {
    p_patient_id: input.patientId ?? null,
    p_encounter_id: input.encounterId ?? null,
    p_dispense_ids: input.dispenseIds ?? [],
    p_consult_fee: input.consultFee ?? null,
    p_discount: input.discount ?? 0,
    p_note: input.note ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as BillRow;
}

/**
 * The amount must settle the bill in full.
 *
 * Cash tendered and change given are the screen's business; what is recorded is
 * what the bill was settled for. Part-payment would turn every unpaid bill into
 * a debtor ledger the clinic does not keep.
 */
export async function takePayment(
  billId: string,
  method: 'cash' | 'upi' | 'card',
  amount: number,
): Promise<BillRow> {
  const { data, error } = await appSchema().rpc('take_payment', {
    p_bill_id: billId,
    p_method: method,
    p_amount: amount,
  });

  if (error) throw toTransitionError(error);
  return data as BillRow;
}

export async function voidBill(billId: string, reason: string): Promise<BillRow> {
  const { data, error } = await appSchema().rpc('void_bill', {
    p_bill_id: billId,
    p_reason: reason,
  });

  if (error) throw toTransitionError(error);
  return data as BillRow;
}

export interface TillSession {
  id: string;
  status: 'open' | 'closed';
  opening_float: number;
  counted_cash: number | null;
  expected_cash: number | null;
  variance: number | null;
}

export async function openTill(openingFloat: number): Promise<TillSession> {
  const { data, error } = await appSchema().rpc('open_till', {
    p_opening_float: openingFloat,
  });

  if (error) throw toTransitionError(error);
  return data as TillSession;
}

export async function recordCash(
  kind: 'payin' | 'payout',
  amount: number,
  reason: string,
): Promise<void> {
  const { error } = await appSchema().rpc('record_cash', {
    p_kind: kind,
    p_amount: amount,
    p_reason: reason,
  });

  if (error) throw toTransitionError(error);
}

/** Returns the closed till, carrying the count, the expectation and the gap. */
export async function closeTill(
  tillId: string,
  countedCash: number,
  note?: string,
): Promise<TillSession> {
  const { data, error } = await appSchema().rpc('close_till', {
    p_till_id: tillId,
    p_counted_cash: countedCash,
    p_note: note ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as TillSession;
}
