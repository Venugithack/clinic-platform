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

  // There is no Auth server here and there does not need to be: the anon key
  // already carries the device's role and subject, which is what the JWT would
  // have said anyway.
  //
  // But the answer has to be one supabase-js UNDERSTANDS. A bare 404 is not:
  // GoTrue treats it as a transient failure, retries the token refresh with
  // backoff, and holds its session lock while it does. Every later .from() and
  // .rpc() then queues behind that lock and simply never resolves — no request
  // issued, no error, a button stuck on "Selling…". Answering the way a real
  // auth server answers an anonymous client makes it give up immediately.
  if (path.startsWith('/auth/') || clientReq.url.startsWith('/auth/')) {
    const isToken = clientReq.url.includes('/token');
    clientRes.writeHead(isToken ? 400 : 401, { 'content-type': 'application/json' });
    clientRes.end(
      isToken
        ? '{"error":"invalid_grant","error_description":"no local auth server; the anon key is the device session"}'
        : '{"code":401,"message":"no local auth server; the anon key is the device session"}',
    );
    return;
  }

  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port: PGRST_PORT,
      path,
      method: clientReq.method,
      headers: clientReq.headers,
      // No connection pooling. A reused socket that desyncs surfaces as a
      // nonsense status ("Invalid status code: 3") and, unguarded, takes the
      // whole dev stack down mid-test-run — where it reads as "cannot reach the
      // clinic database" in some unrelated test, which is a long way from the
      // cause. A dev proxy has no use for keep-alive anyway.
      agent: false,
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode;
      const valid = Number.isInteger(status) && status >= 100 && status <= 599;

      // Strip hop-by-hop headers. Forwarding `transfer-encoding: chunked`
      // verbatim makes Node frame the body a second time, and the response
      // never completes: the browser's fetch hangs forever, so a failing RPC
      // neither resolves nor rejects and a button sits on "Selling…". The
      // successful path survives it, which is what made this look like a
      // product bug in one screen rather than proxy hygiene missing from all
      // of them. It is also what desynced a pooled socket into the earlier
      // "Invalid status code: 3" crash.
      const headers = { ...upstreamRes.headers };
      for (const hop of [
        'transfer-encoding',
        'connection',
        'keep-alive',
        'upgrade',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
      ]) {
        delete headers[hop];
      }

      try {
        clientRes.writeHead(valid ? status : 502, headers);
      } catch {
        clientRes.destroy();
        return;
      }
      upstreamRes.pipe(clientRes);
    },
  );

  upstream.on('error', (error) => {
    if (clientRes.headersSent) {
      clientRes.destroy();
      return;
    }
    clientRes.writeHead(502, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ message: error.message }));
  });

  clientReq.on('error', () => upstream.destroy());
  clientReq.pipe(upstream);
});

proxy.on('clientError', (_error, socket) => socket.destroy());

// One malformed exchange must not end the stack. Everything downstream of a
// dead dev API fails in a way that points somewhere else entirely.
process.on('uncaughtException', (error) => {
  console.error(`dev API: recovered from ${error.message}`);
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

// The LISTEN connection, and why it reconnects.
//
// db-reset.sh drops the database `with (force)`, which terminates every
// backend on it — this one included. Nothing about that is visible from the
// app: the screens keep loading, PostgREST reconnects on its own, and the only
// thing that stops working is the doctor-to-counter link, silently. A signed
// prescription simply never appears at the counter, which looks exactly like a
// quiet afternoon.
//
// dev-stack.sh restarts this process on every reset, so the sanctioned path
// never met it. Running the pgTAP suite against a live stack does: `pnpm
// test:db` resets underneath it, and the next thing to fail is a live-link
// test with a timeout and no explanation.
let listener = null;
let shuttingDown = false;

async function listen() {
  listener = new pg.Client({
    host: '127.0.0.1',
    port: Number(PG_PORT),
    user: PG_USER,
    database: PG_DB,
  });

  // A dropped LISTEN is the expected case here, not an exception. Without a
  // handler the 'error' event is an unhandled rejection that takes the whole
  // dev API down with it.
  listener.on('error', () => {});
  listener.on('end', reconnect);

  listener.on('notification', (message) => {
    if (!message.payload) return;
    for (const client of realtime.clients) {
      if (client.readyState === 1) client.send(message.payload);
    }
  });

  await listener.connect();
  await listener.query('listen clinic_changes');
}

let reconnecting = false;

function reconnect() {
  if (reconnecting || shuttingDown) return;
  reconnecting = true;
  // Half a second is long enough for db-reset.sh to finish rebuilding the
  // schema and short enough that a developer does not notice the gap.
  setTimeout(async () => {
    reconnecting = false;
    try {
      await listen();
      console.log('realtime: reconnected to the database');
    } catch {
      reconnect();
    }
  }, 500);
}

await listen();

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
  shuttingDown = true;
  pgrst.kill();
  if (listener) void listener.end();
  proxy.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
