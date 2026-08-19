/**
 * Encounters and prescription drafts.
 *
 * Everything here is human-entered. PLAN.md §5.3 rule 8 and §15.3: no diagnosis
 * is suggested, no dose is inferred, no value is flagged high or low. The
 * absence of those features is the feature — suggesting a diagnosis from
 * symptoms engages CDSCO software-as-a-medical-device rules, and it must not
 * arrive by accident as an "autocomplete improvement".
 */
import { db } from './index';

export interface PrescriptionItem {
  drug_id: string;
  name: string;
  strength: string;
  /** Free text, as the doctor wrote it. Never computed. */
  dose: string;
  /** "1-0-1". Never computed. */
  freq: string;
  days: number;
  food?: 'before' | 'after' | 'with' | null;
  /** Base units. Always (INVENTORY.md §1). */
  qty_base: number;
}

export interface Encounter {
  id: string;
  patient_id: string;
  doctor_id: string;
  appointment_id: string | null;
  findings: Record<string, unknown>;
  diagnoses: string[];
  advice: string | null;
  follow_up_date: string | null;
  notes: string | null;
  created_at: string;
}

export async function startEncounter(
  patientId: string,
  doctorId: string,
  appointmentId: string,
): Promise<Encounter> {
  const existing = await encounterForAppointment(appointmentId);
  if (existing) return existing;

  const { data, error } = await db()
    .from('encounters')
    .insert({ patient_id: patientId, doctor_id: doctorId, appointment_id: appointmentId })
    .select('*')
    .single();

  if (error) throw new Error(error.message);
  return data as Encounter;
}

/**
 * The earliest encounter for an appointment, or null.
 *
 * `maybeSingle()` was `.single()`-shaped: it RAISES if the appointment has more
 * than one encounter, with PostgREST's own words — "JSON object requested,
 * multiple (or no) rows returned" — straight onto the consult screen. Once an
 * appointment had two rows, that consult could never be opened again, by
 * anybody, and the doctor was shown a database error instead of a patient.
 *
 * Two encounters is not hypothetical. `startEncounter` reads-then-inserts with
 * no unique constraint behind it (encounters.appointment_id is a plain
 * reference), so two overlapping calls both see nothing and both insert. React
 * re-invoking an effect is enough to do it.
 *
 * Ordering and taking the first makes the screen survive the duplicate instead
 * of being bricked by it. It is deliberately NOT the real fix: the real fix is
 * `unique (appointment_id)` plus an upsert, which is a forward-only migration
 * on clinical data and wants a decision, not a drive-by. Until then this keeps
 * a doctor in front of a patient rather than in front of an error.
 */
export async function encounterForAppointment(
  appointmentId: string,
): Promise<Encounter | null> {
  const { data, error } = await db()
    .from('encounters')
    .select('*')
    .eq('appointment_id', appointmentId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as Encounter) ?? null;
}

export async function saveEncounter(
  id: string,
  fields: Partial<Pick<Encounter, 'findings' | 'diagnoses' | 'advice' | 'follow_up_date' | 'notes'>>,
): Promise<void> {
  const { error } = await db().from('encounters').update(fields).eq('id', id);
  if (error) throw new Error(error.message);
}

export interface Prescription {
  id: string;
  encounter_id: string;
  patient_id: string;
  doctor_id: string;
  items: PrescriptionItem[];
  signed_at: string | null;
  status: 'pending' | 'partial' | 'dispensed' | 'cancelled';
}

/**
 * The working draft. One unsigned prescription per encounter — the composer
 * edits it in place, and signing (a transition) is what closes it.
 */
export async function draftPrescription(
  encounter: Encounter,
  items: PrescriptionItem[],
): Promise<Prescription> {
  const existing = await prescriptionForEncounter(encounter.id);

  if (existing && existing.signed_at === null) {
    const { data, error } = await db()
      .from('prescriptions')
      .update({ items })
      .eq('id', existing.id)
      .select('*')
      .single();

    if (error) throw new Error(error.message);
    return data as Prescription;
  }

  const { data, error } = await db()
    .from('prescriptions')
    .insert({
      encounter_id: encounter.id,
      patient_id: encounter.patient_id,
      doctor_id: encounter.doctor_id,
      items,
    })
    .select('*')
    .single();

  if (error) throw new Error(error.message);
  return data as Prescription;
}

export async function prescriptionForEncounter(
  encounterId: string,
): Promise<Prescription | null> {
  const { data, error } = await db()
    .from('prescriptions')
    .select('*')
    .eq('encounter_id', encounterId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as Prescription) ?? null;
}

export interface PrescriptionForPrint extends Prescription {
  patient: { name: string; age: number | null; sex: string | null; phone: string | null };
  doctor: { name: string; reg_no: string | null };
  encounter: { advice: string | null; follow_up_date: string | null; diagnoses: string[] };
  clinic: {
    name: string;
    address: string | null;
    phone: string | null;
    doctor_reg_no: string | null;
    drug_licence_no: string | null;
  };
}

/**
 * Everything the printed prescription needs, in one round trip.
 *
 * The doctor's name and registration number are not decoration: §15.2 requires
 * the prescriber against every Schedule H1 line, and A7 makes the printed copy
 * the legal document.
 */
export async function prescriptionForPrint(id: string): Promise<PrescriptionForPrint | null> {
  const { data, error } = await db()
    .from('prescriptions')
    .select(
      `*,
       patient:patients!prescriptions_patient_id_fkey(name, age, sex, phone),
       doctor:staff!prescriptions_doctor_id_fkey(name, reg_no),
       encounter:encounters!prescriptions_encounter_id_fkey(advice, follow_up_date, diagnoses)`,
    )
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const { data: clinic } = await db()
    .from('clinic')
    .select('name, address, phone, doctor_reg_no, drug_licence_no')
    .limit(1)
    .single();

  return { ...(data as PrescriptionForPrint), clinic: clinic as PrescriptionForPrint['clinic'] };
}
