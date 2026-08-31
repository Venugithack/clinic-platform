import postgres from 'npm:postgres@3.4.5'
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'

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
 */

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, {
  prepare: false,
  max: 2,
  idle_timeout: 20,
  connection: { search_path: 'jmc' },
})

const SESSION_SECRET = Deno.env.get('CLINIC_SESSION_SECRET')
const IDLE_MINUTES = 30
const PIN_ATTEMPT_LIMIT = 5
const PIN_ATTEMPT_WINDOW_MINUTES = 15

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

const now = () => new Date().toISOString()

function derive(secret: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 64, (error, key) => (error ? reject(error) : resolve(key)))
  })
}

function tokenHash(token: string): string {
  return createHash('sha256').update(`${SESSION_SECRET}:${token}`).digest('hex')
}

/** Who is at the tablet — used only to rate-limit wrong PINs. */
function callerKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]!.trim()
  return 'unknown-caller'
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })

  if (!SESSION_SECRET) {
    console.error('CLINIC_SESSION_SECRET is not set on this function')
    return json({ ok: false, message: 'The clinic server is not configured.' }, 500)
  }

  try {
    const { staffId = '', pin = '' } = (await request.json()) as {
      staffId?: string
      pin?: string
    }
    const caller = callerKey(request)

    // Wrong PINs are charged to the caller, never to the account. Locking the
    // account would let anyone who can see the staff list lock the doctor out
    // of his own clinic by tapping five times.
    const since = new Date(Date.now() - PIN_ATTEMPT_WINDOW_MINUTES * 60_000).toISOString()
    const [{ count }] = await sql`
      select count(*)::int as count from pin_attempts
      where caller = ${caller} and failed_at > ${since}`

    if (Number(count) >= PIN_ATTEMPT_LIMIT) {
      return json(
        {
          ok: false,
          message: `Too many wrong PINs from this device. Try again in ${PIN_ATTEMPT_WINDOW_MINUTES} minutes.`,
        },
        401,
      )
    }

    const [staff] = await sql`
      select id, name, username, roles_json, pin_hash, pin_salt, active
      from staff where id = ${staffId}`

    const good =
      staff &&
      staff.active &&
      timingSafeEqual(
        await derive(pin, String(staff.pin_salt)),
        Buffer.from(String(staff.pin_hash), 'hex'),
      )

    if (!good) {
      await sql`insert into pin_attempts (id, staff_id, caller, failed_at)
                values (${crypto.randomUUID()}, ${staff?.id ?? null}, ${caller}, ${now()})`
      return json({ ok: false, message: 'That PIN is not right.' }, 401)
    }

    await sql`delete from pin_attempts where caller = ${caller}`

    const token = randomBytes(32).toString('base64url')
    const expires = new Date(Date.now() + IDLE_MINUTES * 60_000).toISOString()
    await sql`insert into sessions (token_hash, staff_id, created_at, last_seen, expires_at)
              values (${tokenHash(token)}, ${staff.id}, ${now()}, ${now()}, ${expires})`
    await sql`update staff set last_login = ${now()} where id = ${staff.id}`

    return json({
      ok: true,
      message: 'Signed in.',
      token,
      session: {
        staffId: String(staff.id),
        name: String(staff.name),
        username: String(staff.username),
        roles: JSON.parse(String(staff.roles_json)),
        lastSeen: now(),
      },
    })
  } catch (error) {
    console.error('sign-in failed:', error)
    return json({ ok: false, message: 'The clinic server is not reachable.' }, 503)
  }
})
