/**
 * How this application authenticates something that is not a person.
 *
 * ── THE CONTRACT GAP, STATED BEFORE IT IS FILLED ───────────────────────────
 *
 * Until this file, every one of the thirteen Edge Functions fell into exactly
 * two categories. Eleven authenticate a PERSON: a bearer token from the
 * `sessions` table, resolved by `sessionFrom`, belonging to a member of staff
 * who signed in with a PIN. Two are deliberately unauthenticated — `staff`,
 * which lists the names on the lock screen, and `bootstrap`, which refuses the
 * instant any staff row exists.
 *
 * **There was no third category, and the dispatch worker is one.** It is
 * called by a scheduler at 09:00 whether or not anybody is in the building. No
 * session exists, none should be minted for it, and a staff session must not
 * be able to drive it: a nurse's tablet triggering the clinic's outbound
 * messaging is a privilege nobody granted and item 79's failure ownership
 * would be meaningless if anyone could set the queue moving.
 *
 * So the gap is real and this is the smallest thing that closes it: one shared
 * secret, in one environment variable, compared in constant time, with no
 * fallback and no development default. It is deliberately NOT a new table, a
 * new role, a service-account staff row or a JWT — each of those is a larger
 * contract than the problem, and a staff row that cannot sign in but can act
 * is the kind of thing that ends up with a PIN.
 *
 * ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 *
 * It is not authorization for anything else. It admits a caller to one
 * endpoint that runs one cycle of already-authorized work; it grants no role,
 * reads no patient and can approve nothing. A holder of this token can make
 * the clinic do what the clinic had already decided to do, sooner.
 *
 * ── THE SECRET ─────────────────────────────────────────────────────────────
 *
 * `CLINIC_WORKER_TOKEN`. No value for it is created, committed or configured
 * by this slice — the variable is documented in `docs/README.md` §4 and in the
 * provisioning steps in `docs/operations/ROLLOUT.md`, and until somebody sets
 * it the worker endpoint refuses every request including a correct one. That
 * is the right default: an unset secret must never mean "no check", which is
 * the failure mode `auth.ts` was already bitten by once, when its guard was
 * `NODE_ENV === 'production'` in a runtime that never sets it.
 */
import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'

export type InternalCaller = 'scheduler'

/**
 * Whether this request carries the clinic's worker secret.
 *
 * Returns false when the secret is not configured, when the header is absent,
 * and when it does not match — all three indistinguishably to the caller,
 * because telling an unauthenticated stranger which of the three it was is
 * telling them how to make progress.
 */
export function isInternalCaller(request: Request): boolean {
  const expected = (Deno.env.get('CLINIC_WORKER_TOKEN') ?? '').trim()
  if (expected === '') return false

  const header = request.headers.get('authorization') ?? ''
  const supplied = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : ''
  if (supplied === '') return false

  /*
   * Constant time, and the length check first because `timingSafeEqual`
   * throws on unequal lengths rather than returning false. A length is leaked
   * either way — there is no hiding it from a caller who can send any string —
   * and what matters is that a matching PREFIX is not, which is what a plain
   * `===` on a secret gives away.
   */
  const a = new TextEncoder().encode(expected)
  const b = new TextEncoder().encode(supplied)
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}
