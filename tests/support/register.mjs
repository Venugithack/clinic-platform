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
  /*
   * The smallest Deno that runs this backend.
   *
   * `env` is what db.ts, auth.ts and whatsapp.ts read. The four file
   * operations arrived with Slice 5: `storage.ts` writes clinical images to
   * private object storage, and its local backend — the one staging uses,
   * because staging has no Supabase — is Deno's filesystem API. Mapping them
   * to node:fs keeps the backend file itself unchanged, which is the whole
   * point of this shim: production code must never know it is being tested.
   *
   * Anything NOT listed here still throws a clear ReferenceError naming the
   * method, rather than pretending.
   */
  const fs = await import('node:fs/promises')
  class NotFound extends Error {}

  globalThis.Deno = {
    env: {
      get: (key) => process.env[key],
      set: (key, value) => { process.env[key] = value },
      has: (key) => key in process.env,
      toObject: () => ({ ...process.env }),
    },
    errors: { NotFound },
    mkdir: (path, options) => fs.mkdir(path, options),
    writeFile: async (path, data, options) => {
      // `createNew` is Deno's spelling of O_EXCL, and it is load-bearing: a
      // storage key is generated once and an upload that collides is a bug,
      // never something to resolve in favour of whichever arrived second.
      await fs.writeFile(path, data, { flag: options?.createNew ? 'wx' : 'w' })
    },
    readFile: async (path) => {
      try {
        return new Uint8Array(await fs.readFile(path))
      } catch (error) {
        if (error?.code === 'ENOENT') throw new NotFound(String(error.message))
        throw error
      }
    },
    remove: async (path) => {
      try {
        await fs.rm(path, { recursive: false })
      } catch (error) {
        if (error?.code === 'ENOENT') throw new NotFound(String(error.message))
        throw error
      }
    },
  }
}

register('./deno-compat-hooks.mjs', import.meta.url)
