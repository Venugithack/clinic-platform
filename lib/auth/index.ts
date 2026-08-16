/**
 * Auth, behind one adapter. HOSTING.md §7, TABLET.md §5.
 *
 * Two separable things, deliberately:
 *
 *   the DEVICE holds the session  — a long-lived Supabase session, registered
 *                                   once by the admin, revocable from one screen
 *   the PIN holds the identity    — six digits, per staff member, idle-locked
 *
 * Attribution stays exact — which the Schedule H1 register legally requires —
 * and nobody types a password forty times a day on a shared tablet.
 *
 * The whole Supabase surface used here is `rpc` and `auth`, both reached
 * through lib/db. Swapping Supabase Auth for something else is this file plus
 * lib/db, and no screen changes (HOSTING.md §7's exit ramp).
 */
import { db } from '@/lib/db';

const SESSION_STORAGE_KEY = 'clinic.staffSession';

export interface StaffSession {
  token: string;
  staffId: string;
  staffName: string;
  role: 'doctor' | 'counter' | 'admin';
}

/**
 * The device token identifies the tablet, not the person. It is written once at
 * registration and never rotated by the app.
 */
export function deviceToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem('clinic.deviceToken');
}

export function registerDeviceLocally(token: string): void {
  window.localStorage.setItem('clinic.deviceToken', token);
}

/**
 * Unlock with a PIN.
 *
 * Failure is deliberately undifferentiated: a wrong PIN, an unknown staff
 * member and a revoked device all surface the same way, because a lock screen
 * that tells you which half you got right is a lock screen that helps.
 */
export async function unlock(staffId: string, pin: string): Promise<StaffSession> {
  const device = deviceToken();
  if (!device) {
    throw new Error('This tablet is not registered. Ask the administrator to register it.');
  }

  const { data, error } = await db().rpc('unlock', {
    p_device_token: device,
    p_staff_id: staffId,
    p_pin: pin,
  });

  if (error || typeof data !== 'string') {
    throw new Error('Incorrect PIN.');
  }

  const { data: staff } = await db()
    .from('staff')
    .select('id, name, role')
    .eq('id', staffId)
    .single();

  const session: StaffSession = {
    token: data,
    staffId,
    staffName: staff?.name ?? '',
    role: staff?.role ?? 'counter',
  };

  window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  return session;
}

export function currentSession(): StaffSession | null {
  if (typeof window === 'undefined') return null;
  const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as StaffSession) : null;
}

/** Called on activity, not on a timer. The idle window comes from the device. */
export async function touch(): Promise<boolean> {
  const session = currentSession();
  if (!session) return false;

  const { data } = await db().rpc('touch_session', { p_token: session.token });
  if (data !== true) {
    lockLocally();
    return false;
  }
  return true;
}

export async function lock(): Promise<void> {
  const session = currentSession();
  if (session) {
    await db().rpc('lock', { p_token: session.token });
  }
  lockLocally();
}

function lockLocally(): void {
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

/**
 * The staff session token travels to Postgres in the `app.staff_session` GUC,
 * where app.current_staff_id() reads it — see 20260816090700_auth_device_pin.sql.
 *
 * On Supabase that is wired with a `db-pre-request` function reading the
 * request headers; locally and in tests the GUC is set directly. Either way the
 * token, not the device's auth user, is what names the person in audit_log.
 */
export function sessionHeaders(): Record<string, string> {
  const session = currentSession();
  return session ? { 'x-staff-session': session.token } : {};
}
