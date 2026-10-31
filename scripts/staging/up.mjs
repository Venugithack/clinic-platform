/**
 * Bring up the clinic's staging database.
 *
 * A disposable PostgreSQL 17 in Docker, the real migrations applied to it, and
 * synthetic fixtures on top. It is the answer to docs/README.md §3 — "there is
 * no local backend ... local development is not a sandbox" — and to the first
 * item of Slice 0 in the implementation brief.
 *
 * It is a plain container rather than `supabase start` on purpose. `supabase
 * start` brings up eleven images and needs a supabase/config.toml this
 * repository does not have; what the database tests need is Postgres, and
 * Postgres is one image and four seconds. The Edge Function runtime is a
 * separate question, answered in docs/operations/STAGING.md.
 *
 * Everything here refuses to act on anything but a loopback scratch database —
 * see guard.mjs. The clinic's live database is reachable from this machine.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import { requireStagingUrl } from './guard.mjs'
import { applyMigrations } from './apply-migrations.mjs'

const CONTAINER = process.env.STAGING_CONTAINER ?? 'jmc-staging'
const PORT = process.env.STAGING_PORT ?? '55432'
const DATABASE = 'clinic_staging'
const PASSWORD = 'staging'
const IMAGE = 'postgres:17'

export const STAGING_URL = `postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`

function docker(args, { quiet = true } = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' })
}

function containerState() {
  try {
    return docker(['inspect', '-f', '{{.State.Status}}', CONTAINER]).trim()
  } catch {
    return 'absent'
  }
}

/**
 * Wait until the database can actually answer a query, over the connection
 * everything else will use.
 *
 * ── THE BUG THIS REPLACES, WHICH COST ABOUT THREE HOURS ────────────────────
 *
 * This used to be `docker exec jmc-staging pg_isready`, in a retry loop, and
 * it was wrong in a way that only shows up on a FRESH container — so it
 * passed every time anybody ran it twice.
 *
 * The postgres image's entrypoint, on an empty data directory, runs `initdb`
 * and then starts a **temporary server** to run the initialization scripts.
 * That server listens on the Unix socket only. `docker exec … pg_isready`
 * talks to the Unix socket. So it answers "accepting connections" — about a
 * second before the temporary server is shut down and the real one starts.
 * The container's own log says all of it:
 *
 *     [60] LOG:  database system is ready to accept connections   ← temporary
 *     [60] LOG:  database system is shut down
 *     PostgreSQL init process complete; ready for start up.
 *     [85] FATAL: the database system is starting up              ← us
 *     [1]  LOG:  database system is ready to accept connections   ← real, 96ms later
 *
 * `up()` then threw on that FATAL and exited non-zero, which is correct and is
 * not the problem. The problem is what it looks like downstream: a container
 * that IS running, a `jmc` schema with nothing in it, and a database suite
 * that fails in every file in about five milliseconds with `relation
 * "jmc.staff" does not exist`. Two hundred red tests that all look like a
 * broken migration, and none of them is.
 *
 * ── WHY THIS SHAPE ─────────────────────────────────────────────────────────
 *
 * Ask the question the way every consumer asks it: over TCP, from the host,
 * as a real client, running a real statement. The temporary server does not
 * listen on TCP at all, so it cannot answer this — the whole class of
 * false-ready disappears rather than being timed around.
 *
 * Twice, a moment apart, because "answered once" and "is up" are different
 * claims and this is the one place in the repository where the difference has
 * already cost a day. A server that answers and then goes away fails the
 * second ask.
 *
 * Exported so `tests/staging-readiness.test.mjs` can point it at things that
 * are not a ready database and watch it refuse them.
 */
export async function awaitReady(url, { attempts = 60, waitMs = 500 } = {}) {
  let consecutive = 0
  let lastError

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const client = postgres(url, {
      max: 1,
      prepare: false,
      onnotice: () => {},
      connect_timeout: 5,
      // One attempt per loop. The driver's own retrying would hide exactly the
      // transition this is here to see.
      max_lifetime: null,
    })
    try {
      await client`select 1`
      consecutive += 1
      if (consecutive >= 2) return
    } catch (error) {
      // Never the connection string: it carries a password.
      lastError = error?.code ?? error?.message ?? 'unknown'
      consecutive = 0
    } finally {
      await client.end({ timeout: 5 }).catch(() => {})
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }

  throw new Error(
    `The staging database did not accept a query within ${Math.round((attempts * waitMs) / 1000)} ` +
    `seconds. Last answer: ${lastError}.`,
  )
}

async function seed(url) {
  const path = join(process.cwd(), 'scripts', 'staging', 'fixtures.mjs')
  if (!existsSync(path)) {
    console.log('  (no fixtures.mjs yet - schema only)')
    return
  }
  // Fixtures are a module, not a .sql file, because staff PINs have to be
  // hashed by the backend's own scrypt for a test to be able to sign in with
  // one. A seed file of literal hashes is a seed file that stops matching the
  // hashing code the first time anybody touches it.
  const { seedClinic } = await import(pathToFileURL(path).href)
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
  try {
    const summary = await seedClinic(sql)
    console.log(`  fixtures seeded${summary ? `: ${summary}` : ''}`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function up({ fresh = true } = {}) {
  const url = requireStagingUrl(STAGING_URL, { what: 'staging:up' })

  const state = containerState()
  if (state === 'absent') {
    console.log(`Creating ${CONTAINER} (${IMAGE}) on port ${PORT}`)
    docker([
      'run', '-d', '--name', CONTAINER,
      '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
      '-e', `POSTGRES_DB=${DATABASE}`,
      '-p', `${PORT}:5432`,
      IMAGE,
    ])
  } else if (state !== 'running') {
    console.log(`Starting ${CONTAINER}`)
    docker(['start', CONTAINER])
  } else {
    console.log(`${CONTAINER} is already running`)
  }

  /*
   * Over TCP, on the URL the guard already approved, so the readiness check
   * and every consumer are asking the same server the same way.
   */
  await awaitReady(url)

  if (fresh) {
    // A staging database that carries yesterday's experiment is a staging
    // database whose test failures are somebody else's fault.
    console.log('Rebuilding the schema from scratch')
    const admin = postgres(`postgresql://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`, {
      max: 1, prepare: false, onnotice: () => {},
    })
    try {
      await admin.unsafe('drop schema if exists jmc cascade')
      await admin.unsafe('drop schema if exists app cascade')
      await admin.unsafe('drop schema if exists public cascade')
      await admin.unsafe('create schema public')
    } finally {
      await admin.end({ timeout: 5 })
    }
  }

  console.log('Applying migrations')
  await applyMigrations({ url })
  await seed(url)

  console.log('')
  console.log('Staging is up. Point tests at it with:')
  console.log('')
  console.log(`  export STAGING_DB_URL="${STAGING_URL}"`)
  console.log('')
  return url
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('up.mjs')) {
  up().catch((error) => {
    console.error(`\n${error.message}\n`)
    process.exit(1)
  })
}
