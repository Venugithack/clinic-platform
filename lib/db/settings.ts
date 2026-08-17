/**
 * The clinic row, read whole. PLAN.md §18 Q10.
 *
 * `lib/db/billing.ts` already reads the half of this row a bill needs. The
 * settings screen needs all of it — including `open_hours`, which is the
 * timetable `app.clinic_is_open` reads and the public status page depends on.
 */
import { db } from '@/lib/db';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** `{"mon": ["09:30-13:00", "17:00-20:30"], "sun": []}` — a day with no windows is shut. */
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

/**
 * Null when the database has no clinic yet.
 *
 * That is a real state, not an error: it is day one of go-live on an empty
 * database, and the settings screen is what leaves it.
 */
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
