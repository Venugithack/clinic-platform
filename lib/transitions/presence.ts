/**
 * Presence transitions. PLAN.md §13.2.
 */
import { appSchema } from '@/lib/db';
import { toTransitionError } from './errors';

export type PresenceStatus = 'in_clinic' | 'in_consult' | 'break' | 'away';

/**
 * The 30-second heartbeat.
 *
 * Failures are swallowed by the caller on purpose: a missed ping is not an
 * error to show anybody, it is simply an older `as_of` on the status page,
 * which is the honest outcome anyway.
 */
export async function presencePing(): Promise<void> {
  const { error } = await appSchema().rpc('presence_ping', {});
  if (error) throw toTransitionError(error);
}

export async function setPresence(
  status: PresenceStatus,
  breakUntil?: Date,
  note?: string,
): Promise<void> {
  const { error } = await appSchema().rpc('set_presence', {
    p_status: status,
    p_break_until: breakUntil?.toISOString() ?? null,
    p_note: note ?? null,
  });

  if (error) throw toTransitionError(error);
}

/** Returns how many patients already have an appointment today. */
export async function closeClinicToday(reason: string): Promise<number> {
  const { data, error } = await appSchema().rpc('close_clinic_today', {
    p_reason: reason,
  });

  if (error) throw toTransitionError(error);
  return Number(data);
}

export async function reopenClinicToday(): Promise<void> {
  const { error } = await appSchema().rpc('reopen_clinic_today', {});
  if (error) throw toTransitionError(error);
}
