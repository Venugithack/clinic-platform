/**
 * The clinic's backend, loaded against the staging database.
 *
 * ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
 *
 * `supabase/functions/_shared/db.ts` opens its connection at module scope:
 *
 *     const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, ...)
 *
 * so by the time anything can be imported, the connection target is already
 * decided. A test that sets the variable after importing has already lost. This
 * module sets it first, checks it, and only then reaches for the backend — and
 * because every other test file imports the backend THROUGH here, there is one
 * place where that ordering can be got wrong instead of one per file.
 *
 * ── AND WHY IT IS .mjs ─────────────────────────────────────────────────────
 *
 * tsconfig.json excludes `supabase`, but exclusion only decides which files tsc
 * opens on its own; a `.ts` file that imports one drags it in anyway, and then
 * `npm run typecheck` dies on `npm:postgres@3.4.5`, which tsc has no resolver
 * for. Keeping the bridge in JavaScript keeps the backend out of tsc's graph
 * and `npm run typecheck` meaning what it has always meant.
 *
 * ── THE SAFETY PART ────────────────────────────────────────────────────────
 *
 * docs/README.md §3: this repository's development environment points at the
 * clinic's live database, and there is no guard against it in the code. There
 * is one here. Nothing in this file will connect to anything that is not a
 * loopback scratch database, and it refuses before importing rather than after.
 */
import { requireStagingUrl } from '../../scripts/staging/guard.mjs'

const url = requireStagingUrl(process.env.STAGING_DB_URL, { what: 'The characterization suite' })

// Checked as well as set. If a shell already exported SUPABASE_DB_URL — and on
// a machine where somebody has been poking at the deployed functions, it may
// well be the clinic's — silently overwriting it would work, and silently
// leaving it would be a disaster. Refuse instead.
const inherited = process.env.SUPABASE_DB_URL
if (inherited && inherited !== url) {
  requireStagingUrl(inherited, { what: 'The inherited SUPABASE_DB_URL' })
}
process.env.SUPABASE_DB_URL = url

// auth.ts refuses to hash a session token without this, deliberately and with
// no development fallback. A fixed value is right for a scratch database: the
// tests need session tokens to be reproducible across a run, and the database
// they are stored in is thrown away.
process.env.CLINIC_SESSION_SECRET ??= 'staging-only-session-secret-not-a-real-one'

export const STAGING_DB_URL = url

export const db = await import('../../supabase/functions/_shared/db.ts')
export const auth = await import('../../supabase/functions/_shared/auth.ts')
export const password = await import('../../supabase/functions/_shared/password.ts')
export const commands = await import('../../supabase/functions/_shared/commands.ts')
export const snapshot = await import('../../supabase/functions/_shared/snapshot.ts')

/** Shorthand: the two things every characterization test reaches for. */
export const runCommand = commands.runCommand
export const createSession = auth.createSession
