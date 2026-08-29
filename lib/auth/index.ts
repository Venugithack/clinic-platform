/** Authentication adapter.
 *
 * Owner/admin: verified email OTP through Supabase Auth.
 * Staff: public name picker + six-digit PIN, producing a short-lived opaque
 * staff session. There is intentionally no device identity in sign-in: the
 * optional clinic-screen marker it passes cannot refuse anyone, and only
 * decides whether this browser may assert the doctor is present.
 */
import {
  appSchema,
  clearStoredSession,
  db,
  readClinicScreenToken,
  readStoredSession,
  writeStoredSession,
  type StoredSession,
} from '@/lib/db';

export type StaffSession = StoredSession;
export { writeStoredSession };

interface PinUnlockResult {
  ok: boolean;
  code?: 'incorrect' | 'locked';
  attempts_remaining?: number;
  retry_after_seconds?: number;
  session_token?: string;
  staff_id?: string;
  staff_name?: string;
  staff_role?: StaffSession['role'];
}

export async function unlock(staffId: string, pin: string): Promise<StaffSession> {
  const { data, error } = await appSchema().rpc('unlock_pin', {
    p_staff_id: staffId,
    p_pin: pin,
    // Only some browsers carry this, and that is the design. It says "this
    // screen stands in the clinic" and nothing else — it cannot refuse a
    // sign-in, and its absence is the ordinary case. All it buys the session is
    // the right to say the doctor is present (lib/db/clinicScreen.ts).
    p_screen_token: readClinicScreenToken(),
  });

  if (error) throw new Error(error.message);
  const result = data as PinUnlockResult | null;
  if (!result?.ok) {
    if (result?.code === 'locked') {
      const minutes = Math.max(1, Math.ceil((result.retry_after_seconds ?? 600) / 60));
      throw new Error(`Too many incorrect PINs. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
    const remaining = result?.attempts_remaining;
    throw new Error(
      typeof remaining === 'number'
        ? `Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before a temporary lock.`
        : 'Incorrect PIN.',
    );
  }

  if (!result.session_token || !result.staff_id || !result.staff_name || !result.staff_role) {
    throw new Error('The clinic could not start your session.');
  }

  const session: StaffSession = {
    token: result.session_token,
    staffId: result.staff_id,
    staffName: result.staff_name,
    role: result.staff_role,
  };
  writeStoredSession(session);
  return session;
}

export function currentSession(): StaffSession | null {
  return readStoredSession();
}

export async function touch(): Promise<boolean> {
  const session = currentSession();
  if (!session) return false;

  if (!session.token) return (await ownerSession(false)) !== null;

  const { data } = await appSchema().rpc('touch_session', { p_token: session.token });
  if (data !== true) {
    clearStoredSession();
    return false;
  }
  return true;
}

export async function lock(): Promise<void> {
  const session = currentSession();
  if (session?.token) {
    await appSchema().rpc('lock', { p_token: session.token });
  } else if (session) {
    await db().auth.signOut();
  }
  clearStoredSession();
}

export interface EmailIdentity {
  id: string;
  email: string;
}

export async function sendAdminOtp(email: string, shouldCreateUser: boolean): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error('Enter the administrator email address.');

  const { error } = await db().auth.signInWithOtp({
    email: normalized,
    options: { shouldCreateUser },
  });
  if (error) throw new Error(error.message);
}

export async function verifyAdminOtp(email: string, token: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!/^\d{6}$/.test(token)) throw new Error('Enter the 6-digit code from the email.');

  const { error } = await db().auth.verifyOtp({
    email: normalized,
    token,
    type: 'email',
  });
  if (error) throw new Error(error.message);
}

export async function emailIdentity(): Promise<EmailIdentity | null> {
  const { data, error } = await db().auth.getUser();
  if (error || !data.user || data.user.is_anonymous || !data.user.email) return null;
  return { id: data.user.id, email: data.user.email.toLowerCase() };
}

interface OwnerProfile {
  staff_id: string;
  staff_name: string;
  staff_role: 'admin';
}

export async function ownerSession(store = true): Promise<StaffSession | null> {
  const { data, error } = await appSchema().rpc('owner_profile');
  if (error || !data) return null;
  const owner = data as OwnerProfile;
  const session: StaffSession = {
    token: '',
    staffId: owner.staff_id,
    staffName: owner.staff_name,
    role: 'admin',
  };
  if (store) writeStoredSession(session);
  return session;
}

export async function signOutEmailIdentity(): Promise<void> {
  await db().auth.signOut();
  clearStoredSession();
}
