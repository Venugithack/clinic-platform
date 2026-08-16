/**
 * Patients. Registration is ordinary CRUD under RLS — it moves neither money
 * nor stock, so it stays client-side (HOSTING.md §3's split).
 */
import { db } from './index';

export interface Patient {
  id: string;
  name: string;
  phone: string | null;
  age: number | null;
  sex: string | null;
  address: string | null;
  allergies: string | null;
  phone_is_shared: boolean;
  consent_given_at: string | null;
}

export interface NewPatient {
  name: string;
  phone?: string;
  age?: number;
  sex?: 'M' | 'F' | 'O';
  address?: string;
  allergies?: string;
}

/**
 * Search by name or phone.
 *
 * Phone first, because a receptionist asking "number?" is faster than spelling
 * a name — and because families share one handset constantly, a phone match can
 * return several people. That is not a bug to collapse; the caller shows a
 * chooser (PLAN.md §14).
 */
export async function searchPatients(query: string): Promise<Patient[]> {
  const trimmed = query.trim();
  if (trimmed.length < 3) return [];

  const { data, error } = await db()
    .from('patients')
    .select('*')
    .or(`name.ilike.%${trimmed}%,phone.ilike.%${trimmed}%`)
    .order('name')
    .limit(20);

  if (error) throw new Error(error.message);
  return (data ?? []) as Patient[];
}

export async function getPatient(id: string): Promise<Patient | null> {
  const { data, error } = await db().from('patients').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Patient) ?? null;
}

/**
 * Register a patient.
 *
 * Consent is captured here and timestamped, because DPDP §15.1 requires it to
 * be recorded and revocable rather than assumed. `phone_is_shared` is set when
 * the number already belongs to someone else — a real clinic hits that in week
 * one, and the prototype deferred it.
 */
export async function createPatient(input: NewPatient): Promise<Patient> {
  const shared = input.phone ? (await findByPhone(input.phone)).length > 0 : false;

  const { data, error } = await db()
    .from('patients')
    .insert({
      name: input.name.trim(),
      phone: input.phone?.trim() || null,
      age: input.age ?? null,
      sex: input.sex ?? null,
      address: input.address?.trim() || null,
      allergies: input.allergies?.trim() || null,
      phone_is_shared: shared,
      consent_given_at: new Date().toISOString(),
      consent_source: 'registration',
    })
    .select('*')
    .single();

  if (error) throw new Error(error.message);

  if (shared && input.phone) {
    // Both sides of a shared number are marked, not just the newcomer.
    await db().from('patients').update({ phone_is_shared: true }).eq('phone', input.phone);
  }

  return data as Patient;
}

async function findByPhone(phone: string): Promise<Patient[]> {
  const { data } = await db().from('patients').select('*').eq('phone', phone.trim());
  return (data ?? []) as Patient[];
}

export interface VisitSummary {
  id: string;
  created_at: string;
  diagnoses: unknown[];
  advice: string | null;
  follow_up_date: string | null;
}

/**
 * The context pane's history. Findings and notes are deliberately not selected:
 * this data reaches a screen the patient can see over the doctor's shoulder,
 * and rule 7's spirit is that clinician shorthand does not travel by default.
 */
export async function recentVisits(patientId: string, limit = 5): Promise<VisitSummary[]> {
  const { data, error } = await db()
    .from('encounters')
    .select('id, created_at, diagnoses, advice, follow_up_date')
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []) as VisitSummary[];
}
