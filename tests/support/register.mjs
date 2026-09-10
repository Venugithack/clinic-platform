/**
 * `node --import ./tests/support/register.mjs` — the backend, under Node.
 *
 * Two things stand between `node --test` and the Edge Functions' source: the
 * `npm:` specifiers (see deno-compat-hooks.mjs) and the `Deno` global. Both are
 * fixed here rather than in the backend, because the backend must keep running
 * on Deno unchanged; a test harness that requires production code to know it is
 * being tested is a harness that stops matching production.
 *
 * The Deno shim is deliberately the smallest thing that works — `Deno.env.get`,
 * reading process.env. That is the only Deno API the shared backend files use
 * (db.ts for SUPABASE_DB_URL, auth.ts for CLINIC_SESSION_SECRET, whatsapp.ts
 * for its five). If a future file reaches for Deno.serve or Deno.readFile, this
 * throws a clear ReferenceError naming the method rather than pretending.
 */
import { register } from 'node:module'

if (!('Deno' in globalThis)) {
  globalThis.Deno = {
    env: {
      get: (key) => process.env[key],
      set: (key, value) => { process.env[key] = value },
      has: (key) => key in process.env,
      toObject: () => ({ ...process.env }),
    },
  }
}

register('./deno-compat-hooks.mjs', import.meta.url)
