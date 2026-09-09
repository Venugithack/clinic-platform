# Jayamurugan Clinic

One doctor, one clinic, one in-house pharmacy, four tablets. Queue and consults
in the cabin, dispensing and stock at the counter, billing, suppliers, the
Schedule H1 register, and a stock-take that does not tell you the answer before
you count.

**This document describes the application that is in this repository now.** It
used to describe a different one — a Next server with RLS, plpgsql transitions,
509 pgTAP assertions, Playwright gates and a bash dev-stack. That application
was deleted. It is in the git history and nowhere else. If you are reading a
sentence in `docs/` about `lib/db/`, `lib/offline/`, device tokens in
localStorage or `pnpm test`, you are reading about the dead one; see
[The rest of this folder](#the-rest-of-this-folder).

---

## 1. Two halves, and why

The application is two programs that never share a process:

| | | |
|---|---|---|
| **the page** | `app/`, `components/`, `lib/` | a **static export**. `next build` writes plain HTML, CSS and JavaScript to `out/`; Cloudflare serves those files. Nothing runs behind them |
| **the backend** | `supabase/` | **Deno**. Nine Edge Functions deployed beside the database, talking to Postgres directly |

That split is not taste. Each half of it was forced, and each reason is a
failure that already happened. The prose at the top of `next.config.ts`,
`wrangler.jsonc`, `lib/api.ts`, `supabase/functions/_shared/http.ts`,
`supabase/functions/_shared/db.ts` and `supabase/functions/staff/index.ts` is
the long version; this is the short one.

**The page is static because the hosting has to be free.** A server that runs
code on every request is the one thing free hosting will not do. Static files
cost nothing to serve and always will.

**The backend is not on Cloudflare because scrypt does not fit in a Worker.**
The same sign-in route ran as a Cloudflare Worker and failed roughly two
attempts in five, and got worse the more people used it at once: a Worker is
allowed about ten milliseconds of CPU per request and hashing one PIN needs a
hundred, so the runtime cancelled the request as hung. Supabase Edge Functions
allow two seconds. Nothing about the hashing changed — same algorithm, same
cost parameters, same stored hashes — only where it runs.

**The backend is not behind Hyperdrive because Hyperdrive drops `search_path`.**
A direct Postgres connection carries `search_path` in its startup parameters and
it stays set. Through the Hyperdrive gateway it did not, and the application
quietly read the *previous* application's tables. Which brings up the next one.

**Everything is in the `jmc` schema, not `public`.** The database is shared with
the retired application, whose 74 tables live in `public`, and **eight names
collide**: `staff`, `patients`, `bills`, `appointments`, `vitals`,
`prescriptions`, `encounters`, `suppliers`. A connection that resolves an
unqualified `staff` to the wrong schema does not error. It answers.

**The session token is in `localStorage`, not a cookie.** The page is on one
origin and the functions are on another, so a cookie set by a function would be
a third-party cookie — blocked outright by Safari and being retired by Chrome. A
tablet would sign in, appear to work, and be signed out on its next request,
which is the sort of fault that gets blamed on the wifi for a fortnight. The
trade is real and worth stating: an httpOnly cookie cannot be read by
JavaScript and this can, so anything that manages to run script on the page can
take the token. What it buys is a session that works on every browser a clinic
actually owns. The token is short-lived, revocable from the `sessions` table,
and dies on sign-out.

### How the halves talk

Every request goes to `NEXT_PUBLIC_FUNCTIONS_URL` with
`Authorization: Bearer <token>`. There are nine endpoints:

| Function | |
|---|---|
| `staff` | the names on the lock screen. Deliberately unauthenticated, so it selects a name and its roles and nothing else |
| `login` · `logout` | PIN sign-in, 30-minute idle expiry |
| `bootstrap` | the first administrator, and only ever the first — it refuses the instant `staff` holds anything at all |
| `snapshot` | the whole clinic as one object |
| `command` | everything that changes something |
| `record` | one patient's history, fetched when somebody opens that patient |
| `register` | the Schedule H1 register for a date range |
| `csv` | the drug master, in and out |

Two properties are worth knowing before you change either half.

**The tablets poll `snapshot?since=<revision>` every fifteen seconds** and get
`{ unchanged: true }` when nothing has happened, which is the usual answer. The
revision is one row in `clinic_revision`, bumped inside the same transaction as
the write. It is read *before* the snapshot, deliberately: read after, a write
landing mid-read would be in the data *and* counted in the revision the tablet
stores, and that tablet would never ask for the change again.

**`command` returns the new snapshot in its own response.** The screen used to
fetch it in a second request, so every tap in the clinic cost two round trips
to Mumbai and back with the button busy through both.

---

## 2. What is actually here

```
app/                    layout, one page, the web manifest — the whole route tree
components/             ClinicApp (the chrome and the ten workspaces) and ui/
lib/
  api.ts                the ONLY thing that talks to the backend; token handling
  order-status.ts       delivery state and reorder quantity — pure, and tested
  types.ts              the snapshot's shape, mirrored from the backend by hand
public/
  _headers              the four security headers, applied by Cloudflare —
                        a static export has no server to set them
supabase/
  functions/
    _shared/            auth · commands (the large one) · db · http · password ·
                        snapshot · types · whatsapp · order-status
    <nine dirs>/        index.ts each, one Deno.serve per endpoint
  migrations/           forward-only SQL, named by timestamp. Creates `jmc`
scripts/
  set-db-url.mjs        writes DATABASE_URL into .env.local without it passing
                        through a shell whose quoting rules you have to guess
tests/                  two files. This is the entire automated suite
archive/                material excluded from the build and runtime; see its README
next.config.ts          output: 'export'
wrangler.jsonc          no `main`, no Worker — an assets directory and a domain
```

Retired projects, mockups, the old SQLite database, database dumps, and
environment backups are under `archive/local/`. That directory is gitignored,
and `tsconfig.json` excludes the entire archive. See
[`archive/README.md`](../archive/README.md) for the exact boundary.

Roles are `admin`, `doctor`, `nurse`, `pharmacy`. A staff member can hold more
than one.

---

## 3. Running it

```bash
npm ci
npm run dev          # http://localhost:3000, and on the LAN — it binds 0.0.0.0
```

```bash
npm run typecheck    # tsc --noEmit. Covers the page. NOT the backend — see §5
npm test             # node --test, the two files in tests/
npm run build        # writes out/
```

`npm run preview` (or `npm start`) serves the built `out/` directory through
Wrangler on `http://localhost:3000`. Run `npm run build` first.

### The trap: there is no local backend

This repository has no `supabase/config.toml` — it was deleted with the retired
application — so `supabase start` and `supabase functions serve` are not set up
here, and there is no local Postgres, no seed and no offline stack of any kind.

What that means in practice is worth being blunt about: **`npm run dev` points
at whatever `NEXT_PUBLIC_FUNCTIONS_URL` says, and today that is the deployed
functions, which are in front of the clinic's live database.** Local development
is not a sandbox. A command you send from `localhost:3000` while trying
something out registers a real patient, moves real stock, or takes a real
batch off the shelf.

There is no guard against this in the code. Check what `.env.local` points at
before you start clicking, and be aware that `.env.production.local`, if one
exists on your machine, overrides `.env.local` for `npm run build`.

---

## 4. Environment

`.env.example` is the documented template; copy it to `.env.local`, which is
gitignored. `NEXT_PUBLIC_FUNCTIONS_URL` is required and should be the deployed
functions base ending in `/functions/v1`. Being `NEXT_PUBLIC_`, it is **baked
into the bundle at build time**, not read at runtime.

`DATABASE_URL` is read by no part of the application. The Edge Functions
read `SUPABASE_DB_URL`, which the platform injects, so there is no connection
string to keep or leak. `DATABASE_URL` in `.env.local` is now only for pointing
a CLI or a `psql` at the database by hand, and it is what
`node scripts/set-db-url.mjs` writes.

The first administrator's PIN is chosen in the request to `bootstrap`; there is
no `CLINIC_ADMIN_PIN` environment variable.

What the functions actually read, all through `Deno.env`:

| | |
|---|---|
| `SUPABASE_DB_URL` | injected by Supabase. Nothing to set |
| `CLINIC_SESSION_SECRET` | **required.** `auth.ts` refuses to start without it — unconditionally, with no development fallback, because the previous guard was `NODE_ENV === 'production'` and an Edge Function never sets that, so every deployment hashed its session tokens with a secret published in the source. Set it on the deployed functions: `npx supabase secrets set CLINIC_SESSION_SECRET=...` |
| `WHATSAPP_*` | five values. Until all of them exist the application keeps real send controls disabled and never reports a message as sent. Drafting still works |

---

## 5. Deploying

The two halves deploy separately, by different tools, and neither is wired to
CI. Nothing in `.github/workflows/` deploys anything.

**The page.** `npm run build`, then `npx wrangler deploy` — `wrangler.jsonc`
has no `main`, so this uploads `out/` as static assets and binds
`app.jayamuruganclinic.online`. `wrangler` is a devDependency, so `npx` uses the
pinned copy. Remember §4: the `NEXT_PUBLIC_FUNCTIONS_URL` in the environment at
`npm run build` time is the one the tablets will use.

**The backend.** The Supabase CLI is **not** a dependency of this repository, so
`npx supabase ...` fetches it, and with no `supabase/config.toml` it has no
project to act on until you link one (`npx supabase link --project-ref <ref>`)
or pass `--project-ref` to each command. Migrations go up with
`npx supabase db push`; each function with
`npx supabase functions deploy <name>`. Secrets with
`npx supabase secrets set`.

Those Supabase commands are written from the CLI's documented interface and
from what the repository requires. **They have not been run from a clean
checkout while writing this**, and the missing `config.toml` is the part most
likely to bite. Treat them as the right shape rather than as a script.

---

## 6. What is not covered

The honest list, because the previous version of this file claimed a test suite
that no longer exists and sent people looking for it.

**There is no database test suite.** No pgTAP, no fixtures, no seed. Nothing
anywhere applies a migration or asserts that a query names a column that exists.
The SQL in `supabase/migrations/` is checked by running it.

**There is no end-to-end test.** No Playwright, no browser automation, no gate.
Nothing proves a tablet can sign in, that a prescription reaches the counter, or
that a bill prints. Every claim in §1 about how the halves talk is a claim about
code that has been read, not code that has been exercised by a test.

**`tests/` is two files and four tests** — `password.test.ts` and
`order-status.test.ts`. `password.test.ts` is the interesting one: it runs the
backend's *own* `_shared/password.ts` under Node, which works only because that
file uses nothing but `node:crypto`, and it asserts that hashing does not block
the event loop — the exact property whose absence killed sign-in on Cloudflare.

**`npm run typecheck` does not see the backend.** `tsconfig.json`'s `exclude`
list contains `"supabase"`, so `tsc` never opens an Edge Function. CI covers
this with a separate step; to run it yourself:

```bash
shopt -s globstar
deno check --node-modules-dir=none supabase/functions/**/*.ts
```

`--node-modules-dir=none` is not optional. Without it Deno finds the repository
root's `package.json` and `node_modules` — the page's, not the functions' — and
tries to resolve `npm:postgres` and `npm:csv-parse` out of a tree that has never
held either, failing before it typechecks a line. Deno is not a dependency here;
install it separately.

**CI checks four things and nothing else**: the page's types, the two unit
tests, that the export builds, and the backend's types. See the comment at the
top of `.github/workflows/ci.yml`, which says the same thing at the point where
somebody might otherwise assume more.

**Automated off-site backups are not configured.** The retired workflow called
`scripts/ci-pgdg.sh`, `scripts/db-backup.sh`, `scripts/db-start.sh` and
`scripts/db-restore-drill.sh`, none of which exist any more. It has been disabled
and preserved at `archive/github-workflows/backup.yml`. Therefore **the off-site
encrypted backups described in `../archive/docs/HOSTING.md` §5 are not
happening**, and neither is the restore drill.

---

## 7. The rest of this folder

The retired application's documents now live under `../archive/docs/`. Some are
still valuable because the design reasoning did not stop being true when the
code changed, but they are historical context rather than operating
instructions.

| File | State |
|---|---|
| `../archive/docs/PLAN.md` · `../archive/docs/PROPOSAL.md` | pre-build design and the client proposal. The *product* reasoning still holds. The architecture (RLS, plpgsql transitions, Supabase Realtime) describes the retired application |
| `INVENTORY.md` | the unit model, FEFO, costing, the expiry return window. **Still the reference.** Almost entirely design, almost nothing implementation |
| `WHATSAPP.md` | Meta policy and the deep-link route. Still applies, and independent of either architecture. Verify the policy dates against Meta rather than this file |
| `TABLET.md` | the interaction brief. Still useful; its auth section describes device tokens, which are gone |
| `../archive/docs/HOSTING.md` | the ₹0 argument. The conclusion held; the route changed completely (Workers, then the split in §1). **§5's backups are described as running and are not** — see §6 |
| `../archive/docs/BUILD.md` | 85 KB of milestone-by-milestone build log for the retired application. Every command, path and gate in it is dead. History, not instructions |
| `../archive/docs/GO_LIVE.md` | a cutover runbook whose first step is `pnpm test:go-live`, a script that does not exist |
| `../archive/docs/REVIEW.md` | a consistency review of documents that have since been superseded twice |
| `../archive/docs/NEXT.md` | a session handover from 29 Aug 2026. Accurate about that morning; overtaken by the rewrite |

The root `README.md` is now the short entry point for setup, commands, project
structure, and deployment. This document remains the detailed source of truth.
