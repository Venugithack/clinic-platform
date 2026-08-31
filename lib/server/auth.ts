import 'server-only'

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Role, SessionView } from '@/lib/types'
import { db, isoNow } from './db'
import { verifyPassword } from './password'

const IDLE_MINUTES = 30
/**
 * What session tokens are hashed with before they are stored.
 *
 * The fallback exists so a fresh clone runs without ceremony, and it must never
 * survive to production — a known secret plus any read of the sessions table is
 * a way to recognise live tokens. Refusing to boot is deliberate: a warning in
 * a log nobody reads is how a development default ends up running a clinic.
 */
const sessionSecret = (() => {
  const configured = process.env.CLINIC_SESSION_SECRET?.trim()
  if (configured) return configured

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'CLINIC_SESSION_SECRET is not set. Generate 32 random bytes and put them ' +
        'in the deployment environment before serving a clinic.',
    )
  }

  return 'development-only-session-secret'
})()

function tokenHash(token: string) {
  return createHash('sha256').update(`${sessionSecret}:${token}`).digest('hex')
}

function expiryFrom(date = new Date()) {
  return new Date(date.getTime() + IDLE_MINUTES * 60_000).toISOString()
}

type StaffAuthRow = {
  id: string
  name: string
  username: string
  roles_json: string
  pin_hash: string
  pin_salt: string
  active: number
}

/**
 * How many wrong PINs a caller gets, and for how long they then wait.
 *
 * Charged to the caller, never to the account. Locking the account is the
 * obvious design and it is wrong on a tablet whose staff list is visible to
 * the waiting room: anyone could lock the doctor out of his own clinic by
 * tapping a wrong PIN five times. The person doing the tapping is the one who
 * should be made to stop.
 */
const PIN_ATTEMPT_LIMIT = 5
const PIN_ATTEMPT_WINDOW_MINUTES = 15

type SessionRow = {
  staff_id: string
  name: string
  username: string
  roles_json: string
  last_seen: string
  expires_at: string
  active: number
}

/**
 * The names on the lock screen.
 *
 * Deliberately unauthenticated and deliberately thin: a name and the roles it
 * works in, so somebody can point at themselves. No PIN material, no phone
 * number, no identifiers beyond the one needed to sign in.
 */
export async function lockScreenStaff() {
  const rows = await db
    .prepare('select id,name,roles_json from staff where active=1 order by name')
    .all()

  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    roles: JSON.parse(String(row.roles_json)) as Role[],
  }))
}

/** Wrong PINs from this caller inside the window. */
async function recentFailures(caller: string): Promise<number> {
  const since = new Date(Date.now() - PIN_ATTEMPT_WINDOW_MINUTES * 60_000).toISOString()
  const row = (await db
    .prepare('select count(*)::int as count from pin_attempts where caller=? and failed_at>?')
    .get(caller, since)) as { count: number } | undefined
  return Number(row?.count ?? 0)
}

export type SignInRefusal = { reason: 'locked'; minutes: number } | { reason: 'wrong' }

export async function createSession(
  staffId: string,
  pin: string,
  caller: string,
): Promise<{ token: string; session: SessionView } | SignInRefusal> {
  if ((await recentFailures(caller)) >= PIN_ATTEMPT_LIMIT) {
    return { reason: 'locked', minutes: PIN_ATTEMPT_WINDOW_MINUTES }
  }

  const staff = (await db.prepare(`select id,name,username,roles_json,pin_hash,pin_salt,active
    from staff where id=?`).get(staffId)) as StaffAuthRow | undefined

  if (!staff || !staff.active || !verifyPassword(pin, staff.pin_salt, staff.pin_hash)) {
    // Recorded against the caller even when the staff id is nonsense, so
    // guessing ids is rate-limited on exactly the same budget as guessing PINs.
    await db
      .prepare('insert into pin_attempts (id,staff_id,caller,failed_at) values (?,?,?,?)')
      .run(randomUUID(), staff?.id ?? null, caller, isoNow())
    return { reason: 'wrong' }
  }

  // A clean sign-in clears this caller's slate; the window is there to slow a
  // stranger down, not to punish a nurse who mistyped once an hour ago.
  await db.prepare('delete from pin_attempts where caller=?').run(caller)

  const rawToken = randomBytes(32).toString('base64url')
  const current = isoNow()
  await db.prepare(`insert into sessions (token_hash,staff_id,created_at,last_seen,expires_at)
    values (?,?,?,?,?)`).run(tokenHash(rawToken), staff.id, current, current, expiryFrom())
  await db.prepare('update staff set last_login=? where id=?').run(current, staff.id)

  return { token: rawToken, session: toView({ ...staff, staff_id: staff.id, last_seen: current, expires_at: expiryFrom() }) }
}

function toView(row: SessionRow | (StaffAuthRow & { staff_id: string; last_seen: string; expires_at: string })): SessionView {
  return {
    staffId: row.staff_id,
    name: row.name,
    username: row.username,
    roles: JSON.parse(row.roles_json) as Role[],
    lastSeen: row.last_seen,
  }
}

export async function getSession(
  rawToken: string | undefined,
  touch = true,
): Promise<SessionView | null> {
  if (!rawToken) return null
  const hashed = tokenHash(rawToken)
  const row = await db.prepare(`select s.staff_id, st.name, st.username, st.roles_json,
      s.last_seen, s.expires_at, st.active
    from sessions s join staff st on st.id=s.staff_id
    where s.token_hash=?`).get(hashed) as SessionRow | undefined
  if (!row || !row.active || row.expires_at <= isoNow()) {
    await db.prepare('delete from sessions where token_hash=?').run(hashed)
    return null
  }
  if (touch) {
    const current = isoNow()
    await db.prepare('update sessions set last_seen=?, expires_at=? where token_hash=?')
      .run(current, expiryFrom(), hashed)
    row.last_seen = current
  }
  return toView(row)
}

export async function destroySession(rawToken: string | undefined) {
  if (rawToken) await db.prepare('delete from sessions where token_hash=?').run(tokenHash(rawToken))
}

export async function forceLogout(staffId: string) {
  await db.prepare('delete from sessions where staff_id=?').run(staffId)
}

export async function doctorLoggedIn() {
  const row = await db.prepare(`select count(*) as count
    from sessions s join staff st on st.id=s.staff_id
    where st.active=1 and st.roles_json like '%"doctor"%' and s.expires_at>?`)
    .get(isoNow()) as { count: number }
  return row.count > 0
}

export function hasRole(session: SessionView, ...roles: Role[]) {
  return session.roles.some((role) => roles.includes(role))
}
