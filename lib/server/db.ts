import 'server-only'

import { AsyncLocalStorage } from 'node:async_hooks'
import { randomInt, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { hashPassword } from './password'

/**
 * The clinic's database.
 *
 * This was `node:sqlite` writing a file next to the app. That is a fine way to
 * build something in a night and the wrong way to run a clinic: the file lives
 * on one machine, four tablets cannot share it, and a backup is somebody
 * remembering to copy it.
 *
 * It is Postgres now — the clinic's existing hosted project in Mumbai, which is
 * already provisioned, already backed up nightly and already paid for. No new
 * database, no second bill.
 *
 * ── WHY THE CALL SITES BARELY CHANGED ───────────────────────────────────────
 *
 * `db.prepare(sql).get(a, b)` is kept exactly as it was, because the SQL in
 * this app turned out to be almost entirely portable — one `insert or replace`,
 * two pragmas, and no `strftime`, `julianday`, `group_concat`, `ifnull` or
 * `autoincrement` anywhere. Rewriting eighty-six working queries to a different
 * client would have risked the whole data layer to gain nothing.
 *
 * The one unavoidable difference is that SQLite's `DatabaseSync` is synchronous
 * and a network database cannot be. So every call site gained an `await`, and
 * nothing else.
 *
 * ── HOW TRANSACTIONS STAY ATOMIC ────────────────────────────────────────────
 *
 * A Postgres transaction belongs to one connection, so a naive port would have
 * left `transaction(() => …)` opening a transaction on one connection while the
 * statements inside it ran on others — every write committing separately, which
 * is not a transaction at all. Dispensing decrements a batch AND writes a stock
 * movement; half of that is a shelf that disagrees with its own ledger.
 *
 * So the open transaction is held in `AsyncLocalStorage` and `conn()` prefers
 * it. Inside `transaction(...)` every `db.…` and every `audit(...)` goes to the
 * transaction's own connection without being passed it, which is what keeps the
 * nineteen call sites unchanged apart from their `await`.
 */

/**
 * Connected on first use, not on import.
 *
 * `next build` imports every route module to collect its metadata, and it does
 * that without the runtime environment. Reading DATABASE_URL at import time
 * therefore failed the BUILD rather than the request — "Failed to collect page
 * data for /api/auth/login", which says nothing about the actual problem.
 */
let client: postgres.Sql | null = null

function sql(): postgres.Sql {
  if (client) return client

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Copy the connection string from the Supabase ' +
        'dashboard (Project Settings → Database → Connection string → URI) ' +
        'into .env.local as DATABASE_URL.',
    )
  }

  client = postgres(connectionString, {
    // ── THIS APP GETS ITS OWN SCHEMA ────────────────────────────────────────
    //
    // The clinic's Postgres project is shared with the older application, whose
    // 74 tables live in `public` — and eight of them are called exactly what
    // this app calls its own: staff, patients, bills, appointments, vitals,
    // prescriptions, encounters, suppliers.
    //
    // Left in `public`, `create table if not exists` would have silently
    // skipped all eight and then written this app's rows into the running
    // clinic's tables. Setting the search_path in the startup packet means every
    // unqualified name in every query resolves inside `jmc` instead, so the two
    // applications share one database, one backup and one bill while being
    // unable to see each other at all.
    connection: { search_path: SCHEMA_NAME },
    // Supabase's poolers do not support the extended protocol's named prepared
    // statements. Harmless on a direct connection, required through a pooler.
    prepare: false,
    // A clinic tablet's request is short. A small pool is plenty and keeps well
    // clear of the project's connection ceiling.
    max: 8,
    idle_timeout: 20,
    connect_timeout: 15,
  })

  return client
}

/** The connection a statement should use: the open transaction, or the pool. */
const openTransaction = new AsyncLocalStorage<postgres.TransactionSql>()
const conn = (): postgres.TransactionSql | postgres.Sql => openTransaction.getStore() ?? sql()

/**
 * SQLite counts placeholders by position and writes them all `?`; Postgres
 * numbers them. Question marks inside string literals are left alone — a
 * `check (status in ('a','b'))` has none, but a seeded address one day will.
 */
function positional(text: string): string {
  let out = ''
  let quoted = false
  let n = 0

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (c === "'") {
      quoted = !quoted
      out += c
    } else if (c === '?' && !quoted) {
      n += 1
      out += `$${n}`
    } else {
      out += c
    }
  }

  return out
}

type Row = Record<string, unknown>

export interface Statement {
  /**
   * `changes` is the rows the statement actually touched, kept because the
   * dispensing path guards on it: `update batches set available_quantity=…
   * where id=? and available_quantity>=?` affects zero rows when another
   * tablet got there first, and that zero is what raises "Stock changed on
   * another tablet" instead of silently dispensing stock that is not there.
   */
  run(...params: unknown[]): Promise<{ changes: number }>
  get(...params: unknown[]): Promise<Row | undefined>
  all(...params: unknown[]): Promise<Row[]>
}

export const db = {
  async exec(text: string): Promise<void> {
    await ready()
    await conn().unsafe(text).simple()
  },
  prepare(text: string): Statement {
    const query = positional(text)
    return {
      async run(...params) {
        await ready()
        const result = await conn().unsafe(query, params as never[])
        return { changes: result.count ?? 0 }
      },
      async get(...params) {
        await ready()
        const rows = (await conn().unsafe(query, params as never[])) as unknown as Row[]
        return rows[0]
      },
      async all(...params) {
        await ready()
        return (await conn().unsafe(query, params as never[])) as unknown as Row[]
      },
    }
  },
}

/**
 * Everything inside runs on one connection and commits or rolls back together.
 * The callback takes no argument on purpose: statements keep using the module's
 * `db`, and `conn()` routes them here.
 */
export async function transaction<T>(work: () => Promise<T>): Promise<T> {
  await ready()
  return sql().begin((t) =>
    openTransaction.run(t, async () => {
      const value = await work()

      // Bumped inside the same transaction as the change, so the counter can
      // never claim a write that rolled back — and done here rather than at
      // nineteen call sites, so a new command cannot forget to do it.
      await t`update clinic_revision
              set revision = revision + 1, changed_at = ${now()}
              where id = 1`

      return value
    }),
  ) as Promise<T>
}

/**
 * What the tablets poll. One row, one column, no joins.
 */
export async function currentRevision(): Promise<number> {
  const row = (await db
    .prepare('select revision from clinic_revision where id = 1')
    .get()) as { revision: string | number } | undefined
  return Number(row?.revision ?? 0)
}

const now = () => new Date().toISOString()

export function isoNow() {
  return now()
}

export async function audit(
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  summary: string,
): Promise<void> {
  await db
    .prepare(
      `insert into audit_events
        (id,actor_id,action,entity_type,entity_id,summary,created_at)
        values (?,?,?,?,?,?,?)`,
    )
    .run(randomUUID(), actorId, action, entityType, entityId, summary, now())
}

// ---------------------------------------------------------------------------
// Schema and seed.
//
// These ran at import time against SQLite, which could afford it because the
// file was local and synchronous. Against a network database that would make
// every cold start pay for a round trip before serving anything, and Next
// evaluates route modules in parallel workers, so several would race.
//
// So it happens once, lazily, behind a promise every statement awaits. The
// advisory lock is what stops two workers seeding the same clinic twice.
// ---------------------------------------------------------------------------

/** Where this app's tables live. See the note on `connection` above. */
const SCHEMA_NAME = 'jmc'

const SCHEMA = `
  create table if not exists staff (
    id text primary key,
    name text not null,
    username text not null unique,
    phone text not null default '',
    roles_json text not null,
    pin_hash text not null,
    pin_salt text not null,
    active integer not null default 1,
    last_login text,
    created_at text not null
  );

  -- Failed PIN attempts, charged to the CALLER rather than to the account.
  --
  -- Locking the account is the obvious design and it is wrong on a shared
  -- tablet: anybody who can see the staff list can lock the doctor out of his
  -- own clinic by tapping a wrong PIN five times. The person who typed it is
  -- the one who should be made to wait.
  create table if not exists pin_attempts (
    id text primary key,
    -- Nullable: a caller guessing staff ids fails against no real row, and
    -- that attempt still has to count against them.
    staff_id text references staff(id),
    caller text not null,
    failed_at text not null
  );

  create index if not exists pin_attempts_caller on pin_attempts (caller, failed_at);

  create table if not exists sessions (
    token_hash text primary key,
    staff_id text not null references staff(id),
    created_at text not null,
    last_seen text not null,
    expires_at text not null
  );

  create table if not exists patients (
    id text primary key,
    name text not null,
    age integer not null,
    sex text not null check (sex in ('female','male','other')),
    phone text not null,
    address text not null default '',
    whatsapp_consent integer not null default 0,
    created_at text not null
  );

  create table if not exists appointments (
    id text primary key,
    patient_id text not null references patients(id),
    token text not null,
    reason text not null,
    scheduled_at text not null,
    status text not null check (status in ('waiting','in_consult','done','cancelled')),
    created_at text not null
  );

  create table if not exists vitals (
    id text primary key,
    patient_id text not null references patients(id),
    bp text not null,
    temperature real not null,
    pulse integer not null,
    spo2 integer not null,
    weight real not null,
    recorded_by text not null references staff(id),
    recorded_at text not null
  );

  create table if not exists encounters (
    id text primary key,
    patient_id text not null references patients(id),
    doctor_id text not null references staff(id),
    appointment_id text references appointments(id),
    diagnosis text not null,
    notes text not null,
    advice text not null,
    created_at text not null
  );

  create table if not exists prescriptions (
    id text primary key,
    patient_id text not null references patients(id),
    encounter_id text references encounters(id),
    doctor_id text not null references staff(id),
    items_json text not null,
    signed_at text not null,
    dispensed_at text
  );

  create table if not exists bills (
    id text primary key,
    patient_id text not null references patients(id),
    label text not null,
    amount real not null check (amount >= 0),
    status text not null check (status in ('unpaid','paid')),
    payment_method text,
    created_at text not null,
    paid_at text
  );

  create table if not exists beds (
    id text primary key,
    label text not null unique,
    status text not null check (status in ('available','occupied','cleaning','out_of_service')),
    patient_id text references patients(id),
    admitted_at text,
    notes text not null default ''
  );

  create table if not exists suppliers (
    id text primary key,
    code text not null unique,
    name text not null,
    contact_person text not null default '',
    whatsapp text not null default '',
    phone text not null default '',
    email text not null default '',
    address text not null default '',
    gstin text not null default '',
    active integer not null default 1,
    created_at text not null
  );

  create table if not exists medicines (
    id text primary key,
    code text not null unique,
    name text not null,
    strength text not null default '',
    dosage_form text not null default '',
    unit text not null,
    barcode text not null default '',
    sale_class text not null check (sale_class in ('otc','prescription','restricted','unknown')),
    reorder_level integer not null check (reorder_level >= 0),
    target_stock integer not null check (target_stock >= reorder_level),
    preferred_supplier_id text references suppliers(id),
    active integer not null default 1,
    created_at text not null
  );

  create table if not exists supplier_medicines (
    supplier_id text not null references suppliers(id),
    medicine_id text not null references medicines(id),
    active integer not null default 1,
    primary key (supplier_id, medicine_id)
  );

  create table if not exists batches (
    id text primary key,
    medicine_id text not null references medicines(id),
    batch_number text not null,
    expiry text not null,
    available_quantity integer not null check (available_quantity >= 0),
    mrp real not null check (mrp >= 0),
    purchase_price real not null check (purchase_price >= 0),
    selling_price real not null check (selling_price >= 0),
    received_from_supplier_id text references suppliers(id),
    received_at text not null,
    version integer not null default 1,
    unique (medicine_id, batch_number)
  );

  create table if not exists stock_movements (
    id text primary key,
    medicine_id text not null references medicines(id),
    batch_id text not null references batches(id),
    movement_type text not null,
    quantity_delta integer not null,
    reference_type text not null,
    reference_id text not null,
    actor_id text not null references staff(id),
    created_at text not null
  );

  create table if not exists otc_sales (
    id text primary key,
    receipt_number text not null unique,
    total real not null check (total >= 0),
    payment_method text not null check (payment_method in ('cash','upi','card')),
    lines_json text not null,
    created_by text not null references staff(id),
    created_at text not null
  );

  create table if not exists purchase_orders (
    id text primary key,
    order_number text not null unique,
    supplier_id text not null references suppliers(id),
    status text not null check (status in ('pending','placed','partially_delivered','delivered','cancelled')),
    requested_date text not null,
    message_draft text not null,
    external_message_id text,
    message_status text,
    created_by text not null references staff(id),
    created_at text not null,
    placed_at text
  );

  create table if not exists purchase_order_lines (
    id text primary key,
    order_id text not null references purchase_orders(id),
    medicine_id text not null references medicines(id),
    ordered_quantity integer not null check (ordered_quantity > 0),
    received_quantity integer not null default 0 check (received_quantity >= 0),
    unique (order_id, medicine_id)
  );

  create table if not exists whatsapp_messages (
    id text primary key,
    direction text not null check (direction in ('inbound','outbound')),
    audience text not null check (audience in ('patient','supplier')),
    phone text not null,
    body text not null,
    external_message_id text,
    status text not null,
    related_type text,
    related_id text,
    created_at text not null
  );

  create table if not exists csv_imports (
    id text primary key,
    file_hash text not null unique,
    row_count integer not null,
    actor_id text not null references staff(id),
    created_at text not null
  );

  -- One row, one number, bumped by every transaction.
  --
  -- The tablets poll for changes and the snapshot costs sixteen queries to
  -- build. Asking "has anything happened?" costs one, and on a quiet afternoon
  -- the answer is no — which is the difference between about 150,000 queries a
  -- day and about 10,000, and therefore the difference between paying for the
  -- database gateway and not.
  create table if not exists clinic_revision (
    id integer primary key,
    revision bigint not null default 0,
    changed_at text not null
  );

  create table if not exists audit_events (
    id text primary key,
    actor_id text not null references staff(id),
    action text not null,
    entity_type text not null,
    entity_id text not null,
    summary text not null,
    created_at text not null
  );
`

let readyPromise: Promise<void> | null = null

function ready(): Promise<void> {
  readyPromise ??= prepareDatabase()
  return readyPromise
}

async function prepareDatabase(): Promise<void> {
  await sql().unsafe(`create schema if not exists ${SCHEMA_NAME}`).simple()
  await sql().unsafe(SCHEMA).simple()

  // One worker seeds; the others wait and find the staff already there. The
  // key is arbitrary and constant — it only has to be the same in every worker.
  await sql()`insert into clinic_revision (id, revision, changed_at)
                values (1, 0, ${now()}) on conflict (id) do nothing`

  await sql().begin(async (t) => {
    await t`select pg_advisory_xact_lock(4132024)`

    const [{ count }] = (await t`select count(*)::int as count from staff`) as unknown as [
      { count: number },
    ]
    if (count > 0) return

    await seed(t)
  })
}

/** Six digits, uniformly distributed, leading zeros allowed. */
function newPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

async function seed(t: postgres.TransactionSql): Promise<void> {
  const issued: string[] = []

  const staff = async (id: string, name: string, username: string, phone: string, roles: string[], pin: string) => {
    const secret = hashPassword(pin)
    await t`insert into staff (id, name, username, phone, roles_json, pin_hash, pin_salt, active, created_at)
            values (${id}, ${name}, ${username}, ${phone}, ${JSON.stringify(roles)}, ${secret.hash}, ${secret.salt}, 1, ${now()})`
    issued.push(`  ${name.padEnd(24)} PIN ${pin}`)
  }

  // The administrator's PIN can be chosen, because somebody has to be able to
  // get in and set everybody else's. The rest are random: a known default PIN
  // on a clinic that is reachable from the internet is not a default, it is a
  // published password.
  const adminPin = process.env.CLINIC_ADMIN_PIN?.trim() || newPin()
  if (!/^\d{6}$/.test(adminPin)) throw new Error('CLINIC_ADMIN_PIN must be exactly six digits.')

  await staff('stf_admin', 'Clinic Administrator', 'admin', '+91 90000 10001', ['admin'], adminPin)
  await staff('stf_doctor', 'Dr. Jayamurugan', 'doctor', '+91 90000 10002', ['doctor'], newPin())
  await staff('stf_nurse', 'Nurse Meena', 'nurse', '+91 90000 10003', ['nurse'], newPin())
  await staff('stf_pharmacy', 'Pharmacy Counter', 'pharmacy', '+91 90000 10004', ['pharmacy'], newPin())

  // Printed once, at the only moment they exist in plaintext. The administrator
  // signs in with theirs and sets the others from the Staff screen.
  console.info(
    ['', 'Clinic seeded. Sign-in PINs (shown once):', ...issued, ''].join('\n'),
  )

  await t`insert into beds (id,label,status,patient_id,admitted_at,notes) values
    ('bed_1','Bed 1','available',null,null,''),
    ('bed_2','Bed 2','available',null,null,''),
    ('bed_3','Bed 3','available',null,null,''),
    ('bed_4','Bed 4','available',null,null,'')`

  await t`insert into audit_events (id,actor_id,action,entity_type,entity_id,summary,created_at)
          values (${randomUUID()}, 'stf_admin', 'clinic.seeded', 'clinic', 'jayamurugan',
                  'Clinic workspace created', ${now()})`
}
