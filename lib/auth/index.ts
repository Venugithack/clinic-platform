/**
 * Clinic authentication behind one adapter.
 *
 * Two identities, deliberately:
 *   - owner/admin: verified email OTP for control-panel access and recovery
 *   - daily staff: name + six-digit PIN from any browser
 *
 * The browser is not trusted. Postgres mints a short-lived staff session token
 * after either successful path, and every protected request carries that token.
 */
import {
  appSchema,
  clearStoredSession,
  db,
  readStoredSession,
  resetDb,
  writeStoredSession,
  type StoredSession,
} from '@/lib/db';

export type StaffSession = StoredSession;
export { writeStoredSession };

interface SessionPayload {
  session_token: string;
  staff_id: string;
  staff_name: string;
  staff_role: StaffSession['role'];
}

interface UnlockPayload extends Partial<SessionPayload> {
  ok: boolean;
  reason?: 'incorrect' | 'locked';
}

function storePayload(payload: SessionPayload): StaffSession {
  const session: StaffSession = {
    token: payload.session_token,
    staffId: payload.staff_id,
    staffName: payload.staff_name,
    role: payload.staff_role,
  };
  writeStoredSession(session);
  return session;
}

export async function unlock(staffId: string, pin: string): Promise<StaffSession> {
  const { data, error } = await appSchema().rpc('unlock_staff', {
    p_staff_id: staffId,
    p_pin: pin,
  });

  if (error || !data) throw new Error('Could not sign in. Try again.');

  const result = data as UnlockPayload;
  if (!result.ok) {
    if (result.reason === 'locked') {
      throw new Error('Too many incorrect attempts. Try again in 10 minutes.');
    }
    throw new Error('Incorrect PIN.');
  }

  if (!result.session_token || !result.staff_id || !result.staff_name || !result.staff_role) {
    throw new Error('Could not start your clinic session. Try again.');
  }

  return storePayload(result as SessionPayload);
}

export function currentSession(): StaffSession | null {
  return readStoredSession();
}

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
  if (session) await appSchema().rpc('lock', { p_token: session.token });
  clearStoredSession();
}

export interface EmailIdentity {
  id: string;
  email: string;
}

/** Send a six-digit Supabase email OTP. The email template must contain {{ .Token }}. */
export async function sendEmailOtp(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error('Enter your email address.');

  const { error } = await db().auth.signInWithOtp({
    email: normalized,
    options: { shouldCreateUser: true },
  });
  if (error) throw new Error(error.message);
}

export async function verifyEmailOtp(email: string, token: string): Promise<EmailIdentity> {
  const normalized = email.trim().toLowerCase();
  const code = token.replace(/\D/g, '');
  if (code.length !== 6) throw new Error('Enter the 6-digit code from your email.');

  const { data, error } = await db().auth.verifyOtp({
    email: normalized,
    token: code,
    type: 'email',
  });
  if (error || !data.user?.email) throw new Error(error?.message ?? 'The code is invalid or expired.');
  return { id: data.user.id, email: data.user.email.toLowerCase() };
}

export async function emailIdentity(): Promise<EmailIdentity | null> {
  const { data, error } = await db().auth.getUser();
  if (error || !data.user || data.user.is_anonymous || !data.user.email) return null;
  return { id: data.user.id, email: data.user.email.toLowerCase() };
}

export async function openOwnerSession(): Promise<StaffSession> {
  const { data, error } = await appSchema().rpc('owner_session');
  if (error || !data) throw new Error(error?.message ?? 'This email is not authorized for administration.');
  return storePayload(data as SessionPayload);
}

export async function firstRunOwner(staffName: string, pin: string): Promise<StaffSession> {
  const { data, error } = await appSchema().rpc('first_run_owner', {
    p_staff_name: staffName,
    p_pin: pin,
  });
  if (error || !data) throw new Error(error?.message ?? 'Clinic setup failed.');
  return storePayload(data as SessionPayload);
}

export async function signOutEmailIdentity(): Promise<void> {
  await db().auth.signOut();
  resetDb();
}
