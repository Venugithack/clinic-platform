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

/** Who the dispense screen is about: the person, their allergies, their token. */
export interface CounterHeader {
  patient_id: string;
  patient_name: string;
  allergies: string | null;
  token_no: number | null;
  doctor_name: string;
}

/**
 * The dispense screen's header, for a prescription in any state.
 *
 * Deliberately NOT read from `pharmacy_queue`. That view is the counter's
 * worklist and holds only `pending` and `partial`, so the row vanished the
 * instant a prescription was fully dispensed — and the screen, still open in
 * front of the pharmacist, replaced the patient's name with the same `…` it
 * shows while loading and the token with `—`. The identity disappeared at the
 * exact moment it was being confirmed, and a completed dispense was rendered
 * as a screen that had failed to load.
 *
 * `prescriptions` has no status filter on it, so this answers for a
 * prescription that is pending, partly dispensed, or finished — which is what a
 * header should do. Allergies come from the patient and the token from the
 * appointment, neither of which stops being true when the medicine is handed
 * over.
 */
export async function counterHeader(
  prescriptionId: string,
): Promise<CounterHeader | null> {
  const { data, error } = await db()
    .from('prescriptions')
    .select(
      `patient_id,
       patient:patients!prescriptions_patient_id_fkey(name, allergies),
       doctor:staff!prescriptions_doctor_id_fkey(name),
       encounter:encounters!prescriptions_encounter_id_fkey(
         appointment:appointments!encounters_appointment_id_fkey(token_no)
       )`,
    )
    .eq('id', prescriptionId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const row = data as unknown as {
    patient_id: string;
    patient: { name: string; allergies: string | null } | null;
    doctor: { name: string } | null;
    encounter: { appointment: { token_no: number | null } | null } | null;
  };

  return {
    patient_id: row.patient_id,
    patient_name: row.patient?.name ?? '',
    allergies: row.patient?.allergies ?? null,
    // A walk-in seen without an appointment has no token, and never had one.
    token_no: row.encounter?.appointment?.token_no ?? null,
    doctor_name: row.doctor?.name ?? '',
  };
}

export interface FefoBatch {
  batch_id: string;
  batch_no: string;
  expiry: string;
  qty_base: number;
  mrp: number;
  units_in_pack: number;
}

/**
 * Which batches a dispense will draw from, shown before it is committed.
 *
 * A PREVIEW. app.dispense does the real allocation inside one transaction with
 * the ledger row and the audit row, and it is the only thing that decides. This
 * exists so the pharmacist can see which box to reach for — "take the March
 * one" — before anything moves. If the two ever disagree, the database is
 * right and this is the bug.
 */
export async function fefoPreview(drugId: string, qtyBase: number): Promise<FefoBatch[]> {
  const { data, error } = await db()
    .from('available_stock')
    .select('batch_id, batch_no, expiry, qty_base_on_hand, mrp, units_in_pack')
    .eq('drug_id', drugId)
    // First expiry, first out — the same order the transition uses.
    .order('expiry', { ascending: true });

  if (error) throw new Error(error.message);

  const allocation: FefoBatch[] = [];
  let remaining = qtyBase;

  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    if (remaining <= 0) break;
    const available = row.qty_base_on_hand as number;
    const take = Math.min(remaining, available);
    allocation.push({
      batch_id: row.batch_id as string,
      batch_no: row.batch_no as string,
      expiry: row.expiry as string,
      qty_base: take,
      mrp: row.mrp as number,
      units_in_pack: row.units_in_pack as number,
    });
    remaining -= take;
  }

  return allocation;
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
  /** dispense_lines requires the approver's name against a substitution. */
  answered_by: string | null;
}

/** Every question on this prescription, so the counter can see the answers. */
export async function queriesForPrescription(
  prescriptionId: string,
): Promise<AnsweredQuery[]> {
  const { data, error } = await db()
    .from('counter_queries')
    .select('id, drug_id, kind, status, decision, approved_drug_id, answer_note, answered_at, answered_by')
    .eq('prescription_id', prescriptionId)
    .order('raised_at');

  if (error) throw new Error(error.message);
  return (data ?? []) as AnsweredQuery[];
}
