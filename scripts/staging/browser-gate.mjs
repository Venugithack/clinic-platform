/**
 * `npm run test:browser` — the clinic's screens, driven in a real browser,
 * against the guarded local staging environment and nothing else.
 *
 * Everything the gate needs, in order, and torn down afterwards:
 *
 *   1. the staging database, rebuilt with fixtures
 *   2. one extra fixture: a doctor-ONLY account, so a doctor's rail can be
 *      seen as a doctor sees it (the seeded doctor also holds admin)
 *   3. the static export, built against the local functions — not `next dev`,
 *      because NEXT_PUBLIC_FUNCTIONS_URL is baked in at build time and the
 *      export is what Cloudflare actually serves
 *   4. the thirteen Edge Functions on 127.0.0.1:54321
 *   5. the page on 127.0.0.1:54330
 *   6. node --test over tests/browser
 *
 * ── THE SAFETY ARGUMENT ────────────────────────────────────────────────────
 *
 * This suite registers patients, issues queue tokens and records vitals. Run
 * against the wrong backend it would do all of that to the clinic in Chennai,
 * and there is no undo. Three separate things have to agree before a single
 * click happens:
 *
 *   - guard.mjs refuses any database that is not a loopback scratch database
 *   - the build is done HERE, by this script, with the staging URL
 *   - harness.mjs re-reads the built bundle before serving it and refuses if
 *     the live project appears anywhere in it
 *
 * The third exists because the first two can both be satisfied by a developer
 * who then runs `npm run build` in another shell and leaves out/ pointing at
 * production.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { requireStagingUrl } from './guard.mjs'
import { up, STAGING_URL } from './up.mjs'

const FUNCTIONS_ORIGIN = 'http://127.0.0.1:54321'
const FUNCTIONS_URL = `${FUNCTIONS_ORIGIN}/functions/v1`

const url = requireStagingUrl(STAGING_URL, { what: 'The browser gate' })

/** Torn down in reverse order, whatever happens. */
const running = []
function stopEverything() {
  for (const child of running.reverse()) {
    try { child.kill() } catch { /* already gone */ }
  }
}
process.on('exit', stopEverything)
process.on('SIGINT', () => { stopEverything(); process.exit(130) })

function step(what) {
  console.log(`\n── ${what} ${'─'.repeat(Math.max(0, 62 - what.length))}`)
}

/**
 * A doctor who is only a doctor.
 *
 * The fixtures' doctor also holds admin, which is right for the clinic — the
 * owner runs it — and wrong for testing a doctor's rail, because the union of
 * both roles hides exactly the gaps Slice 1 was fixing. Inserted directly for
 * the same reason `makeStaff` does it: `create_staff` needs an admin session,
 * and this is scaffolding rather than a thing the clinic does.
 */
async function seedDoctorOnly() {
  const postgres = (await import('postgres')).default
  const { hashPassword } = await import('../../supabase/functions/_shared/password.ts')

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} })
  try {
    const secret = await hashPassword('3517')
    await sql`
      insert into jmc.staff
        (id, name, username, phone, roles_json, pin_hash, pin_salt, pin_format, active, created_at)
      values ('b1000000-0000-4000-8000-00000000d001', 'Dr Kavitha Solo', 'kavitha', '',
              '["doctor"]', ${secret.hash}, ${secret.salt}, 'four', 1,
              to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
      on conflict (id) do update set pin_hash = excluded.pin_hash,
                                     pin_salt = excluded.pin_salt,
                                     pin_format = 'four',
                                     active = 1
    `
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** Wait until something answers, so a race reads as a timeout and not a 404. */
async function waitForHttp(target, what, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(2000) })
      if (response.status < 500) return
    } catch { /* not up yet */ }
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error(`${what} never answered at ${target}`)
}

async function main() {
  step('staging database and fixtures')
  await up({ fresh: true })
  await seedDoctorOnly()
  console.log('  plus one doctor-only account for the rail test')

  step('building the static export against staging')
  // The env var is set for THIS command, deliberately. Exporting it into the
  // shell would leave a developer's next `npm run build` pointed at staging,
  // and the deployed page would then talk to a database on a laptop.
  execFileSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NEXT_PUBLIC_FUNCTIONS_URL: FUNCTIONS_URL },
  })

  step('edge functions')
  const functions = spawn(
    process.execPath,
    ['--import', './tests/support/register.mjs', 'scripts/staging/functions-server.mjs'],
    { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, STAGING_DB_URL: url } },
  )
  running.push(functions)
  await waitForHttp(`${FUNCTIONS_URL}/staff`, 'the edge functions')
  console.log(`  ${FUNCTIONS_URL}`)

  step('the page')
  const page = spawn(
    process.execPath,
    ['scripts/staging/serve-page.mjs'],
    { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env } },
  )
  running.push(page)
  await waitForHttp('http://127.0.0.1:54330/', 'the page server')
  console.log('  http://127.0.0.1:54330')

  step('journeys')

  /*
   * Every journey file by default, or the ones named on the command line.
   *
   * `npm run test:browser -- slice5-images` runs one file against the same
   * staging database, the same build and the same servers as the full gate.
   * That is for working on a failing journey: the suite takes nine minutes and
   * a browser, and re-running all of it to see one test fail again is how
   * somebody ends up debugging by guess. It is not a way to pass the gate —
   * the gate is the whole glob, and CI passes no arguments.
   *
   * A filter is matched as a substring of the filename so `slice4` and
   * `slice4-counter.test.mjs` both work; one that matches nothing is refused
   * loudly rather than quietly running zero tests and reporting success.
   */
  const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
  let targets = ['tests/browser/*.test.mjs']
  if (filters.length > 0) {
    const available = readdirSync(join(process.cwd(), 'tests', 'browser'))
      .filter((file) => file.endsWith('.test.mjs'))
    targets = available
      .filter((file) => filters.some((filter) => file.includes(filter)))
      .map((file) => `tests/browser/${file}`)
    if (targets.length === 0) {
      console.error(`No journey file matches ${filters.join(', ')}. Available:`)
      for (const file of available) console.error(`  ${file}`)
      stopEverything()
      process.exit(1)
    }
    console.log(`  running ${targets.length} of ${available.length} journey files`)
  }

  const tests = spawn(
    process.execPath,
    // One at a time. They share one browser and one database, so concurrency
    // here is two tests signing in as different people into the same tab.
    ['--test', '--test-concurrency=1', ...targets],
    { stdio: 'inherit', env: { ...process.env, STAGING_DB_URL: url } },
  )

  const code = await new Promise((done) => tests.on('exit', done))
  stopEverything()
  process.exit(code ?? 1)
}

main().catch((error) => {
  console.error(`\n${error.message}\n`)
  stopEverything()
  process.exit(1)
})
