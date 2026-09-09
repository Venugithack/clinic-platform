import { randomUUID } from 'node:crypto'
import { audit, db, isoNow, transaction } from '../_shared/db.ts'
import { hashPassword } from '../_shared/password.ts'
import { json, preflight } from '../_shared/http.ts'

/**
 * The clinic's first administrator, and only ever the first.
 *
 * A database built from the migrations in this repository comes up with an
 * empty `staff` table and no way on earth to fill it. `create_staff` needs an
 * admin session; a session needs a staff row to sign in as. So a clinic that
 * follows this repository's own instructions arrives at the lock screen, is
 * told there is nobody to be, and has no route forward that does not involve
 * somebody with a psql prompt and a working scrypt implementation. The retired
 * Next application had a first-run bootstrap and it was deleted along with the
 * rest of it; the lock screen went on telling people to read an administrator
 * PIN out of a server log that no longer prints one.
 *
 * ── WHY AN UNAUTHENTICATED ENDPOINT IS SAFE HERE ────────────────────────────
 *
 * It cannot ask who is calling: there is nobody to be, which is the entire
 * problem. What makes it safe to leave on the open internet is that it refuses
 * the instant `staff` holds anything at all. Against a clinic that is running,
 * this is dead code — every call it will ever receive, from anyone, gets the
 * same refusal and writes nothing. There is exactly one moment in a database's
 * life when it does something, and it is the moment before the clinic has a
 * door on it.
 *
 * ── WHY `where not exists` IS NOT ATOMIC ON ITS OWN ─────────────────────────
 *
 * `insert ... select ... where not exists (select 1 from staff)` reads as
 * atomic and is not. Postgres runs READ COMMITTED here, so two transactions
 * that begin together each look at a table in which neither can see the other's
 * uncommitted row, each find it empty, and each insert. Both commit. The clinic
 * opens with two administrators, one of them belonging to whoever else happened
 * to be calling that minute, and nothing anywhere says so — which on this
 * particular endpoint means a stranger holding admin on a clinic that believes
 * it was the only one there. The transaction-scoped advisory lock below is what
 * actually serialises it: the second caller waits for the first to commit, then
 * reads a table with a row in it and is refused. The count afterwards is the
 * belt to that pair of braces — if this ever finds itself about to commit
 * anything other than exactly one row, it commits nothing.
 *
 * ── WHY A REFUSAL ROLLS BACK RATHER THAN RETURNING QUIETLY ──────────────────
 *
 * `transaction()` bumps `clinic_revision` on the way out, which is what tells
 * four tablets that something changed. A refusal that returned normally would
 * bump it too, so anybody who wanted to could sit on this endpoint and make
 * every tablet in the clinic throw away its snapshot and refetch the lot every
 * fifteen seconds, having written nothing. Throwing rolls the counter back with
 * everything else.
 */

/** Something the caller should read, as against a fault they should not. */
class Refusal extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/**
 * Six digits, and not a birthday-shaped run of one.
 *
 * A deliberate copy of `requirePin` in _shared/commands.ts, down to the
 * wording, because that function is not exported and this one may not go
 * changing it. Two rules that must agree are better copied with a note than
 * left to drift silently: a PIN this accepts and `set_staff_pin` later refuses
 * would strand an administrator on their own account.
 */
function checkedPin(raw: unknown): string {
  const pin = String(raw ?? '').trim()
  if (!/^\d{6}$/.test(pin)) throw new Refusal('A PIN is exactly six digits.')
  if (/^(\d)\1{5}$/.test(pin)) {
    throw new Refusal('That PIN is the same digit six times. Choose another.')
  }
  if ('012345678901234567890'.includes(pin) || '098765432109876543210'.includes(pin)) {
    throw new Refusal('That PIN is six digits in a row. Choose another.')
  }
  return pin
}

function required(raw: unknown, whatItIs: string): string {
  const text = String(raw ?? '').trim()
  if (!text) throw new Refusal(`${whatItIs} is required.`)
  return text
}

/**
 * The key both callers agree on. Arbitrary, and its only property that matters
 * is that this function always picks the same one — an advisory lock only holds
 * anybody back if everybody asks for the same number.
 */
const BOOTSTRAP_LOCK = 748201

/**
 * The refusal, and the only thing the live clinic will ever say here.
 *
 * It names the switched-off case because the lock screen offers this from an
 * empty staff list, and that list is only the ACTIVE staff. A clinic whose
 * every account has been disabled shows nobody, offers to create an
 * administrator, and is then refused — and "already has staff" on a screen that
 * just said there were none is the kind of contradiction somebody stares at for
 * an hour. It gives an attacker nothing: being refused already tells them the
 * clinic is occupied.
 */
const ALREADY_OPEN =
  'This clinic already has a staff record, so there is nothing to set up. If nobody ' +
  'can sign in, an account has been switched off rather than never created.'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return preflight()
  if (request.method !== 'POST') {
    return json({ ok: false, message: 'Send the first administrator as a POST.' }, 405)
  }

  try {
    const body = (await request.json().catch(() => {
      throw new Refusal('The request could not be read.')
    })) as { name?: unknown; username?: unknown; pin?: unknown }

    const name = required(body.name, 'A name')
    const username = required(body.username, 'A username').toLowerCase()
    const pin = checkedPin(body.pin)

    // A look at the table before spending anything on the caller. This decides
    // nothing — the check that counts is inside the transaction, under the lock
    // — but on a clinic that has been open a year, every call this endpoint
    // will ever receive is a stranger's, and without this each one buys a
    // hundred milliseconds of scrypt for the price of one small request.
    const occupied = await db.prepare('select 1 as found from staff limit 1').get()
    if (occupied) throw new Refusal(ALREADY_OPEN, 409)

    const id = randomUUID()
    // Hashed before the transaction opens, not inside it. scrypt spends a
    // hundred milliseconds of real CPU and a transaction holds one of the two
    // connections this instance is allowed; there is no reason for the database
    // to sit and wait through it.
    const secret = await hashPassword(pin)

    await transaction(async () => {
      await db.prepare(`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`).get()

      // Every parameter is cast, because in an `insert ... select` Postgres
      // resolves the parameter types inside the select rather than from the
      // target columns. Left to inference this fails with "could not determine
      // data type of parameter $1" — on the one endpoint that has to work on a
      // day when nothing else in the clinic does yet.
      const written = await db
        .prepare(
          `insert into staff
            (id,name,username,phone,roles_json,pin_hash,pin_salt,active,created_at)
           select ?::text,?::text,?::text,?::text,?::text,?::text,?::text,1,?::text
            where not exists (select 1 from staff)`,
        )
        .run(
          id,
          name,
          username,
          // No phone is asked for. This screen is shown to somebody who cannot
          // get into their own clinic, and every field on it is a field between
          // them and the door; the column takes '' and they can correct their
          // own record from the staff workspace a minute later.
          '',
          JSON.stringify(['admin']),
          secret.hash,
          secret.salt,
          isoNow(),
        )

      if (Number(written.changes) !== 1) throw new Refusal(ALREADY_OPEN, 409)

      const count = (await db.prepare('select count(*)::int as total from staff').get()) as
        | { total: number }
        | undefined

      if (Number(count?.total ?? 0) !== 1) throw new Refusal(ALREADY_OPEN, 409)

      // The new administrator is the actor for their own creation, because
      // there is nobody else it could be, and `audit_events.actor_id` has a
      // foreign key into `staff` that only the insert above can satisfy — in
      // this same transaction, a moment ago.
      await audit(id, 'staff.bootstrapped', 'staff', id, `Opened the clinic as ${name}`)
    })

    // ── NO SESSION IS HANDED BACK, ON PURPOSE ──────────────────────────────
    //
    // Signing them straight in is one tap shorter and gets the only credential
    // to the clinic wrong. This function disables itself the moment it
    // succeeds, so a PIN mistyped here is not a PIN to be reset later — it is
    // an admin account nobody can sign into and no second bootstrap to fix it,
    // on a clinic with no other staff. Sending them to the lock screen makes
    // them type the PIN once against the hash that was actually stored, which
    // is the only test of it that means anything, at the one moment when
    // finding out costs nothing but typing it again.
    //
    // It also means the one endpoint on this server that answers strangers
    // never mints a session. An unauthenticated route that can write a row is a
    // smaller thing to get wrong than one that can hand out a token.
    return json({
      ok: true,
      message: 'The clinic is open. Sign in with the PIN you just chose.',
      staff: { id, name, roles: ['admin'] },
    })
  } catch (error) {
    if (error instanceof Refusal) {
      return json({ ok: false, message: error.message }, error.status)
    }
    console.error('bootstrap failed:', error)
    return json({ ok: false, message: 'The clinic server is not reachable.' }, 503)
  }
})
