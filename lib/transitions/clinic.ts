/**
 * Thin typed wrappers over the M1 transitions. PLAN.md §5.3 rule 2.
 *
 * Same specification as lib/transitions/dispense.ts: no business logic here.
 * Token allocation, the appointment state machine and the signing rules live in
 * plpgsql, next to the audit rows they produce.
 */
import { appSchema } from '@/lib/db';
import type { AppointmentStatus } from '@/lib/db/queue';
import { toTransitionError } from './errors';

export interface Appointment {
  id: string;
  patient_id: string;
  date: string;
  token_no: number;
  status: AppointmentStatus;
  source: 'walkin' | 'whatsapp' | 'phone';
  reason: string | null;
}

export async function bookAppointment(input: {
  patientId: string;
  date?: string;
  source?: 'walkin' | 'whatsapp' | 'phone';
  reason?: string;
}): Promise<Appointment> {
  const { data, error } = await appSchema().rpc('book_appointment', {
    p_patient_id: input.patientId,
    p_date: input.date ?? null,
    p_source: input.source ?? 'walkin',
    p_reason: input.reason ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as Appointment;
}

export async function setAppointmentStatus(
  appointmentId: string,
  status: AppointmentStatus,
): Promise<Appointment> {
  const { data, error } = await appSchema().rpc('set_appointment_status', {
    p_appointment_id: appointmentId,
    p_status: status,
  });

  if (error) throw toTransitionError(error);
  return data as Appointment;
}

/**
 * Signing closes the prescription. After this it cannot be edited: it is what
 * the pharmacy dispenses against, what the Schedule H1 register cites, and
 * per A7 the printed copy the doctor signs by hand is the legal document.
 */
export async function signPrescription(prescriptionId: string): Promise<{ signed_at: string }> {
  const { data, error } = await appSchema().rpc('sign_prescription', {
    p_prescription_id: prescriptionId,
  });

  if (error) throw toTransitionError(error);
  return data as { signed_at: string };
}
