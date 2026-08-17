/**
 * Clinic settings. PLAN.md §16, §18 Q10.
 *
 * Two conventions carried straight from the transition, and both matter to the
 * caller:
 *
 *   a field left `undefined` keeps whatever is stored — so a screen that only
 *     knows about half the settings cannot blank the other half;
 *   a field sent as `''` is cleared.
 *
 * Opening hours are the day-by-day timetable `app.clinic_is_open` reads. A day
 * it cannot parse means *closed*, forever, so the database validates the shape
 * rather than storing whatever arrives.
 */
import { appSchema } from '@/lib/db';
import type { ClinicRow, OpenHours, Weekday } from '@/lib/db/settings';
import { toTransitionError } from './errors';

export type { ClinicRow, OpenHours, Weekday } from '@/lib/db/settings';

export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export interface ClinicUpdate {
  name?: string;
  address?: string;
  phone?: string;
  doctorRegNo?: string;
  drugLicenceNo?: string;
  gstin?: string;
  consultFee?: number;
  /** Days a follow-up is free. `-1` switches the policy off entirely. */
  followUpFreeDays?: number;
  roundToRupee?: boolean;
  openHours?: OpenHours;
  timezone?: string;
}

export async function updateClinic(input: ClinicUpdate): Promise<ClinicRow> {
  const { data, error } = await appSchema().rpc('update_clinic', {
    p_name: input.name ?? null,
    p_address: input.address ?? null,
    p_phone: input.phone ?? null,
    p_doctor_reg_no: input.doctorRegNo ?? null,
    p_drug_licence_no: input.drugLicenceNo ?? null,
    p_gstin: input.gstin ?? null,
    p_consult_fee: input.consultFee ?? null,
    p_follow_up_free_days: input.followUpFreeDays ?? null,
    p_round_to_rupee: input.roundToRupee ?? null,
    p_open_hours: input.openHours ?? null,
    p_timezone: input.timezone ?? null,
  });

  if (error) throw toTransitionError(error);
  return data as ClinicRow;
}

/**
 * "09:30-13:00, 17:00-20:30" → `["09:30-13:00", "17:00-20:30"]`.
 *
 * One text box per day rather than four time pickers, because that is how the
 * doctor says it — "mornings and evenings, half day Saturday" — and because a
 * time picker on a tablet costs four taps per boundary, fourteen boundaries a
 * week. What is *not* done here is any repair of what he typed: a window this
 * cannot read is passed through and refused by the database, by day and by
 * window, in words. A parser that quietly drops what it does not understand
 * turns a typo into a closed clinic.
 */
export function parseWindows(text: string): string[] {
  return text
    .split(/[,;]/)
    .map((part) => part.trim().replace(/\s*[–—]\s*/g, '-').replace(/\s*-\s*/g, '-'))
    .filter((part) => part !== '');
}

export function formatWindows(windows: string[] | undefined): string {
  return (windows ?? []).join(', ');
}
