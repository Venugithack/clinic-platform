/**
 * Presence. PLAN.md §13.
 *
 * Every read here carries `as_of`, and nothing in this module returns a bare
 * status. That is rule 6 expressed as a type: a caller cannot accidentally
 * render "he is in" without also having the time that reading was true.
 */
import { db } from './index';

export type EffectiveStatus = 'in_clinic' | 'in_consult' | 'break' | 'away' | 'closed';

export interface ClinicNow {
  clinic_name: string;
  doctor_name: string | null;
  status: EffectiveStatus;
  break_until: string | null;
  as_of: string | null;
  clinic_open: boolean;
}

/**
 * The public reading, and the only thing in this build an unauthenticated
 * caller may select. It carries no patient data at all.
 */
export async function clinicNow(): Promise<ClinicNow | null> {
  const { data, error } = await db()
    .from('clinic_now')
    .select('*')
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as ClinicNow) ?? null;
}

export interface PresenceDetail {
  staff_id: string;
  staff_name: string;
  role: 'doctor' | 'counter' | 'admin';
  /** What he said. */
  declared_status: 'in_clinic' | 'in_consult' | 'break' | 'away';
  /** What a patient would be told. They differ exactly when it matters. */
  effective_status: EffectiveStatus;
  source: 'auto' | 'manual';
  last_heartbeat_at: string | null;
  break_until: string | null;
  note: string | null;
  device_label: string | null;
  is_clinic_device: boolean | null;
}

export async function presenceDetail(): Promise<PresenceDetail[]> {
  const { data, error } = await db()
    .from('presence_detail')
    .select('*')
    .order('role');

  if (error) throw new Error(error.message);
  return (data ?? []) as PresenceDetail[];
}
