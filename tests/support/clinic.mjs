/**
 * A clean clinic, per test.
 *
 * Characterization tests build their own state through the real commands
 * rather than leaning on the staging fixtures. That is deliberate: a test that
 * asserts "FEFO picks the earliest expiry" is only evidence if the two batches
 * were created by the code under test, and a test coupled to a fixture file
 * fails the day somebody adds a medicine to it for an unrelated reason.
 *
 * So the fixtures are for driving the app by hand and for the browser suite;
 * these helpers are for the database suite, and they start from empty.
 */
import postgres from 'postgres'
import { STAGING_DB_URL, runCommand, password } from './backend.mjs'

/**
 * A second connection, used only to reset between tests. The backend's own
 * pool is left alone — tearing it down would mean re-importing db.ts to get it
 * back, and module state does not come back.
 */
const admin = postgres(STAGING_DB_URL, {
  max: 1,
  prepare: false,
  onnotice: () => {},
  connection: { search_path: 'jmc' },
})

/** Everything the migrations create, minus the two rows that must survive. */
async function clinicTables() {
  const rows = await admin`
    select c.relname as name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'jmc' and c.relkind = 'r'
     order by c.relname
  `
  return rows.map((row) => row.name)
}

/**
 * Empty every table, rewind every sequence, and put back the two singleton
 * rows the application assumes exist: clinic_revision (without which every
 * snapshot poll answers "unchanged" forever — see the migration that adds it)
 * and clinic_settings.
 *
 * TRUNCATE ... CASCADE rather than DELETE: the foreign keys form a graph deep
 * enough that ordering deletes by hand is a maintenance job nobody will do.
 */
export async function resetClinic() {
  const tables = await clinicTables()
  const list = tables.map((t) => `jmc.${t}`).join(', ')
  await admin.unsafe(`truncate ${list} restart identity cascade`)

  await admin.unsafe(`
    insert into jmc.clinic_revision (id, revision, changed_at)
    values (1, 0, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    on conflict (id) do update set revision = 0
  `)
  await admin.unsafe(`
    insert into jmc.clinic_settings (id, updated_at)
    values (1, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    on conflict (id) do nothing
  `)

  // `truncate ... restart identity` only rewinds sequences OWNED by a truncated
  // column. These five are free-standing — commands.ts calls nextval on them
  // directly — so they have to be rewound by name or document numbers keep
  // climbing across tests and an assertion on 'OTC-0001' passes once.
  for (const seq of [
    'appointment_token_seq', 'otc_receipt_seq', 'purchase_order_seq',
    'supplier_return_seq', 'stock_take_seq',
  ]) {
    await admin.unsafe(`select setval('jmc.${seq}', 1, false)`)
  }
}

/** Close the reset connection. Call from an `after()` hook. */
export async function closeClinic() {
  await admin.end({ timeout: 5 })
}

let staffCounter = 0

/**
 * A staff member, inserted directly.
 *
 * Not through `create_staff`, because that command requires an admin session
 * and the first admin has to come from somewhere. This is the same insert
 * `bootstrap` performs, with the same real scrypt hash, so a PIN seeded here
 * signs in through the backend's own createSession exactly as a real one does.
 */
export async function makeStaff({
  name = 'Test Staff',
  username,
  roles = ['admin'],
  pin = '4829',
  // Derived from the PIN's length rather than defaulted, so a test that asks
  // for a six-digit PIN gets a staff member who can actually use it. Pass it
  // explicitly only to build the broken pairing on purpose.
  pinFormat = pin.length === 6 ? 'legacy_six' : 'four',
  active = true,
} = {}) {
  staffCounter += 1
  const id = `staff-${String(staffCounter).padStart(3, '0')}`
  const secret = await password.hashPassword(pin)
  await admin.unsafe(
    `insert into jmc.staff
       (id, name, username, phone, roles_json, pin_hash, pin_salt, pin_format, active, created_at)
     values ($1,$2,$3,'',$4,$5,$6,$7,$8, to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'))`,
    [
      id, name, username ?? `staff${staffCounter}`, JSON.stringify(roles),
      secret.hash, secret.salt, pinFormat, active ? 1 : 0,
    ],
  )
  return { id, name, username: username ?? `staff${staffCounter}`, roles, pin, pinFormat }
}

/** The SessionView shape the command layer expects, without a sign-in round trip. */
export function sessionFor(staff) {
  return {
    staffId: staff.id,
    name: staff.name,
    username: staff.username,
    roles: staff.roles,
    lastSeen: new Date().toISOString(),
  }
}

/** Run a command as a staff member. */
export function as(staff, action, payload = {}) {
  return runCommand(sessionFor(staff), action, payload)
}

/** Read a single value out of the clinic, for assertions. */
export async function scalar(text, params = []) {
  const rows = await admin.unsafe(text, params)
  return rows[0] ? Object.values(rows[0])[0] : undefined
}

/** Read rows out of the clinic, for assertions. */
export async function rows(text, params = []) {
  return admin.unsafe(text, params)
}

/**
 * The clinic's today, in Kolkata rather than in Greenwich.
 *
 * `commands.ts` compares batch expiries against
 * `(now() at time zone 'Asia/Kolkata')::date`. A test that builds an expiry
 * from the machine's UTC date is a test that passes all day and fails between
 * 18:30 and midnight UTC, when Kolkata has already turned over. Ask the
 * database the same question the code asks it.
 */
export async function clinicToday() {
  return String(await scalar(`select (now() at time zone 'Asia/Kolkata')::date::text`))
}

/** A date `days` from the clinic's today, as YYYY-MM-DD. */
export async function clinicDate(days) {
  return String(
    await scalar(
      `select ((now() at time zone 'Asia/Kolkata')::date + ($1 || ' days')::interval)::date::text`,
      [String(days)],
    ),
  )
}
