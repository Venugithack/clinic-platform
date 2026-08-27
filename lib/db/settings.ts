/** Clinic settings reads. */
import { db } from '@/lib/db';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type OpenHours = Partial<Record<Weekday, string[]>>;

export interface ClinicRow {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  doctor_reg_no: string | null;
  drug_licence_no: string | null;
  gstin: string | null;
  consult_fee: number;
  follow_up_free_days: number | null;
  round_to_rupee: boolean;
  open_hours: OpenHours;
  timezone: string;
}

export async function clinicRow(): Promise<ClinicRow | null> {
  const { data, error } = await db()
    .from('clinic')
    .select(
      'id, name, address, phone, doctor_reg_no, drug_licence_no, gstin, ' +
        'consult_fee, follow_up_free_days, round_to_rupee, open_hours, timezone',
    )
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as ClinicRow | null) ?? null;
}

/** A failed read is unknown, never permission to bootstrap. */
export async function needsSetup(): Promise<boolean | undefined> {
  const { data, error } = await db()
    .from('clinic_setup_state')
    .select('needs_setup')
    .maybeSingle();
  if (error || data === null) return undefined;
  return (data as { needs_setup: boolean }).needs_setup;
}

/** Whether an established clinic already has an admin/doctor email owner. */
export async function hasEmailOwner(): Promise<boolean | undefined> {
  const { data, error } = await db()
    .from('email_access_state')
    .select('has_email_owner')
    .maybeSingle();
  if (error || data === null) return undefined;
  return (data as { has_email_owner: boolean }).has_email_owner;
}
