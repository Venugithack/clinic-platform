/**
 * Where the staff PIN session lives on the device, and how it reaches Postgres.
 *
 * This sits in lib/db rather than lib/auth because the client's fetch wrapper
 * needs it and lib/auth already depends on lib/db — putting it the other way
 * round would be a cycle. lib/auth imports the key from here.
 */
export const SESSION_STORAGE_KEY = 'clinic.staffSession';

/** The header app.pre_request() reads to learn who is standing at the tablet. */
export const STAFF_SESSION_HEADER = 'x-staff-session';

export interface StoredSession {
  token: string;
  staffId: string;
  staffName: string;
  role: 'doctor' | 'counter' | 'admin';
}

export function readStoredSession(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export function writeStoredSession(session: StoredSession): void {
  window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearStoredSession(): void {
  window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
}
