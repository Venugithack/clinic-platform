/**
 * The staging database is not "ready" because something answered.
 *
 * `npm run staging:up` used to decide the database was up by running
 * `docker exec jmc-staging pg_isready`, and on a FRESH container that is
 * wrong: the postgres image runs `initdb` and then starts a temporary server
 * to run its initialization scripts, that temporary server listens on the
 * Unix socket only, and `docker exec` talks to the Unix socket. So the check
 * answered "accepting connections" about a second before the temporary server
 * was shut down and the real one started. `up()` then connected into the gap,
 * got `FATAL: the database system is starting up`, and exited — with no
 * migrations applied and a container that was, by then, genuinely running.
 *
 * The damage is entirely downstream. `npm run test:db` against that database
 * fails in every file in a few milliseconds with `relation "jmc.staff" does
 * not exist`: two hundred red tests that look exactly like a broken migration
 * and are nothing of the kind. It reproduced on 19 September 2026 while
 * running the Slice 4 gate, which is what this file exists because of.
 *
 * ── WHAT IS TESTED HERE, AND WHAT CANNOT BE ────────────────────────────────
 *
 * The race itself needs a container mid-`initdb` and is not reproducible on
 * demand. What IS testable is the predicate, and the predicate is the whole
 * fix: `awaitReady` asks over TCP, as a real client, running a real
 * statement, twice. Each test below is one of the states the old check
 * mistook for ready, and each is a state a real fresh container passes
 * through.
 *
 * No database, no Docker, no network beyond loopback. This runs in `npm test`.
 *
 * `.mjs` and not `.ts`, for the reason `tests/support/backend.mjs` gives at
 * length: tsconfig.json excludes what this imports, but exclusion only decides
 * which files tsc opens on its own, and a `.ts` file that imports one drags it
 * in anyway — after which `npm run typecheck` dies on `scripts/staging/up.mjs`
 * having no declarations. Keeping the test in JavaScript keeps the staging
 * scripts out of tsc's graph and `npm run typecheck` meaning what it has
 * always meant.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { after, describe, test } from 'node:test'
import { awaitReady } from '../scripts/staging/up.mjs'

/** A free loopback port, and nothing listening on it. */
async function closedPort() {
  const probe = createServer()
  const port = await new Promise((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      resolve(probe.address().port)
    })
  })
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/**
 * A port that accepts a TCP connection and then says nothing.
 *
 * This is the closest reproducible analogue of the window the old check fell
 * into: something is there, and it is not a database that can answer.
 */
function silentListener() {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      // Accept, and never speak. A Postgres client waits for a handshake that
      // is not coming.
      socket.on('error', () => {})
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, server })
    })
  })
}

const servers = []
after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve))
})

/** The guard in `guard.mjs` only passes these database names. */
const url = (port) => `postgresql://postgres:staging@127.0.0.1:${port}/clinic_staging`

describe('a staging database is ready when it answers a query, not when something accepts', () => {
  test('nothing listening is not ready', async () => {
    const port = await closedPort()
    await assert.rejects(
      () => awaitReady(url(port), { attempts: 2, waitMs: 10 }),
      /did not accept a query/,
    )
  })

  test('a socket that accepts and never speaks is not ready', async () => {
    const { port, server } = await silentListener()
    servers.push(server)
    await assert.rejects(
      () => awaitReady(url(port), { attempts: 2, waitMs: 10 }),
      /did not accept a query/,
    )
  })

  test('the refusal never prints the connection string', async () => {
    // It carries a password, and this message goes to a terminal, a CI log and
    // a paste in a support thread. `guard.mjs` refuses to print a URL for the
    // same reason and this has to match it.
    const port = await closedPort()
    const error = await awaitReady(url(port), { attempts: 1, waitMs: 10 })
      .then(() => null, (thrown) => thrown)

    assert.ok(error, 'it has to fail for this to mean anything')
    assert.doesNotMatch(error.message, /staging@|postgresql:\/\//)
    assert.doesNotMatch(error.message, /:\d{4,5}\//)
  })

  test('it gives up rather than hanging, and says how long it waited', async () => {
    const port = await closedPort()
    const started = Date.now()
    const error = await awaitReady(url(port), { attempts: 3, waitMs: 10 })
      .then(() => null, (thrown) => thrown)

    assert.ok(error)
    // A staging script that hangs is worse than one that fails: nobody reads a
    // terminal that is still going.
    assert.ok(Date.now() - started < 60_000, 'three attempts must not take a minute')
    assert.match(error.message, /seconds/)
  })
})
