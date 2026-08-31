/**
 * Talking to the clinic server.
 *
 * The application used to be one Next server: the page and the API came from
 * the same origin, the session was an httpOnly cookie, and the browser attached
 * it without being asked. It is two things now — static files on one host, Edge
 * Functions next to the database on another — because a server that runs code
 * on every request is the one thing free hosting will not do.
 *
 * ── WHY THE TOKEN IS IN localStorage AND NOT A COOKIE ───────────────────────
 *
 * A cookie set by the functions would be a third-party cookie to this page, and
 * Safari blocks those outright while Chrome is finishing them off. A tablet
 * would sign in, appear to work, and be signed out on its next request — a
 * fault that gets blamed on the wifi for a fortnight.
 *
 * The trade is real and worth stating: an httpOnly cookie cannot be read by
 * JavaScript and this can, so anything that manages to run script on this page
 * can take the token. What it buys is a session that works on every browser a
 * clinic actually owns. The token is still short-lived, still revocable from
 * the sessions table, and still dies on sign-out.
 */

const BASE = process.env.NEXT_PUBLIC_FUNCTIONS_URL ?? ''

const TOKEN_KEY = 'jayamurugan_token'

export function readToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) ?? null
  } catch {
    // Private browsing, or storage disabled by policy. Sign-in still works for
    // as long as the tab is open; it just will not survive a reload.
    return null
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token === null) globalThis.localStorage?.removeItem(TOKEN_KEY)
    else globalThis.localStorage?.setItem(TOKEN_KEY, token)
  } catch {
    // As above — not fatal.
  }
}

/**
 * One call to the clinic server, with the session attached.
 *
 * `path` is the function name and anything after it, e.g. `snapshot?since=4`.
 */
export async function callApi(path: string, init: RequestInit = {}): Promise<Response> {
  const token = readToken()

  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)

  // FormData sets its own multipart boundary; setting Content-Type by hand
  // breaks the upload in a way that looks like a corrupt file.
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  return fetch(`${BASE}/${path}`, { ...init, headers, cache: 'no-store' })
}

/** The URL for a link or a download, with no session attached. */
export function apiUrl(path: string): string {
  return `${BASE}/${path}`
}
