import { lockScreenStaff } from '../_shared/auth.ts'
import { json, preflight } from '../_shared/http.ts'

/**
 * The names on the lock screen — the first function ported, and the one that
 * proves the shape.
 *
 * ── WHY THIS IS HERE AND NOT ON CLOUDFLARE ──────────────────────────────────
 *
 * The same route ran as a Cloudflare Worker and failed roughly two sign-ins in
 * five: Workers allow about ten milliseconds of CPU per request and scrypt
 * needs a hundred, so the runtime cancelled the request as hung. Supabase Edge
 * Functions allow two seconds. The PIN hash is no longer near the limit.
 *
 * Three other things fall away by being here rather than there. The database is
 * local to this function, so there is no Hyperdrive gateway in between. A
 * direct connection carries `search_path` in its startup parameters, which
 * Hyperdrive dropped — so the schema does not have to be forced onto the
 * postgres role, and every unqualified name resolves inside `jmc` rather than
 * in `public`, where the previous application's 74 tables live with eight of
 * these same names. And SUPABASE_DB_URL is injected by the platform, so there
 * is no connection string to keep anywhere.
 *
 * ── THE QUERY IS auth.ts's, NOT THIS FILE'S ─────────────────────────────────
 *
 * This used to open its own connection pool and write the select out again.
 * That is one more place for the column list to drift, and the column list is
 * the security property here: this endpoint is deliberately unauthenticated, so
 * anything it selects is public. `lockScreenStaff` selects a name and its roles
 * and nothing else, and it is the only copy of that decision.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight()

  try {
    return json({ ok: true, staff: await lockScreenStaff() })
  } catch (error) {
    console.error('lock screen staff query failed:', error)
    return json({ ok: false, message: 'The clinic database is not reachable.' }, 503)
  }
})
