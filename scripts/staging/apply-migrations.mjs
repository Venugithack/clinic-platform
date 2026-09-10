/**
 * Apply supabase/migrations/ to a local scratch database, in a transaction,
 * and prove afterwards that the schema landed where it was supposed to.
 *
 * ── THE BUG THIS EXISTS TO CATCH ───────────────────────────────────────────
 *
 * Every migration in this repository begins `set local search_path = jmc`, and
 * `SET LOCAL` outside a transaction block does nothing at all. Postgres says so
 * — `WARNING: SET LOCAL can only be used in transaction blocks` — and then
 * carries on and runs the file with the default search_path.
 *
 * Applied that way, `create table if not exists staff (...)` creates
 * `public.staff`. Not an error. Not a warning about the table. Thirty tables
 * land in `public`, which on the clinic's database is where the RETIRED
 * application's 74 tables live, and eight of the names collide exactly: staff,
 * patients, bills, appointments, vitals, prescriptions, encounters, suppliers.
 * The application then reads whichever the search_path finds first.
 *
 * `supabase db push` wraps each migration in a transaction, which is why
 * production is correct today. Nothing else is guaranteed to: not psql, not a
 * paste into the SQL editor, not a restore path, not whatever the next tool is.
 * So this applier does two things the bare files cannot do for themselves —
 * it always opens a transaction, and it checks the result rather than trusting
 * that it opened one.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import { stagingUrlFromEnv } from './guard.mjs'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

/**
 * The hardening migration reaches into the retired application's objects. On a
 * fresh database those do not exist, so staging creates stubs first — see
 * legacy-stubs.sql for why that is better than skipping the migration.
 */
const STUBS = join(process.cwd(), 'scripts', 'staging', 'legacy-stubs.sql')

/** Tables that must end up in `jmc`. If any is in `public`, search_path failed. */
const CANARIES = ['staff', 'patients', 'prescriptions', 'bills', 'clinic_revision']

export async function applyMigrations({ url = stagingUrlFromEnv({ what: 'apply-migrations' }), log = console.log } = {}) {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })

  try {
    log('  legacy stubs (staging only)')
    await sql.begin((tx) => tx.unsafe(readFileSync(STUBS, 'utf8')))

    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
    if (files.length === 0) throw new Error('supabase/migrations/ is empty.')

    for (const file of files) {
      const text = readFileSync(join(MIGRATIONS, file), 'utf8')
      // sql.begin() is the transaction the `set local search_path` in every one
      // of these files silently requires.
      await sql.begin((tx) => tx.unsafe(text))
      log(`  ${file}`)
    }

    await assertSchemaLanded(sql)
    log(`  ${files.length} migration(s) applied; schema verified in jmc`)
    return files.length
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * The check that makes the transaction wrapping above load-bearing rather than
 * decorative. Two questions: are the canary tables in `jmc`, and did any of
 * them ALSO appear in `public`, which is what a half-applied run looks like.
 */
export async function assertSchemaLanded(sql) {
  const rows = await sql`
    select n.nspname as schema, c.relname as name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r'
       and n.nspname in ('jmc', 'public')
       and c.relname = any(${CANARIES})
  `

  const missing = CANARIES.filter((t) => !rows.some((r) => r.schema === 'jmc' && r.name === t))
  if (missing.length > 0) {
    throw new Error(
      `Migrations did not create jmc.${missing.join(', jmc.')}. ` +
        'The most likely cause is that a migration ran outside a transaction, ' +
        'so its `set local search_path = jmc` did nothing and the tables went ' +
        'to public. Check for "SET LOCAL can only be used in transaction blocks".',
    )
  }

  const strays = rows.filter((r) => r.schema === 'public')
  if (strays.length > 0) {
    throw new Error(
      `REFUSING: the clinic's tables also exist in public — ${strays.map((r) => r.name).join(', ')}. ` +
        'On the shared clinic database public belongs to the retired application ' +
        'and eight of these names collide with it. Drop and rebuild this database.',
    )
  }
}

// Runnable on its own, which is how CI uses it: there is no Docker container
// to create there, only a service database already listening.
if (process.argv[1]?.endsWith('apply-migrations.mjs')) {
  applyMigrations()
    .then((count) => console.log(`${count} migration(s) applied.`))
    .catch((error) => {
      console.error(`\n${error.message}\n`)
      process.exit(1)
    })
}
