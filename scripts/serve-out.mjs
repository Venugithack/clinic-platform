#!/usr/bin/env node
/**
 * Serve `out/` the way Cloudflare will serve it.
 *
 * `next start` cannot: with `output: 'export'` there is no server build for it
 * to run, and it refuses with "next start does not work with output: export".
 * The E2E suite still needs something on :3000, and what it needs is not "any
 * static server" — it is one that resolves paths by the same rules as the host,
 * or the suite proves the app works under semantics production does not have.
 *
 * So the three rules here are wrangler.jsonc's, deliberately:
 *
 *   /            -> index.html
 *   /queue       -> queue.html      (Workers' html_handling, which is why the
 *                                    export's five query-string screens resolve
 *                                    at all: /consult is a FILE, not a route)
 *   anything else-> 404.html, status 404, NOT index.html
 *
 * That last one is the reason this is a file rather than `npx serve out`.
 * A server that falls back to index.html turns every 404 into a lock screen
 * with a 200, which is exactly the behaviour wrangler.jsonc rejects
 * ("not_found_handling": "404-page") — and a suite that ran against an SPA
 * fallback would pass while a mistyped URL on the tablet showed a working app.
 *
 * Zero dependencies on purpose: `npx serve@latest` is a network fetch on every
 * CI run, which is a flake and a delay in exchange for behaviour we do not
 * actually want.
 *
 * Not a production artefact. Cloudflare serves the real thing.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
// Explicit rather than the global: these scripts lint under Node globals that
// predate WHATWG URL being one, and an import says where it comes from anyway.
import { URL } from 'node:url';

const ROOT = join(process.cwd(), 'out');
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

async function resolve(pathname) {
  // Reject traversal before touching the disk. `normalize` collapses `..`, and
  // anything still pointing outside `out/` afterwards is not a typo.
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const target = join(ROOT, clean);
  if (!target.startsWith(ROOT)) return null;

  const candidates = target.endsWith('/')
    ? [join(target, 'index.html')]
    : [target, `${target}.html`, join(target, 'index.html')];

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Next candidate.
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const file = (await resolve(pathname === '/' ? '/index.html' : pathname));

  if (file) {
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
    return;
  }

  const notFound = await resolve('/404.html');
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  if (notFound) createReadStream(notFound).pipe(res);
  else res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`serving out/ at http://${HOST}:${PORT}`);
});
