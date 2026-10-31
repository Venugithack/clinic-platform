/**
 * The clinic's clean start. One use only, on launch night, before the update
 * to the release merged as pull request #38.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 *
 * Decided 31 October 2026: the clinic has never used the deployed app. What
 * the live database holds is test data. The preflight on that day (ROLLOUT.md
 * §2) found 3 prescriptions, 3 unpaid bills worth ₹700, 3 counter sales, 2
 * medicines and 4 staff accounts, none of them real people. Left in place:
 *
 *   - the test prescriptions become RX-000001 to RX-000003 (Slice 2 numbers
 *     every existing prescription);
 *   - the test bills become invoices, so ₹700 that nobody owes sits in the
 *     clinic's money records and dues reports (Slice 4);
 *   - the test sales sit in the registers an inspector can ask for.
 *
 * So the clinic starts empty, and its first administrator is created by the
 * real doctor on the lock screen (`supabase/functions/bootstrap`), which works
 * only while `staff` holds no row at all.
 *
 * ── WHAT IT DOES ───────────────────────────────────────────────────────────
 *
 * One transaction. It empties all 26 tables of the clinic's own records,
 * staff and sessions included, and puts the five document-number sequences
 * back to 1. It keeps three tables:
 *
 *   clinic_settings   the details that print, which the doctor checks on the
 *                     Clinic screen afterwards;
 *   clinic_revision   moved forward rather than reset, so that any open
 *                     tablet drops what it was holding;
 *   beds              the observation beds, each made empty and available.
 *                     A bed is a piece of furniture, not a record. And the
 *                     application has no way to create one: there is an
 *                     `update_bed` command and no `add_bed`. The four the
 *                     clinic has were seeded by the retired application, so
 *                     emptying this table would leave the nurse's Observation
 *                     station with no beds and no way to get any.
 *
 * It touches nothing outside the `jmc` schema. The retired application's
 * tables in `public` are not this script's business.
 *
 * ── WHY IT CANNOT BE RUN BY MISTAKE ────────────────────────────────────────
 *
 * Every guard is checked inside the transaction and any failure rolls it back.
 *
 *   1. The applied migrations must be exactly the nine the clinic has run
 *      since 9 September 2026. The update applies twenty-one more, so once it
 *      has run, this script refuses for good.
 *   2. The `jmc` tables must be exactly the 29 it knows about. A table it does
 *      not recognise means a database it was not written for.
 *   3. None of patients, visits, consultations, prescriptions, bills or
 *      counter sales may hold more than 20 rows. More than that is a clinic in
 *      use, not test data.
 *   4. Without `--commit` it is a dry run: it removes everything, checks the
 *      result, prints what it removed and then rolls back. `--commit=N` only
 *      commits if N is the number of rows the same run is about to remove.
 *      Pass the total the dry run printed. If anybody added or changed a
 *      record in between, the totals differ and nothing is removed.
 *
 * ── HOW TO RUN IT ──────────────────────────────────────────────────────────
 *
 *   node scripts/launch/clean-start.mjs              # dry run, changes nothing
 *   node scripts/launch/clean-start.mjs --commit=N   # N = the dry run's total
 *
 * From the repository root. It reads DATABASE_URL from .env.local and never
 * prints it. Take and verify a backup first (ROLLOUT.md §3).
 * `npm run staging:clean-start` rehearses the whole sequence, from this
 * script through the twenty-one migrations, against local scratch.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'

/** What the clinic has applied since 9 September 2026, and nothing else. */
export const LIVE_MIGRATIONS = [
  '20260831000000',
  '20260831010000',
  '20260831020000',
  '20260831030000',
  '20260831040000',
  '20260831050000',
  '20260909125214',
  '20260909125224',
  '20260909125237',
]

/** Kept. None of them is a record of anything that happened. */
export const KEPT = ['beds', 'clinic_revision', 'clinic_settings']

/**
 * Emptied. Every other table those nine migrations create. `staff` and
 * `patients` are listed but deleted rather than truncated, because a kept
 * table refers to each (`clinic_settings.updated_by`, `beds.patient_id`), and
 * Postgres will not truncate a table that a table it is not truncating refers
 * to. Both references are cleared first.
 */
export const CLEARED = [
  'appointments', 'audit_events', 'batches', 'bills', 'cash_movements',
  'csv_imports', 'encounters', 'medicines', 'otc_sales', 'patients',
  'pin_attempts', 'prescriptions', 'purchase_order_lines', 'purchase_orders',
  'sessions', 'staff', 'stock_movements', 'stock_take_lines', 'stock_takes',
  'stock_writeoffs', 'supplier_medicines', 'supplier_returns', 'suppliers',
  'till_sessions', 'vitals', 'whatsapp_messages',
]

/** The document numbers 20260909125224 put on sequences. Back to 1. */
export const SEQUENCES = [
  'appointment_token_seq', 'otc_receipt_seq', 'purchase_order_seq',
  'supplier_return_seq', 'stock_take_seq',
]

/** The tables that grow with every patient, and the most each may hold. */
export const WATCHED = ['patients', 'appointments', 'encounters', 'prescriptions', 'bills', 'otc_sales']
export const CEILING = 20

/** A guard said no. Nothing was changed. */
export class Refused extends Error {
  constructor(message) {
    super(message)
    this.name = 'Refused'
  }
}

/** The dry run's way out of the transaction, carrying what it would have done. */
class DryRun extends Error {
  constructor(report) {
    super('dry run')
    this.report = report
  }
}

/**
 * Run the clean start over an open `postgres` connection.
 *
 * Returns `{ committed, removed, total, sequences, settings }`. Throws
 * `Refused` when a guard says no; anything else that is thrown is a fault.
 * Either way the transaction has rolled back and nothing changed.
 */
export async function cleanStart(sql, { commit = null } = {}) {
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe(`set local lock_timeout = '5s'`)
      await tx.unsafe(`set local statement_timeout = '60s'`)

      // ── 1. the clinic is still on the nine ─────────────────────────────
      const [{ exists: hasLedger }] = await tx`
        select to_regclass('supabase_migrations.schema_migrations') is not null as exists`
      if (!hasLedger) {
        throw new Refused('There is no supabase_migrations.schema_migrations here, so this is not the clinic database.')
      }
      const applied = (await tx`select version from supabase_migrations.schema_migrations order by 1`)
        .map((row) => String(row.version))
      if (applied.join(',') !== LIVE_MIGRATIONS.join(',')) {
        throw new Refused(
          `The applied migrations are not the clinic's nine (found ${applied.length}, last ` +
            `${applied.at(-1) ?? 'none'}). This script only runs before the update, never after it.`,
        )
      }

      // ── 2. the tables are the ones it was written for ──────────────────
      const tables = (await tx`
        select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'jmc' and c.relkind in ('r', 'p') order by 1`).map((row) => row.relname)
      const known = new Set([...KEPT, ...CLEARED])
      const unknown = tables.filter((name) => !known.has(name))
      const missing = [...known].filter((name) => !tables.includes(name))
      if (unknown.length || missing.length) {
        throw new Refused(
          'The jmc tables are not the 29 this script knows' +
            (unknown.length ? `; not expected: ${unknown.join(', ')}` : '') +
            (missing.length ? `; missing: ${missing.join(', ')}` : '') + '.',
        )
      }

      // ── 3. it is test data, not a clinic in use ────────────────────────
      const removed = {}
      for (const table of CLEARED) {
        const [{ n }] = await tx.unsafe(`select count(*)::int as n from jmc.${table}`)
        removed[table] = Number(n)
      }
      const busy = WATCHED.filter((table) => removed[table] > CEILING)
      if (busy.length) {
        throw new Refused(
          `More than ${CEILING} rows in ${busy.map((t) => `${t} (${removed[t]})`).join(', ')}. ` +
            'That is a clinic in use, not test data. Nothing was removed.',
        )
      }
      const total = Object.values(removed).reduce((sum, n) => sum + n, 0)

      const sequences = {}
      for (const name of SEQUENCES) {
        const [row] = await tx.unsafe(`select last_value::text as last_value, is_called from jmc.${name}`)
        sequences[name] = row.is_called ? Number(row.last_value) : 0
      }

      const [settings] = await tx`
        select name, address, phone, email, drug_licence_number, doctor_registration_number,
               gstin, consultation_fee::text as consultation_fee, footer_note
          from jmc.clinic_settings where id = 1`
      if (!settings) throw new Refused('jmc.clinic_settings has no row 1. This is not the database it was written for.')
      const beds = (await tx`select label from jmc.beds order by label`).map((row) => row.label)

      // ── 4. the clean start ─────────────────────────────────────────────
      await tx`update jmc.clinic_settings set updated_by = null`
      await tx`
        update jmc.beds set status = 'available', patient_id = null, admitted_at = null, notes = ''`
      const deleted = new Set(['staff', 'patients'])
      await tx.unsafe(
        `truncate ${CLEARED.filter((t) => !deleted.has(t)).map((t) => `jmc.${t}`).join(', ')} restart identity`,
      )
      await tx`delete from jmc.patients`
      await tx`delete from jmc.staff`
      // RESTART, not setval. `setval` is one of the few things in Postgres a
      // rollback does not undo, so a dry run built on it would have reset the
      // clinic's numbering while claiming to change nothing. The first draft
      // of this script did exactly that, and the rehearsal caught it.
      // ALTER SEQUENCE ... RESTART is transactional, and it is what
      // TRUNCATE ... RESTART IDENTITY does underneath.
      for (const name of SEQUENCES) await tx.unsafe(`alter sequence jmc.${name} restart with 1`)
      await tx`
        update jmc.clinic_revision
           set revision = revision + 1,
               changed_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         where id = 1`

      // ── 5. check the result before it can commit ───────────────────────
      for (const table of CLEARED) {
        const [{ n }] = await tx.unsafe(`select count(*)::int as n from jmc.${table}`)
        if (Number(n) !== 0) throw new Error(`jmc.${table} still holds ${n} row(s) after the clean start.`)
      }
      for (const name of SEQUENCES) {
        const [row] = await tx.unsafe(`select last_value::text as last_value, is_called from jmc.${name}`)
        if (row.is_called || Number(row.last_value) !== 1) throw new Error(`jmc.${name} did not go back to 1.`)
      }
      const [{ n: kept }] = await tx`
        select (select count(*) from jmc.clinic_settings) + (select count(*) from jmc.clinic_revision) as n`
      if (Number(kept) !== 2) throw new Error('clinic_settings or clinic_revision lost its row.')
      const [{ n: bedsLeft, busy: bedsBusy }] = await tx`
        select count(*)::int as n,
               count(*) filter (where status <> 'available' or patient_id is not null)::int as busy
          from jmc.beds`
      if (Number(bedsLeft) !== beds.length || Number(bedsBusy) !== 0) {
        throw new Error('The beds did not all survive, empty and available.')
      }

      const report = { removed, total, sequences, settings, beds }
      if (commit === null) throw new DryRun(report)
      if (Number(commit) !== total) {
        throw new Refused(
          `--commit=${commit} does not match the ${total} row(s) this run would remove. ` +
            'Something changed since the dry run. Run the dry run again and read it before committing.',
        )
      }
      return { committed: true, ...report }
    })
  } catch (error) {
    if (error instanceof DryRun) return { committed: false, ...error.report }
    throw error
  }
}

/** What the person at the terminal reads. */
export function describe(result) {
  const lines = []
  lines.push(result.committed ? 'COMMITTED: the clinic database is now empty.' : 'DRY RUN: nothing was changed.')
  lines.push('')
  lines.push(result.committed ? 'Removed:' : 'Would remove:')
  for (const [table, n] of Object.entries(result.removed)) if (n) lines.push(`  ${String(n).padStart(5)}  ${table}`)
  lines.push(`  ${String(result.total).padStart(5)}  rows in total`)
  lines.push('')
  lines.push(result.committed ? 'Numbering reset to 1 (last number used before):' : 'Numbering that would go back to 1 (last number used):')
  for (const [name, last] of Object.entries(result.sequences)) lines.push(`  ${String(last).padStart(5)}  ${name}`)
  lines.push('')
  lines.push('Kept. The clinic details that print (check them on the Clinic screen after launch):')
  for (const [field, value] of Object.entries(result.settings)) {
    lines.push(`  ${field.padEnd(27)} ${value === '' ? '(empty)' : value}`)
  }
  lines.push('')
  lines.push(
    result.beds.length
      ? `Kept, each made empty and available. The app cannot add beds, so these are all the clinic will have: ${result.beds.join(', ')}`
      : 'Observation beds: none. The app cannot add one. Say so before launch.',
  )
  if (!result.committed) {
    lines.push('')
    lines.push(`To do it for real, after a verified backup:  node scripts/launch/clean-start.mjs --commit=${result.total}`)
  }
  return lines.join('\n')
}

function databaseUrl() {
  let text
  try {
    text = readFileSync(join(process.cwd(), '.env.local'), 'utf8')
  } catch {
    throw new Refused('Run this from the repository root. It reads DATABASE_URL from .env.local.')
  }
  const line = text.split(/\r?\n/).find((l) => l.startsWith('DATABASE_URL='))
  const url = line?.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '')
  if (!url || url.includes('YOUR-PASSWORD')) throw new Refused('DATABASE_URL is not set in .env.local.')
  return url
}

if (process.argv[1]?.endsWith('clean-start.mjs')) {
  const flag = process.argv.slice(2).find((arg) => arg.startsWith('--commit'))
  const commit = flag === undefined ? null : flag.split('=')[1] ?? ''
  if (commit === '') {
    console.error('\n--commit needs the total from the dry run, as --commit=N. Run without it first.\n')
    process.exit(1)
  }
  let sql
  try {
    const url = databaseUrl()
    console.log(`target host: ${new URL(url).hostname.replace(/^[^.]+/, '***')}\n`)
    sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 20, prepare: false, onnotice: () => {} })
    console.log(describe(await cleanStart(sql, { commit })))
  } catch (error) {
    console.error(
      error instanceof Refused
        ? `\nREFUSED: ${error.message}\nNothing was changed.\n`
        : `\nFAILED: ${error.message}\nRun the dry run again to see where the database stands.\n`,
    )
    process.exitCode = 1
  } finally {
    await sql?.end({ timeout: 5 })
  }
}
