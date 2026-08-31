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
