/**
 * Serves the built static export for the browser gate.
 *
 * A separate process rather than a function call, so the gate runner can kill
 * it cleanly and so the server outlives the test process that drives it. The
 * refusal to serve a bundle built against the live clinic lives in the
 * harness, and runs before this listens.
 */
import { startPageServer, PAGE_URL } from '../../tests/browser/support/harness.mjs'

const server = await startPageServer()
console.log(`serving out/ at ${PAGE_URL}`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(); process.exit(0) })
}
