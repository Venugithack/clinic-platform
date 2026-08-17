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

/**
 * Whether this database has ever been set up.
 *
 * Asked by the lock screen before anybody can sign in, which is why it is a
 * view of its own rather than a count of staff: the staff list is behind RLS
 * that requires a resolved staff member, so it comes back empty on a fresh
 * database and empty on a live one seen from an unregistered tablet, and a
 * screen cannot tell those two apart.
 *
 * A read that fails returns `undefined`, not `true`. Not knowing must never be
 * mistaken for "nobody has set this up", or a network blip on a working tablet
 * would offer a stranger the form that mints an administrator.
 */
export async function needsSetup(): Promise<boolean | undefined> {
  const { data, error } = await db()
    .from('clinic_setup_state')
    .select('needs_setup')
    .maybeSingle();

  if (error || data === null) return undefined;
  return (data as { needs_setup: boolean }).needs_setup;
}
