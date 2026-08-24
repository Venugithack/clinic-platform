/**
 * The one seam. PLAN.md §5.3 rule 1.
 *
 * This is the ONLY module in the codebase permitted to import from
 * `@supabase/*`. Everything else goes through here or through
 * `lib/transitions`. A component that reaches for the Supabase client directly
 * runs a query with no RLS context, no audit trail and no transaction — and by
 * the time anyone notices, it is in production.
 *
 * The rule is enforced by ESLint (see eslint.config.mjs), not by memory.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readStoredSession, STAFF_SESSION_HEADER } from './session';

let client: SupabaseClient | null = null;

/**
 * These must be referenced by their literal names.
 *
 * Next inlines `process.env.NEXT_PUBLIC_*` at build time by substituting the
 * exact expression; a dynamic lookup like `process.env[name]` is left alone and
 * evaluates against an empty object in the browser. The failure is silent at
 * build time and total at runtime, so the names are spelled out here once.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * Every request carries the PIN session token.
 *
 * The device's auth session says which tablet is asking. This header says which
 * person is standing at it, and app.pre_request() lifts it into the
 * `app.staff_session` GUC where app.current_staff_id() reads it. Without it
 * every audit row would name a tablet, which the Schedule H1 register cannot
 * accept (TABLET.md §5, PLAN.md §15.2).
 */
/**
 * Every request is also bounded in time.
 *
 * A request that neither succeeds nor fails is the worst of the three
 * outcomes: the screen sits there with no data and no explanation, and the
 * staff decide the software is broken. That is the failure PLAN.md §5.2 rules
 * out for the consult room, and it applies just as much to a lock screen with
 * nobody on it. The clinic runs on a free tier with no SLA and a 4G fallback
 * (HOSTING.md §9), so this state is not hypothetical.
 *
 * 12 seconds is long enough for a bad mobile link and short enough that nobody
 * concludes the tablet has hung.
 */
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * How the tablet becomes `authenticated`.
 *
 * Every grant in the schema targets the `authenticated` role, and every RLS
 * policy is written `to authenticated`. Locally this was papered over by
 * handing the client a hand-minted JWT that already carried the role and
 * calling it "the anon key" — which worked, and hid the fact that on a hosted
 * project the real publishable key carries `anon` and reaches nothing. The
 * first request on the lock screen came back `permission denied for table
 * staff`, or worse, an empty staff list with no error at all.
 *
 * So the device signs in anonymously. The JWT that comes back carries
 * `authenticated`, exactly like the local hack did, but it is minted by the
 * project rather than by a shell command in a README — one code path, the same
 * on the Docker stack and in Mumbai.
 *
 * What that exposes to somebody who simply loads the URL is worth stating,
 * because "anyone can sign in" reads alarming and the detail is what makes it
 * fine. An anonymous session with no PIN behind it reaches exactly three
 * things: `lock_screen_staff` (first names, so the lock screen can offer them),
 * `clinic_is_open` (already public on /now by design, PLAN.md §13.3), and
 * `app.unlock` — which fails on an unknown device token before it ever looks at
 * a PIN. Everything else is gated on `app.current_staff_id() is not null`,
 * which needs a PIN unlock against a registered tablet. The device token is the
 * secret; it always was (TABLET.md §5).
 *
 * This is the session, not the identity. The identity is the PIN, and it
 * travels in the header below.
 */
let deviceSession: Promise<void> | null = null;

/**
 * Supabase Auth's own endpoints, which must NOT wait for the session they are
 * in the middle of minting.
 *
 * Without this the wrapper deadlocks against itself: signInAnonymously() issues
 * a fetch, the fetch awaits ensureDeviceSession(), and that is the very promise
 * the sign-in has not resolved yet. The same applies to the background token
 * refresh that autoRefreshToken schedules.
 */
function isAuthRequest(input: RequestInfo | URL): boolean {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return url.includes('/auth/v1/');
}

function ensureDeviceSession(): Promise<void> {
  deviceSession ??= (async () => {
    const auth = db().auth;

    // Local read, no network: persistSession means a tablet that signed in
    // last week still holds a refresh token, and re-signing in would mint a
    // second anonymous user for no reason.
    const { data } = await auth.getSession();
    if (data.session) return;

    const { error } = await auth.signInAnonymously();
    if (error) {
      // Forget the failure. A tablet that was offline when it first woke up
      // must be able to try again on the next request rather than holding a
      // rejected promise for the rest of the day.
      deviceSession = null;
      throw new Error(`This tablet could not reach the clinic database. ${error.message}`);
    }
  })();

  return deviceSession;
}

async function fetchWithStaffSession(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  if (!isAuthRequest(input)) await ensureDeviceSession();

  // Started after the sign-in, deliberately: the 12 seconds are this request's
  // budget, not the budget for waking the tablet up.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;

  const headers = new Headers(init.headers);
  const session = readStoredSession();
  if (session) headers.set(STAFF_SESSION_HEADER, session.token);

  return fetch(input, { ...init, headers, signal });
}

export function db(): SupabaseClient {
  if (client) return client;

  client = createClient(
    required('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL),
    required('NEXT_PUBLIC_SUPABASE_ANON_KEY', SUPABASE_ANON_KEY),
    {
      auth: {
        // The device holds a long-lived session; the PIN holds the identity
        // (TABLET.md §5). Persisting is the point — staff never type a password.
        persistSession: true,
        autoRefreshToken: true,
      },
      global: { fetch: fetchWithStaffSession },
    },
  );

  return client;
}

/**
 * The transitions live in the `app` schema, not `public`.
 *
 * PostgREST resolves `rpc('dispense')` against the exposed schema, which
 * defaults to `public` — so a call has to name `app` explicitly or it silently
 * looks in the wrong place. Keeping the boundary visible in the client is worth
 * more than the alternative, which is a second copy of every transition
 * signature sitting in `public` purely to be found.
 *
 * `app` is listed in supabase/config.toml under [api] schemas; on a hosted
 * project it goes in the same setting.
 */
export function appSchema() {
  return db().schema('app');
}

/** Test seam: drop the memoised client so a test can install its own. */
export function resetDb(): void {
  client = null;
  // The device session is memoised against the old client and would otherwise
  // resolve instantly for the new one, skipping the sign-in a test is asserting.
  deviceSession = null;
}

export type { SupabaseClient };
export * from './session';
