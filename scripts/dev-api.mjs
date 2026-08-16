#!/usr/bin/env node
/**
 * A local REST API in front of the development database.
 *
 * BUILD.md §1.2 wants `supabase start` — Postgres, Auth, Realtime and Studio in
 * Docker — and that is what the clinic dev machine should run. This script is
 * the same API surface for environments where Docker is not available or not
 * worth several gigabytes of images: PostgREST against the same Postgres, with
 * the same JWT shape and the same `/rest/v1` path, so lib/db cannot tell the
 * difference and nothing in the app is written against a stand-in.
 *
 * What it wires that matters beyond convenience:
 *
 *   db-pre-request = app.pre_request  lifts x-staff-session into the GUC that
 *                                     names the person for every audit row
 *   db-schemas     = public, app      the transitions live in `app`
 *
 * Not a production artefact. It mints its own JWTs and trusts the local socket.
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { WebSocketServer } from 'ws';

const PG_PORT = process.env.PGPORT ?? '54329';
const PG_DB = process.env.PGDATABASE ?? 'clinic';
const PG_USER = process.env.PGUSER ?? 'postgres';
const PGRST_BIN = process.env.PGRST_BIN ?? 'postgrest';
const PGRST_PORT = Number(process.env.PGRST_PORT ?? 54322);
const PUBLIC_PORT = Number(process.env.DEV_API_PORT ?? 54321);

// Stable across restarts so a browser session survives one, but never a secret
// that leaves this machine.
const JWT_SECRET =
  process.env.DEV_JWT_SECRET ?? 'clinic-local-development-secret-not-for-production';

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function signJwt(payload) {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url({ ...payload, iat: Math.floor(Date.now() / 1000), exp: 2000000000 });
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function psql(sql) {
  return execFileSync(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-tA', '-h', '127.0.0.1', '-p', PG_PORT, '-U', PG_USER, '-d', PG_DB, '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

// ---------------------------------------------------------------------------
// The authenticator role. PostgREST connects as this and SET ROLEs to anon or
// to authenticated depending on the JWT — which is exactly how Supabase does
// it, so RLS behaves identically here and there.
// ---------------------------------------------------------------------------
psql(`
  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'authenticator') then
      create role authenticator noinherit login;
    end if;
  end $$;
  grant anon, authenticated to authenticator;
`);

// The device's own auth user: the doctor from the seed. On a real deployment
// this is a Supabase Auth user; the PIN session on top of it names the person.
const doctorAuthUid =
  psql(`select auth_user_id from staff where role = 'doctor' order by name limit 1`) ||
  '00000000-0000-0000-0000-000000000000';

const anonKey = signJwt({ role: 'authenticated', sub: doctorAuthUid });

const confPath = join(tmpdir(), 'clinic-postgrest.conf');
writeFileSync(
  confPath,
  [
    `db-uri = "postgres://authenticator@127.0.0.1:${PG_PORT}/${PG_DB}"`,
    `db-schemas = "public,app"`,
    `db-anon-role = "anon"`,
    `db-pre-request = "app.pre_request"`,
    `jwt-secret = "${JWT_SECRET}"`,
    `server-port = ${PGRST_PORT}`,
    `server-host = "127.0.0.1"`,
    `log-level = "warn"`,
  ].join('\n'),
);

const pgrst = spawn(PGRST_BIN, [confPath], { stdio: ['ignore', 'inherit', 'inherit'] });

pgrst.on('error', (error) => {
  console.error(`could not start PostgREST (${PGRST_BIN}): ${error.message}`);
  process.exit(1);
});

// If PostgREST dies — most often because an orphan from a previous run still
// holds the port — take the whole stack down with it. The alternative is this
// proxy happily forwarding to somebody else's PostgREST, serving a schema cache
// from before the latest migration.
pgrst.on('exit', (code) => {
  console.error(`PostgREST exited (${code}); shutting down so nothing answers in its place`);
  process.exit(1);
});

// Kill the child on every path out, not just the signal handlers. A SIGKILL to
// this process leaves PostgREST orphaned and holding port 54322.
process.on('exit', () => pgrst.kill());

// ---------------------------------------------------------------------------
// supabase-js posts to `${url}/rest/v1/...`; PostgREST serves at the root. The
// prefix is stripped here rather than in lib/db, so the client code is written
// against the real Supabase URL shape.
// ---------------------------------------------------------------------------
const proxy = createServer((clientReq, clientRes) => {
  const path = clientReq.url.replace(/^\/rest\/v1/, '') || '/';

  // supabase-js checks for a session on init. There is no Auth server here and
  // there does not need to be: the anon key already carries the device's role
  // and subject, which is what the JWT would have said anyway.
  if (path.startsWith('/auth/') || clientReq.url.startsWith('/auth/')) {
    clientRes.writeHead(404, { 'content-type': 'application/json' });
    clientRes.end('{"message":"no local auth server; the anon key is the device session"}');
    return;
  }

  const upstream = httpRequest(
    { host: '127.0.0.1', port: PGRST_PORT, path, method: clientReq.method, headers: clientReq.headers },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    },
  );

  upstream.on('error', (error) => {
    clientRes.writeHead(502, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ message: error.message }));
  });

  clientReq.pipe(upstream);
});

// ---------------------------------------------------------------------------
// Realtime, over LISTEN/NOTIFY.
//
// This is the WebSocket half of HOSTING.md §7: "Realtime behind one adapter —
// swap for a WS server without touching a screen." lib/realtime's websocket
// adapter connects here, and the screens cannot tell it from Supabase Realtime.
//
// The relay forwards the notification verbatim — table, op and id, nothing
// more. Row data would bypass RLS on its way to the browser; the client is told
// that something changed and re-reads it through lib/db.
// ---------------------------------------------------------------------------
const realtime = new WebSocketServer({ noServer: true });

proxy.on('upgrade', (request, socket, head) => {
  if (!request.url?.startsWith('/realtime')) {
    socket.destroy();
    return;
  }
  realtime.handleUpgrade(request, socket, head, (client) => {
    realtime.emit('connection', client, request);
  });
});

const listener = new pg.Client({
  host: '127.0.0.1',
  port: Number(PG_PORT),
  user: PG_USER,
  database: PG_DB,
});

await listener.connect();
await listener.query('listen clinic_changes');

listener.on('notification', (message) => {
  if (!message.payload) return;
  for (const client of realtime.clients) {
    if (client.readyState === 1) client.send(message.payload);
  }
});

proxy.listen(PUBLIC_PORT, '127.0.0.1', () => {
  console.log(`dev API   http://127.0.0.1:${PUBLIC_PORT}`);
  console.log(`realtime  ws://127.0.0.1:${PUBLIC_PORT}/realtime`);
  console.log(`anon key  ${anonKey}`);
  console.log('');
  console.log('Put these in .env.local:');
  console.log(`  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:${PUBLIC_PORT}`);
  console.log(`  NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}`);
  console.log(`  NEXT_PUBLIC_REALTIME_WS_URL=ws://127.0.0.1:${PUBLIC_PORT}/realtime`);
});

const shutdown = () => {
  pgrst.kill();
  void listener.end();
  proxy.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
