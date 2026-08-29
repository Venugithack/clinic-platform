/**
 * The clinic screen marker.
 *
 * One claim, stored in one browser: *this screen stands in the clinic*. It is
 * NOT device trust returning — it gates nothing, it is required by nothing, and
 * a browser without one signs in and works exactly as before. The single thing
 * it unlocks is `app.set_presence` accepting "in clinic", which is refused from
 * an unmarked browser so that the doctor's laptop at home cannot tell a waiting
 * room he is present (PLAN.md §13.2, and the rule written into
 * 20260816250100_presence.sql).
 *
 * `localStorage`, not `sessionStorage`, and that is the whole point of the
 * feature: the staff session is deliberately per-tab and short-lived, while
 * "this screen is the one in the consulting room" is a fact about the hardware
 * that has to outlive every sign-in on it.
 */
export const CLINIC_SCREEN_STORAGE_KEY = 'clinic.screenToken';

/**
 * The id travels with the token so that unmarking can revoke the row rather
 * than merely forgetting it. A token nobody holds is already inert, but leaving
 * the row behind means the administrator's list of clinic screens slowly fills
 * with screens that no longer exist, and a list nobody can trust is one nobody
 * reads.
 */
export interface ClinicScreen {
  id: string;
  label: string;
  token: string;
}

export function readClinicScreen(): ClinicScreen | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CLINIC_SCREEN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClinicScreen>;
    if (!parsed.id || !parsed.token) return null;
    return { id: parsed.id, label: parsed.label ?? 'This screen', token: parsed.token };
  } catch {
    // A browser with site data blocked, or a half-written value, is an unmarked
    // screen — not a broken one.
    return null;
  }
}

export function readClinicScreenToken(): string | null {
  return readClinicScreen()?.token ?? null;
}

export function writeClinicScreen(screen: ClinicScreen): void {
  try {
    window.localStorage.setItem(CLINIC_SCREEN_STORAGE_KEY, JSON.stringify(screen));
  } catch {
    // Nothing to do, and nothing to break: presence stays refused here.
  }
}

export function clearClinicScreenToken(): void {
  try {
    window.localStorage.removeItem(CLINIC_SCREEN_STORAGE_KEY);
  } catch {
    /* already effectively unmarked */
  }
}

export function isClinicScreen(): boolean {
  return readClinicScreen() !== null;
}
