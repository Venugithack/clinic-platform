/**
 * The counter's view of the world.
 */
import { db } from './index';

export type StockState = 'full' | 'partial' | 'out';

export interface PharmacyQueueEntry {
  prescription_id: string;
  patient_id: string;
  patient_name: string;
  allergies: string | null;
  token_no: number | null;
  signed_at: string;
  status: 'pending' | 'partial';
  doctor_name: string;
  lines: number;
  lines_in_stock: number;
  lines_out: number;
  /** Computed in the view so the counter and the doctor cannot disagree. */
  stock_state: StockState;
  open_queries: number;
}

export async function pharmacyQueue(): Promise<PharmacyQueueEntry[]> {
  const { data, error } = await db()
    .from('pharmacy_queue')
    .select('*')
    // Newest prescription at the top — the pharmacist works the arrival order,
    // not the token order (TABLET.md §7).
    .order('signed_at', { ascending: false });

  if (error) throw new Error(error.message);
  if (data === null) throw new Error('The clinic database did not respond.');
  return data as PharmacyQueueEntry[];
}

export async function pharmacyQueueEntry(
  prescriptionId: string,
): Promise<PharmacyQueueEntry | null> {
  const { data, error } = await db()
    .from('pharmacy_queue')
    .select('*')
    .eq('prescription_id', prescriptionId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as PharmacyQueueEntry) ?? null;
}

export type CounterQueryKind = 'out_of_stock' | 'substitution' | 'clarification';
export type CounterQueryDecision = 'approved' | 'rejected' | 'amended';

export interface OpenCounterQuery {
  id: string;
  prescription_id: string;
  kind: CounterQueryKind;
  note: string | null;
  raised_at: string;
  drug_id: string;
  drug_name: string;
  drug_strength: string;
  proposed_drug_id: string | null;
  proposed_name: string | null;
  proposed_strength: string | null;
  proposed_salt: string | null;
  raised_by_name: string;
  doctor_id: string;
  patient_id: string;
  patient_name: string;
}

/** What the doctor has to answer, without leaving the consult screen. */
export async function openQueriesForDoctor(doctorId: string): Promise<OpenCounterQuery[]> {
  const { data, error } = await db()
    .from('open_counter_queries')
    .select('*')
    .eq('doctor_id', doctorId)
    .order('raised_at');

  if (error) throw new Error(error.message);
  return (data ?? []) as OpenCounterQuery[];
}

export async function openQueriesForPrescription(
  prescriptionId: string,
): Promise<OpenCounterQuery[]> {
  const { data, error } = await db()
    .from('open_counter_queries')
    .select('*')
    .eq('prescription_id', prescriptionId)
    .order('raised_at');

  if (error) throw new Error(error.message);
  return (data ?? []) as OpenCounterQuery[];
}

export interface AnsweredQuery {
  id: string;
  drug_id: string;
  kind: CounterQueryKind;
  status: 'open' | 'answered' | 'withdrawn';
  decision: CounterQueryDecision | null;
  approved_drug_id: string | null;
  answer_note: string | null;
  answered_at: string | null;
}

/** Every question on this prescription, so the counter can see the answers. */
export async function queriesForPrescription(
  prescriptionId: string,
): Promise<AnsweredQuery[]> {
  const { data, error } = await db()
    .from('counter_queries')
    .select('id, drug_id, kind, status, decision, approved_drug_id, answer_note, answered_at')
    .eq('prescription_id', prescriptionId)
    .order('raised_at');

  if (error) throw new Error(error.message);
  return (data ?? []) as AnsweredQuery[];
}
