import { createSession } from '../_shared/auth.ts'
import { currentRevision } from '../_shared/db.ts'
import { json, preflight } from '../_shared/http.ts'
import { readSnapshot } from '../_shared/snapshot.ts'

/**
 * Signing in with a PIN — the function this whole move was for.
 *
 * On Cloudflare this failed about two attempts in five, and got worse the more
 * people used it at once: scrypt spends around a hundred milliseconds of CPU
 * and a Worker is allowed about ten, so the runtime cancelled the request as
 * hung. Here the budget is two seconds. Nothing about the hashing changed —
 * same algorithm, same cost parameters, same stored hashes — only where it runs.
 *
 * ── THE TOKEN COMES BACK IN THE BODY, NOT A COOKIE ──────────────────────────
 *
 * The page is served from another origin, and a cookie set by this function
 * would be a third-party cookie — which Safari already blocks and Chrome is
 * finishing off. So the session token is returned to the caller, which keeps it
 * and sends it as `Authorization: Bearer`. Same token, same sessions table,
 * same thirty-minute expiry; only the envelope is different.
 *
 * ── THE SIGN-IN ITSELF LIVES IN _shared/auth.ts ─────────────────────────────
 *
 * It was written out a second time here — its own connection pool, its own
 * scrypt, its own token hash, its own wrong-PIN counter — and the two copies
 * drifted, as two copies do. This one had dropped the length check in front of
 * `timingSafeEqual`, so a stored hash that was not exactly 64 bytes threw a
 * RangeError instead of comparing unequal; the catch at the bottom of this file
 * then answered "the clinic server is not reachable" and recorded no failed
 * attempt. A wrong PIN read as a broken server, and whoever was guessing got
 * unlimited free guesses. The pool was the other half of the cost: two pools in
 * one function, so the busiest function in the clinic held double the
 * connections of any other.
 *
 * The "is CLINIC_SESSION_SECRET set" check that used to open this handler went
 * with the rest, and is not repeated here — a second copy of a rule is how the
 * first one drifts, which is the entire subject of the paragraph above. auth.ts
 * refuses to hash a token without the secret, so a deployment missing it throws
 * on the first correct PIN: the message naming the variable reaches the
 * function log through the catch below, and the tablet is told the server is
 * not reachable, which for the purpose of signing in is true.
 */

/** Who is at the tablet — used only to rate-limit wrong PINs. */
function callerKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return 'unknown-caller'
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight()

  try {
    const { staffId = '', pin = '' } = (await request.json()) as {
      staffId?: string
      pin?: string
    }

    // Wrong PINs are charged to the caller, never to the account — locking the
    // account would let anyone who can see the staff list lock the doctor out
    // of his own clinic by tapping five times. auth.ts does the charging; this
    // only has to say who to charge and what to call the two refusals.
    const result = await createSession(staffId, pin, callerKey(request))

    if ('reason' in result) {
      return json(
        {
          ok: false,
          message:
            result.reason === 'locked'
              ? `Too many wrong PINs from this device. Try again in ${result.minutes} minutes.`
              : 'That PIN is not right.',
        },
        401,
      )
    }

    // Signing in used to show the lock screen, wait, and only then go and ask
    // what the clinic looked like — two full trips before anybody saw a queue.
    // The session is already in hand here, so the first screen comes back with
    // the PIN.
    return json({
      ok: true,
      message: 'Signed in.',
      token: result.token,
      session: result.session,
      revision: await currentRevision(),
      snapshot: await readSnapshot(result.session),
    })
  } catch (error) {
    console.error('sign-in failed:', error)
    return json({ ok: false, message: 'The clinic server is not reachable.' }, 503)
  }
})
