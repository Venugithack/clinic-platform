import { getSession } from './auth.ts'
import type { SessionView } from './types.ts'

/**
 * The bits every function repeats.
 *
 * ── WHY A BEARER TOKEN AND NOT A COOKIE ─────────────────────────────────────
 *
 * The page is static files on one origin and these functions are on another, so
 * a cookie set here would be a third-party cookie — blocked outright by Safari
 * and being retired by Chrome. A tablet would sign in, appear to work, and then
 * be signed out on the next request, which is the sort of fault that gets
 * blamed on the wifi for a fortnight.
 *
 * So the session token travels in the Authorization header. It is the same
 * token in the same `sessions` table with the same thirty-minute expiry; only
 * the envelope changed.
 */

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

export const preflight = () => new Response('ok', { headers: cors })

/**
 * An error, in a log line, with the patient left out of it.
 *
 * ── WHAT `console.error(error)` ACTUALLY PRINTS ────────────────────────────
 *
 * A Postgres constraint violation carries a `detail` field, and for a check or
 * a unique violation that field is the failing row:
 *
 *     ERROR:  new row for relation "probe" violates check constraint …
 *     DETAIL: Failing row contains (Mrs Patient, HIV serology, x).
 *
 * `postgres@3` puts the server's fields straight onto the thrown object, so
 * logging the object logs the row — a caption, a body site, a laboratory's
 * filename, which are routinely `SMITH_JOHN_HIV_2026.pdf`. Edge Function logs
 * are read in a dashboard, kept by the platform and pasted into support
 * threads, and this application's rule since Slice 3A is that the one string
 * designed to be repeated outside the database carries nothing about anybody.
 *
 * This found on 19 September 2026 while reviewing Slice 4, in three endpoints
 * — two of them older than it. What goes to the log now is the class of
 * failure and the constraint that produced it, which is what anybody
 * debugging actually needs; the row is in the database, where it belongs.
 *
 * The digit run is redacted for the same reason `redactProviderDetail` does
 * it: a constraint name is safe, and a telephone number that wandered into a
 * message is not.
 */
export function logFailure(where: string, error: unknown): void {
  if (typeof error !== 'object' || error === null) {
    console.error(`${where}: ${String(error)}`)
    return
  }
  const detail = error as { name?: unknown; code?: unknown; constraint_name?: unknown; message?: unknown }
  const parts = [
    String(detail.name ?? 'Error'),
    detail.code ? `code=${String(detail.code)}` : '',
    detail.constraint_name ? `constraint=${String(detail.constraint_name)}` : '',
    // The message names the relation and the constraint. `detail`, `hint`,
    // `where` and `query` are the ones that quote the row, and none of them
    // is here.
    String(detail.message ?? '').replace(/\d{6,}/g, '[number]').slice(0, 300),
  ].filter(Boolean)
  console.error(`${where}: ${parts.join(' ')}`)
}

/**
 * Who is calling, or null.
 *
 * `touch` is false for the snapshot poll: the tablets poll every fifteen
 * seconds whether anybody is standing there or not, and refreshing the session
 * on each poll means a tablet left on the counter never reaches its idle lock.
 * Doing something goes through /command, which does refresh it.
 */
export async function sessionFrom(
  request: Request,
  touch = true,
): Promise<SessionView | null> {
  const header = request.headers.get('authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!token) return null
  return getSession(token, touch)
}
