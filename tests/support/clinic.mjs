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
import { STAGING_DB_URL, createSession, runCommand, password } from './backend.mjs'

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

/**
 * Empty every table on `connection`, carrying the migration-installed
 * reference data across.
 *
 * The approved clinical vocabulary is reference data: migrations install it,
 * and on the clinic's database no day's work removes it. TRUNCATE does, and
 * not because the tables are named in the list — `clinical_phrases` points a
 * foreign key at `staff`, so CASCADE reaches it however the list is written.
 * So it is carried across rather than excluded, and what comes back is
 * whatever the migrations installed, not a copy kept in this file that a later
 * vocabulary release would silently contradict.
 *
 * Exported because the Slice 1 gate rebuilds the fixtures on its own
 * connection, and two truncate rules that drift apart is how the vocabulary
 * disappeared in the first place.
 */
export async function emptyClinic(connection) {
  const tables = (await connection`
    select c.relname as name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'jmc' and c.relkind = 'r'
     order by c.relname
  `).map((row) => `jmc.${row.name}`)

  const releases = await connection`select * from jmc.clinical_vocabulary_releases`
  const released = await connection`select * from jmc.clinical_phrases where release_id is not null`

  /*
   * Carrying nothing across is indistinguishable, three assertions later, from
   * a vocabulary that was never approved. Say which it is here instead.
   *
   * BOTH halves are checked, and the second is the one that has actually gone
   * wrong: a release row with no phrases under it. That is what is left when
   * two suites run against this database at once — one truncates while the
   * other is between its own read and its own restore, and the phrases are
   * gone for good, because the only copy of them was the rows this function
   * was about to put back. Checking only the release let that through, and the
   * failure surfaced four files later as `0 !== 80` in an unrelated gate.
   *
   * Refusing here does not make the concurrent run safe. It makes it loud, and
   * it stops this call from being the one that destroys the evidence.
   */
  if (releases.length === 0) {
    throw new Error(
      'No clinical vocabulary release is installed. The migrations seed it, so ' +
        'this database predates them or was emptied by hand: run "npm run staging:up".',
    )
  }
  if (released.length === 0) {
    throw new Error(
      `${releases.length} clinical vocabulary release(s) are installed but no phrase ` +
        'belongs to any of them, so there is nothing to carry across and this truncate ' +
        'would make that permanent. The usual cause is two test suites sharing this ' +
        'database — run them one at a time. Recover with "npm run staging:up".',
    )
  }

  await connection.unsafe(`truncate ${tables.join(', ')} restart identity cascade`)

  /*
   * Restored to the state the MIGRATION installed, not to the state the last
   * test left.
   *
   * `retired_at` and `active` are cleared on the way back in, and that is the
   * whole point. A test that publishes a new clinic vocabulary retires the
   * approved release; a test that withdraws a phrase deactivates it. Carrying
   * those across verbatim made them permanent: the release retired once by the
   * Slice 2 gate stayed retired for every file that ran afterwards, and every
   * one of them then saw an empty vocabulary — which is not a failure anybody
   * would read as cross-file contamination, because the query returns zero
   * rows rather than an error.
   *
   * Measured: after one such run, `clinical_phrases` held all eighty rows and
   * the doctor's suggestions were empty, because the release they belong to
   * had `retired_at` set.
   */
  await connection`insert into jmc.clinical_vocabulary_releases ${
    connection(releases.map((release) => ({ ...release, retired_at: null })))
  }`
  if (released.length > 0) {
    await connection`insert into jmc.clinical_phrases ${
      connection(released.map((phrase) => ({ ...phrase, active: 1, retired_at: null })))
    }`
  }

  /*
   * The two singleton rows the application assumes exist, put back here rather
   * than in `resetClinic`.
   *
   * `clinic_revision` without a row answers "unchanged" to every snapshot poll
   * for ever. `clinic_settings` without one is a clinic whose consultation fee
   * is nothing — which, from Slice 4, means `sign_consultation` reads the
   * default as ₹0 and then refuses the doctor's ₹300 as an unexplained
   * override. Both used to be restored only by `resetClinic`, so the Slice 1
   * gate, which empties the clinic on its own connection, met exactly that.
   */
  await connection.unsafe(`
    insert into jmc.clinic_revision (id, revision, changed_at)
    values (1, 0, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    on conflict (id) do update set revision = 0
  `)
  await connection.unsafe(`
    insert into jmc.clinic_settings (id, updated_at)
    values (1, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    on conflict (id) do nothing
  `)

  /*
   * `truncate ... restart identity` only rewinds sequences OWNED by a
   * truncated column. These are free-standing — the command layer calls
   * nextval on them directly — so they have to be rewound by name, or document
   * numbers climb across files and an assertion on 'OTC-0001' passes once.
   *
   * Here rather than in `resetClinic`, because the Slice 1 gate empties the
   * clinic on its own connection and then reseeds the fixtures: with the
   * sequence left where the previous file put it, the fixture prescriptions
   * came out numbered 4, 5 and 6 and the fixtures' own consistency check
   * caught the contradiction.
   */
  for (const seq of [
    'appointment_token_seq', 'otc_receipt_seq', 'purchase_order_seq',
    'supplier_return_seq', 'stock_take_seq', 'prescription_number_seq',
    'goods_receipt_seq', 'opening_count_seq',
    'dispense_seq', 'invoice_seq', 'receipt_seq',
  ]) {
    await connection.unsafe(`select setval('jmc.${seq}', 1, false)`)
  }
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
  await emptyClinic(admin)

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
  canPublishClinicalTemplates = false,
  active = true,
} = {}) {
  staffCounter += 1
  const id = `staff-${String(staffCounter).padStart(3, '0')}`
  const secret = await password.hashPassword(pin)
  await admin.unsafe(
    `insert into jmc.staff
       (id, name, username, phone, roles_json, pin_hash, pin_salt, pin_format,
        can_publish_clinical_templates, active, created_at)
     values ($1,$2,$3,'',$4,$5,$6,$7,$8,$9, to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'))`,
    [
      id, name, username ?? `staff${staffCounter}`, JSON.stringify(roles),
      secret.hash, secret.salt, pinFormat, canPublishClinicalTemplates ? 1 : 0, active ? 1 : 0,
    ],
  )
  return { id, name, username: username ?? `staff${staffCounter}`, roles, pin, pinFormat, canPublishClinicalTemplates }
}

/** The SessionView shape the command layer expects, without a sign-in round trip. */
export function sessionFor(staff) {
  return {
    staffId: staff.id,
    name: staff.name,
    username: staff.username,
    roles: staff.roles,
    lastSeen: new Date().toISOString(),
    canPublishClinicalTemplates: Boolean(staff.canPublishClinicalTemplates),
    // A preference, carried so this synthetic session has the same shape as
    // the one `getSession` builds. Nothing in the command layer reads it to
    // decide what anybody may do.
    theme: staff.theme ?? 'system',
  }
}

/** Run a command as a staff member. */
export function as(staff, action, payload = {}) {
  return runCommand(sessionFor(staff), action, payload)
}

/**
 * A real session token for a staff member.
 *
 * `sessionFor` builds the SessionView the command layer wants without a
 * sign-in; the GET endpoints take a bearer token instead and resolve it
 * themselves, so this signs in properly through the backend's own
 * `createSession`. Each caller string is unique so one test's failed attempt
 * cannot throttle another's.
 */
export async function tokenFor(staff) {
  const result = await createSession(staff.id, staff.pin, `test-${staff.id}-${Math.random()}`)
  if (!('token' in result)) {
    throw new Error(`Could not sign in as ${staff.username}: ${JSON.stringify(result)}`)
  }
  return result.token
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
