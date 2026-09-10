/**
 * What the browser gate needs standing up before it can click anything.
 *
 * Three things, in this order, and the order matters:
 *
 *   1. the staging database, with fixtures — brought up by the runner
 *   2. the nine Edge Functions, on 127.0.0.1:54321
 *   3. the page itself, built as a static export and served from out/
 *
 * The page is the BUILT export rather than `next dev`, because the export is
 * what Cloudflare serves the clinic and `NEXT_PUBLIC_FUNCTIONS_URL` is baked
 * into it at build time. Testing the dev server would test a different
 * artifact, and the one difference that matters — which backend the bundle
 * dials — is exactly the one the dev server would hide.
 */
import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

export const FUNCTIONS_ORIGIN = process.env.STAGING_FUNCTIONS_ORIGIN ?? 'http://127.0.0.1:54321'
export const FUNCTIONS_URL = `${FUNCTIONS_ORIGIN}/functions/v1`
export const PAGE_PORT = Number(process.env.STAGING_PAGE_PORT ?? 54330)
export const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}`

const OUT = resolve(process.cwd(), 'out')

/**
 * The guard that matters most in this file.
 *
 * `NEXT_PUBLIC_FUNCTIONS_URL` is compiled into the bundle, so a browser test
 * cannot check at runtime which backend it is talking to — by then the answer
 * is already inside the JavaScript. If somebody runs `npm run build` in a
 * normal shell and then runs this gate, the bundle points at
 * `quqygjzcvtpnhhsfsora.supabase.co`, and a suite whose entire job is to
 * register patients and create tokens starts doing it to the clinic in
 * Chennai. There is no undo for that.
 *
 * So the built files are read and checked before the server is allowed to
 * serve them: the local functions URL must be present, and the live project
 * must not appear anywhere in the JavaScript.
 *
 * `out/_headers` is excluded on purpose. It is a Cloudflare config file, not
 * code the browser executes, and it legitimately names the clinic's origin in
 * its content-security-policy.
 */
const LIVE_PROJECT = 'quqygjzcvtpnhhsfsora'

export async function assertBuiltAgainstStaging() {
  if (!existsSync(OUT)) {
    throw new Error(
      'out/ does not exist. The browser gate runs against the built static export; ' +
        'run it through `npm run test:browser`, which builds it against staging first.',
    )
  }

  const files = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (['.js', '.mjs', '.html', '.json', '.txt'].includes(extname(entry.name))) files.push(path)
    }
  }
  await walk(OUT)

  let sawStagingUrl = false
  for (const path of files) {
    const text = await readFile(path, 'utf8')
    if (text.includes(FUNCTIONS_URL)) sawStagingUrl = true
    if (text.includes(LIVE_PROJECT)) {
      throw new Error(
        `REFUSED: ${path} names the live clinic project. The static export was built ` +
          'without NEXT_PUBLIC_FUNCTIONS_URL pointing at staging, so every click in ' +
          'this suite would register real patients and move real stock. Rebuild with ' +
          `NEXT_PUBLIC_FUNCTIONS_URL=${FUNCTIONS_URL}.`,
      )
    }
  }

  if (!sawStagingUrl) {
    throw new Error(
      `REFUSED: nothing in out/ mentions ${FUNCTIONS_URL}. The bundle is not pointed at ` +
        'the local functions, so the gate would be testing a page that talks to nothing ' +
        '— or to something this check cannot see.',
    )
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Serves out/ and nothing else.
 *
 * Cloudflare serves these files and runs no code behind them, so a static
 * server is not a simplification of production — it is production.
 */
export async function startPageServer() {
  await assertBuiltAgainstStaging()

  const server = createServer(async (request, response) => {
    const requested = new URL(request.url, PAGE_URL)
    let path = normalize(join(OUT, decodeURIComponent(requested.pathname)))

    // Nothing outside out/, whatever the URL says.
    if (!path.startsWith(OUT + sep) && path !== OUT) {
      response.writeHead(403).end('outside out/')
      return
    }

    try {
      if ((await stat(path)).isDirectory()) path = join(path, 'index.html')
    } catch {
      // A static export writes /index.html and nothing else routes; anything
      // missing falls back to it so a deep link still boots the app.
      path = join(OUT, 'index.html')
    }

    try {
      const body = await readFile(path)
      response.writeHead(200, {
        'content-type': MIME[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      })
      response.end(body)
    } catch {
      response.writeHead(404).end('not found')
    }
  })

  await new Promise((done) => server.listen(PAGE_PORT, '127.0.0.1', done))
  return server
}

// ── driving the browser ────────────────────────────────────────────────────

const CLI = resolve(process.cwd(), 'node_modules', 'agent-browser', 'bin', 'agent-browser.js')
const SESSION = process.env.STAGING_BROWSER_SESSION ?? 'jmc-gate'

/**
 * One agent-browser command.
 *
 * The CLI keeps a named browser session alive between invocations, so this is
 * a sequence of short processes against one long-lived Chrome rather than a
 * browser per step.
 */
export function ab(args, { allowFailure = false, timeout = 120_000 } = {}) {
  try {
    return execFileSync('node', [CLI, '--session', SESSION, ...args], {
      encoding: 'utf8',
      timeout,
      // stdin must be a pipe, not 'ignore'. With 'ignore' the CLI exits 0 and
      // execFileSync sits there until its timeout anyway — measured: status 0,
      // ETIMEDOUT. Something downstream keeps the descriptor set open, and the
      // symptom is a suite that appears to hang on its first command.
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch (error) {
    if (allowFailure) return String(error.stdout ?? '') + String(error.stderr ?? '')
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`agent-browser ${args.join(' ')} failed:\n${detail || error.message}`)
  }
}

/** Several commands down one process, which on Windows is most of the runtime. */
export function abBatch(commands, options) {
  return ab(['batch', '--bail', ...commands], options)
}

/**
 * Launch Chrome once, before anything is asked of it.
 *
 * The first command in a session pays for the browser starting, and on a cold
 * cache that can outlast a per-command timeout — which then reports itself as
 * "set viewport failed", pointing at the viewport rather than at the launch.
 * Getting it over with here means every later timeout means what it says.
 */
let launched = false
export function launchBrowser() {
  if (launched) return ''
  launched = true
  // allowFailure, because `open` with no URL leaves the CLI holding its pipes
  // open after a clean exit and execFileSync reports a timeout for a command
  // that plainly worked — the output says "launched browser" underneath the
  // error. A genuine failure to launch surfaces on the first real navigation
  // a moment later, with a message about that instead.
  return ab(['open'], { timeout: 180_000, allowFailure: true })
}

export const viewport = (width, height) => ab(['set', 'viewport', String(width), String(height)])
export const open = (path = '/') => ab(['open', `${PAGE_URL}${path}`])
export const text = (selector) => ab(['get', 'text', selector], { allowFailure: true })
export const pageText = () => ab(['read'], { allowFailure: true })
export const snapshot = (extra = []) => ab(['snapshot', ...extra], { allowFailure: true })
export const evaluate = (js) => ab(['eval', js], { allowFailure: true })
export const closeBrowser = () => ab(['close'], { allowFailure: true })

/**
 * Wait until an expression is truthy, polling the page.
 *
 * The clinic talks to its backend on almost every action and a fixed sleep is
 * either slow or flaky; this is neither. It returns the last value so a
 * failure can say what it saw rather than only that it timed out.
 */
export async function waitFor(js, { timeout = 15_000, every = 250, what = js } = {}) {
  const until = Date.now() + timeout
  let last = ''
  while (Date.now() < until) {
    last = evaluate(js)
    if (last && !/^(false|null|undefined|0|)$/i.test(last.trim())) return last
    await new Promise((done) => setTimeout(done, every))
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${what}\nlast value: ${last}`)
}

/** The staging fixtures, so a journey can address a known person or patient. */
export function fixtures() {
  const path = resolve(process.cwd(), 'scripts', 'staging', 'fixtures.mjs')
  if (!existsSync(path)) throw new Error('scripts/staging/fixtures.mjs is missing')
  readFileSync(path) // fail loudly here rather than inside a dynamic import
  return import(new URL(`file:///${path.replace(/\\/g, '/')}`).href)
}
