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
 * separate question, answered in docs/STAGING.md.
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

async function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', DATABASE])
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw new Error(`${CONTAINER} did not become ready within 30 seconds.`)
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

  await waitForPostgres()

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
