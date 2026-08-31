import postgres from 'npm:postgres@3.4.5'

/**
 * The names on the lock screen — the first function ported, and the one that
 * proves the shape.
 *
 * ── WHY THIS IS HERE AND NOT ON CLOUDFLARE ──────────────────────────────────
 *
 * The same route ran as a Cloudflare Worker and failed roughly two sign-ins in
 * five: Workers allow about ten milliseconds of CPU per request and scrypt
 * needs a hundred, so the runtime cancelled the request as hung. Supabase Edge
 * Functions allow two seconds. The PIN hash is no longer near the limit.
 *
 * Three other things fall away by being here rather than there. The database is
 * local to this function, so there is no Hyperdrive gateway in between. A
 * direct connection carries `search_path` in its startup parameters, which
 * Hyperdrive dropped — so the schema does not have to be forced onto the
 * postgres role. And SUPABASE_DB_URL is injected by the platform, so there is
 * no connection string to keep anywhere.
 */

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, {
  prepare: false,
  max: 2,
  idle_timeout: 20,
  // The thing Hyperdrive would not do. Every unqualified name in this function
  // resolves inside `jmc`, never in `public`, which is where the previous
  // application's 74 tables live — eight of them with these same names.
  connection: { search_path: 'jmc' },
})

// The page is served from another origin (static files on Cloudflare), so the
// browser preflights anything with a header on it.
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const rows = await sql`
      select id, name, roles_json
      from staff
      where active = 1
      order by name`

    return json({
      ok: true,
      staff: rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        roles: JSON.parse(String(row.roles_json)) as string[],
      })),
    })
  } catch (error) {
    console.error('lock screen staff query failed:', error)
    return json({ ok: false, message: 'The clinic database is not reachable.' }, 503)
  }
})
