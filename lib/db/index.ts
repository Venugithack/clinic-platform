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

function fetchWithStaffSession(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
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
}

export type { SupabaseClient };
export * from './session';
