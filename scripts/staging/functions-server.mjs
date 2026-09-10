/**
 * The nine Edge Functions, served locally against the staging database.
 *
 * A browser journey needs a backend, and this repository has no local one:
 * `docs/README.md` §3 says so and names the consequence — `npm run dev` talks
 * to the deployed functions, which sit in front of the clinic's live database,
 * so clicking around locally registers real patients. Slice 0 cannot end while
 * that is the only way to run the app.
 *
 * ── HOW IT WORKS ───────────────────────────────────────────────────────────
 *
 * Every function is a file whose entire body is one `Deno.serve(handler)`. So
 * `Deno.serve` is replaced with a function that captures the handler instead of
 * listening, each `index.ts` is imported once, and the captured handlers are
 * mounted on a Node http server at `/functions/v1/<name>` — the same path
 * shape `NEXT_PUBLIC_FUNCTIONS_URL` already points at. The functions are not
 * modified and do not know.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * It is not Deno. The code is the same code, but the runtime underneath it is
 * Node, so anything that depends on Deno's own behaviour — its permission
 * model, its `npm:` resolution, its two-second CPU budget — is not being
 * exercised here. Two things cover that gap and neither is this file: CI runs
 * `deno check` over every function, and the deployed functions are the ones
 * the clinic uses. Treat a green browser journey here as evidence about the
 * clinic's logic, not about its runtime.
 *
 * It also does not deploy anything, and it cannot reach the clinic: the
 * database URL goes through the same guard as everything else in this folder.
 */
import { createServer } from 'node:http'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { requireStagingUrl } from './guard.mjs'

const FUNCTIONS = join(process.cwd(), 'supabase', 'functions')
const PORT = Number(process.env.STAGING_FUNCTIONS_PORT ?? 54321)

const url = requireStagingUrl(
  process.env.STAGING_DB_URL ?? 'postgresql://postgres:staging@127.0.0.1:55432/clinic_staging',
  { what: 'The local functions server' },
)
process.env.SUPABASE_DB_URL = url
process.env.CLINIC_SESSION_SECRET ??= 'staging-only-session-secret-not-a-real-one'

/**
 * `Deno.serve`, replaced. The real one starts listening; this one hands the
 * handler back to the loop below, which is the only difference that matters.
 */
let captured = null
globalThis.Deno = {
  ...(globalThis.Deno ?? {}),
  env: {
    get: (key) => process.env[key],
    set: (key, value) => { process.env[key] = value },
    has: (key) => key in process.env,
    toObject: () => ({ ...process.env }),
  },
  serve: (handler) => { captured = handler },
}

const handlers = new Map()

for (const name of readdirSync(FUNCTIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => entry.name)
  .sort()) {
  captured = null
  await import(pathToFileURL(join(FUNCTIONS, name, 'index.ts')).href)
  if (typeof captured !== 'function') {
    throw new Error(`supabase/functions/${name}/index.ts did not call Deno.serve`)
  }
  handlers.set(name, captured)
}

const server = createServer(async (incoming, outgoing) => {
  const requested = new URL(incoming.url, `http://localhost:${PORT}`)
  // Both shapes, because a bare base URL and one ending in /functions/v1 are
  // both things somebody will configure.
  const name = requested.pathname.replace(/^\/functions\/v1\//, '').replace(/^\//, '').split('/')[0]
  const handler = handlers.get(name)

  if (!handler) {
    outgoing.writeHead(404, { 'content-type': 'application/json' })
    outgoing.end(JSON.stringify({ ok: false, message: `No function named "${name}".` }))
    return
  }

  const body = incoming.method === 'GET' || incoming.method === 'HEAD'
    ? undefined
    : await new Promise((resolve) => {
        const chunks = []
        incoming.on('data', (chunk) => chunks.push(chunk))
        incoming.on('end', () => resolve(Buffer.concat(chunks)))
      })

  try {
    const response = await handler(
      new Request(requested, { method: incoming.method, headers: incoming.headers, body }),
    )
    outgoing.writeHead(response.status, Object.fromEntries(response.headers))
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch (error) {
    console.error(`${name} threw:`, error)
    outgoing.writeHead(500, { 'content-type': 'application/json' })
    outgoing.end(JSON.stringify({ ok: false, message: 'The function threw.' }))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Clinic functions on http://127.0.0.1:${PORT}/functions/v1`)
  console.log(`  ${[...handlers.keys()].join(' · ')}`)
  console.log('')
  console.log('Point the page at it for this shell only:')
  console.log('')
  console.log(`  NEXT_PUBLIC_FUNCTIONS_URL=http://127.0.0.1:${PORT}/functions/v1 npm run dev`)
  console.log('')
  console.log('That variable is baked in at build time, so it must be set for the')
  console.log('build or dev command itself — not exported afterwards.')
})
