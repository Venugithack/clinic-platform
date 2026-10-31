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
let volatileToken: string | null = null

export function readToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(TOKEN_KEY) ?? volatileToken
  } catch {
    // Private browsing, or storage disabled by policy. Sign-in still works for
    // as long as the tab is open; it just will not survive a reload.
    return volatileToken
  }
}

export function writeToken(token: string | null): void {
  volatileToken = token
  try {
    if (token === null) globalThis.localStorage?.removeItem(TOKEN_KEY)
    else globalThis.localStorage?.setItem(TOKEN_KEY, token)
  } catch {
    // As above — not fatal.
  }
}

/**
 * How long a request may stay open before the tablet stops waiting.
 *
 * Generous on purpose. The clinic's connection is not fast and a hand-over
 * that takes eleven seconds is a hand-over, not a fault; the four-second
 * "still saving" message exists so that slowness is visible without anything
 * being cancelled. What this prevents is the other case — a socket that will
 * never answer, holding a control disabled until somebody reloads the tablet
 * in the middle of a queue.
 *
 * Reads are shorter because nothing is lost by giving up on one: the next poll
 * is fifteen seconds away.
 */
const WRITE_TIMEOUT_MS = 45_000
const READ_TIMEOUT_MS = 20_000

/**
 * A request that did not come back with an answer.
 *
 * Thrown by `callApi` for a network failure or a timeout. The distinction that
 * matters is in the name: the browser cannot tell a request that never left
 * the tablet from one that reached Mumbai, committed a dispense, and lost the
 * reply on the way home. Both arrive here as the same `TypeError`.
 *
 * So the honest thing — and the rule the whole application now follows — is
 * that a failed *read* is a connection problem and a failed *write* is an
 * unknown outcome. Nothing may report "nothing happened" about a command it
 * cannot prove did not happen.
 */
export class NoAnswer extends Error {
  /** True when this was a mutating request, so the outcome is genuinely unknown. */
  readonly mutating: boolean

  constructor(mutating: boolean) {
    super(mutating ? 'The clinic did not answer.' : 'The clinic server is not reachable.')
    this.name = 'NoAnswer'
    this.mutating = mutating
  }
}

/**
 * One call to the clinic server, with the session attached.
 *
 * `path` is the function name and anything after it, e.g. `snapshot?since=4`.
 * Throws `NoAnswer` rather than the browser's `TypeError`, so every caller is
 * handed the one fact it needs to decide what to tell the user.
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

  const mutating = (init.method ?? 'GET').toUpperCase() !== 'GET'
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    mutating ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS,
  )

  try {
    return await fetch(`${BASE}/${path}`, {
      ...init,
      headers,
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch {
    throw new NoAnswer(mutating)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The body of a response, or `NoAnswer` if there is not one.
 *
 * A 500 with an HTML error page in it is the same problem as a dropped socket:
 * the clinic was reached, something went wrong inside it, and whether the
 * transaction committed before it did is not knowable from here. Both end up
 * as an unknown outcome for a write.
 */
export async function readJson<T>(response: Response, mutating: boolean): Promise<T> {
  try {
    return (await response.json()) as T
  } catch {
    throw new NoAnswer(mutating)
  }
}
