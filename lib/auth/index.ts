/**
 * Auth, behind one adapter. HOSTING.md §7, TABLET.md §5.
 *
 * Two separable things, deliberately:
 *
 *   the DEVICE holds the session  — trusted once by an admin/doctor email,
 *                                   revocable from one screen
 *   the PIN holds the identity    — six digits, per staff member, idle-locked
 *
 * Email is used only to establish device ownership or remote owner access.
 * Staff do not type email/password during the clinic day.
 */
import {
  appSchema,
  clearStoredSession,
  db,
  readStoredSession,
  writeStoredSession,
  type StoredSession,
} from '@/lib/db';

export type StaffSession = StoredSession;
export { writeStoredSession };

const DEVICE_TOKEN_KEY = 'clinic.deviceToken';

export function deviceToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(DEVICE_TOKEN_KEY);
}

export function registerDeviceLocally(token: string): void {
  window.localStorage.setItem(DEVICE_TOKEN_KEY, token);
}

export async function unlock(staffId: string, pin: string): Promise<StaffSession> {
  const device = deviceToken();
  if (!device) {
    throw new Error('This tablet is not trusted yet. Sign in with an administrator email.');
  }

  const { data, error } = await appSchema().rpc('unlock', {
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

  writeStoredSession(session);
  return session;
}

export function currentSession(): StaffSession | null {
  return readStoredSession();
}

/** Called on activity, not on a timer. The idle window comes from the device. */
export async function touch(): Promise<boolean> {
  const session = currentSession();
  if (!session) return false;

  const { data } = await appSchema().rpc('touch_session', { p_token: session.token });
  if (data !== true) {
    clearStoredSession();
    return false;
  }
  return true;
}

export async function lock(): Promise<void> {
  const session = currentSession();
  if (session) {
    await appSchema().rpc('lock', { p_token: session.token });
  }
  clearStoredSession();
}

// ---------------------------------------------------------------------------
// Owner email access.
//
// These are kept here rather than in a screen so @supabase remains behind the
// lib/db seam. A normal browser already has an anonymous Supabase session; only
// a magic-link session with a real email is accepted by the DB trust functions.
// ---------------------------------------------------------------------------
export interface EmailIdentity {
  id: string;
  email: string;
}

export async function sendEmailAccessLink(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error('Enter your email address.');

  const redirectTo =
    typeof window === 'undefined' ? undefined : `${window.location.origin}/enroll`;
  const { error } = await db().auth.signInWithOtp({
    email: normalized,
    options: {
      // Creating an Auth user is harmless by itself. The database separately
      // requires the email to be pre-authorized on an admin/doctor staff row,
      // except for the guarded first-clinic/legacy-claim paths.
      shouldCreateUser: true,
      emailRedirectTo: redirectTo,
    },
  });

  if (error) throw new Error(error.message);
}

export async function emailIdentity(): Promise<EmailIdentity | null> {
  const { data, error } = await db().auth.getUser();
  if (error || !data.user || data.user.is_anonymous || !data.user.email) return null;
  return { id: data.user.id, email: data.user.email.toLowerCase() };
}

export async function signOutEmailIdentity(): Promise<void> {
  // Device/PIN trust is independent of the email auth session. Signing the
  // owner email out does not untrust the tablet they just enrolled.
  await db().auth.signOut();
}
