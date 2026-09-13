# Jayamurugan Clinic

One doctor, one clinic, one in-house pharmacy, four tablets. Queue and consults
in the cabin, dispensing and stock at the counter, billing, suppliers, the
Schedule H1 register, and a stock-take that does not tell you the answer before
you count.

**This document describes the application that is in this repository now.** It
is the first document for a person or AI agent to read. Use the map below to
find the current decision source for the task instead of treating every plan as
equally current.

## Documentation map

### Current core documents

| Document | Use it for |
|---|---|
| **This file** | Current architecture, runtime, setup, deployment, tests, and known gaps |
| [`UI_UX_PLAN.md`](UI_UX_PLAN.md) | Target role workspaces, prescription-counter flow, loading, completion feedback, windows, icons, themes, and UI acceptance gates |
| [`OWNER_POLICY_REGISTER.md`](OWNER_POLICY_REGISTER.md) | Owner-approved clinic and product policy; this is authoritative when a workflow depends on an owner decision |
| [`SCHEMA_AND_TYPES.md`](SCHEMA_AND_TYPES.md) | Current database, API, and shared type contract |
| [`AGENT_IMPLEMENTATION_BRIEF.md`](AGENT_IMPLEMENTATION_BRIEF.md) | Implementation constraints, slice order, safety boundaries, invariants, and definition of done |

### Read by task

| Task | Read next |
|---|---|
| UI/UX or a doctor, nurse, pharmacy, or admin workspace | `UI_UX_PLAN.md`, then the relevant material in [`reference/`](reference/) and the interactive files in [`design/`](design/) |
| Clinical vocabulary or medicine identity | [`reference/CLINICAL_TERMINOLOGY_AND_MEDICINE_DATA_RESEARCH.md`](reference/CLINICAL_TERMINOLOGY_AND_MEDICINE_DATA_RESEARCH.md) |
| Packages, stock, FEFO, costing, or expiry | [`reference/INVENTORY.md`](reference/INVENTORY.md) plus the medicine-identity research |
| Tablet hardware or touch interaction | [`reference/TABLET.md`](reference/TABLET.md); current interface decisions still come from `UI_UX_PLAN.md` |
| WhatsApp | [`reference/WHATSAPP.md`](reference/WHATSAPP.md), with time-sensitive policy rechecked before release |
| Staging, rollout, or PIN recovery | The applicable runbook in [`operations/`](operations/) |
| Product rationale from the design sessions | [`reference/PRODUCT_UX_DISCOVERY.md`](reference/PRODUCT_UX_DISCOVERY.md); later core documents take precedence |
| Why an earlier decision was raised | [`../archive/docs/current-programme/`](../archive/docs/current-programme/) |
| Comparing the simpler earlier interface | `hospital al in one platform/`, when that local reference folder is present |

### When documents differ

1. Source code, migrations, and tests show what the application does now.
2. `OWNER_POLICY_REGISTER.md` records approved product policy.
3. `UI_UX_PLAN.md` records the target interface and workflow.
4. `SCHEMA_AND_TYPES.md` and `AGENT_IMPLEMENTATION_BRIEF.md` define the current
   technical contract and delivery constraints.
5. `reference/` explains specialist research and earlier discovery.
6. `archive/` and `hospital al in one platform/` preserve history and comparison
   material.

If two current sources still conflict, record and resolve the conflict instead
of silently choosing one.

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

## 6. What is covered, and what is not

This section has been wrong twice in opposite directions — once claiming a test
suite that had been deleted, then once denying suites that had since been built.
It is rewritten here against what `npm run` actually does today.

### What runs

| Command | What it is |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over the page. Does **not** see `supabase/` — `tsconfig.json` excludes it. |
| `npm test` | Four unit tests, no database, no network. |
| `npm run build` | The static export. |
| `deno check` | The backend's types. The command is below; it is not covered by `typecheck`. |
| `npm run test:db` | **288 tests** over seventeen files, against a real PostgreSQL 17 with the real migrations applied. Sign-in, roles, the queue, consultation, the unreadable-history resolutions, packages, receiving, the ledger, dispensing, fees, invoices, payments, images, the Slice 6 security sweep, and the counter authorization matrix — plus concurrency tests that open separate connections and race them. |
| `npm run test:browser` | **37 journeys** through a real Chrome against the built export. `docs/operations/STAGING.md` §5 lists them. |
| `npm run staging:rehearse` | Applies the migrations to a database that already has history, then re-applies the backfills to prove they are idempotent. |
| `npm run staging:drill` | The backup and restore, rehearsed on a scratch database. |

`test:db`, `test:browser`, `staging:rehearse` and `staging:drill` all refuse any
database that is not a loopback scratch database — `scripts/staging/guard.mjs`,
and `docs/operations/STAGING.md` §2 explains why that guard is not optional here.

The backend typecheck, which CI runs and `npm run typecheck` does not:

```bash
shopt -s globstar
deno check --node-modules-dir=none supabase/functions/**/*.ts
```

`--node-modules-dir=none` is not optional. Without it Deno finds the repository
root's `package.json` and `node_modules` — the page's, not the functions' — and
tries to resolve `npm:postgres` and `npm:csv-parse` out of a tree that has never
held either, failing before it typechecks a line. Deno is not a dependency here;
`npm exec --yes -- deno@2.9.6` fetches the pinned version on demand.

### What is still not covered

**CI runs two of those and reports a third.** `.github/workflows/ci.yml` has
`check` (types, unit tests, build, backend types), `database` (migrations,
`test:db`, the restore drill) and `browser`. **The `browser` job has never
run** — nothing in this programme has been pushed — so it is a job that
reports, not a gate, until it has been green twice. `docs/operations/STAGING.md` §6 says
the same at more length.

**No test has ever touched the clinic's data.** The fixtures are synthetic and
small. Nothing here proves a migration behaves against two years of real rows;
`staging:rehearse` proves it against a *representative* history this repository
made up. `docs/operations/ROLLOUT.md` §2 is the set of count-only queries that ask the real
database the same questions, and they have not been run either.

**Nothing here tests hardware.** No printer, no tablet, no clinic Wi-Fi. Print
layout is checked in a browser at A4 and 80 mm, which proves the CSS and
nothing about paper.

**Nothing here tests Supabase's own policies.** Clinical images are stored
through `storage.ts`, which writes to a directory in staging and to Supabase
Storage in the clinic. Every rule *this application* enforces is exercised;
that the bucket is private and refuses an anonymous read is a deployment check,
in `docs/operations/STAGING.md` §7.2.

**Backups run; the archive itself has never been restored from.**
`.github/workflows/backup.yml` dumps five times a day plus a nightly and a
monthly, encrypts with `age` and uploads to R2. A nightly `restore-drill` job
proves the dump-and-restore path works — but read what it actually does: it
takes a *fresh* dump from the live database and restores that onto plain
PostgreSQL 17. It never downloads the object it uploaded, never decrypts it,
and so cannot tell you that what is sitting in R2 is readable. That gap is the
one worth closing first, because it is the one that only shows up on the day it
matters.

**There is still no branch protection.** Nothing forces a green CI before a
merge to `main`.

---

## 7. Documentation and history

The top of `docs/` contains only the five current core documents in the map
above. Supporting material is grouped by purpose:

```text
docs/
  README.md                     current system and documentation index
  UI_UX_PLAN.md                 target interface and role workflows
  OWNER_POLICY_REGISTER.md      approved owner decisions
  SCHEMA_AND_TYPES.md           current data and API contract
  AGENT_IMPLEMENTATION_BRIEF.md implementation constraints and sequence
  reference/                    specialist research and discovery
  operations/                   staging, rollout, and recovery runbooks
  design/                       interactive UI concepts
```

`../archive/docs/current-programme/` contains superseded decision and milestone
documents from this programme. The other files under `../archive/docs/`
describe a retired application. The local `../hospital al in one platform/`
folder preserves the earlier, simpler interface for comparison when it is
available. None of these historical sources is an operating instruction.

### Complete documentation inventory

This is the full inventory of the 46 Markdown documents and three HTML design
references kept for current work, operations, orientation, and historical
comparison. Generated files and dependency documentation are excluded.

```text
Repository entry documents
  AGENTS.md
  CLAUDE.md
  README.md

Current core documents
  docs/README.md
  docs/UI_UX_PLAN.md
  docs/OWNER_POLICY_REGISTER.md
  docs/SCHEMA_AND_TYPES.md
  docs/AGENT_IMPLEMENTATION_BRIEF.md

Current specialist references
  docs/reference/PRODUCT_UX_DISCOVERY.md
  docs/reference/CLINICAL_TERMINOLOGY_AND_MEDICINE_DATA_RESEARCH.md
  docs/reference/INVENTORY.md
  docs/reference/TABLET.md
  docs/reference/WHATSAPP.md

Current operations
  docs/operations/STAGING.md
  docs/operations/ROLLOUT.md
  docs/operations/PIN_RESET_RUNBOOK.md

Current interactive design references
  docs/design/clinic-visual-workflow.html
  docs/design/clinic-workspace.html

Superseded documents from the current programme
  archive/docs/current-programme/OWNER_DECISIONS.md
  archive/docs/current-programme/SLICE3_CLINIC_APPROVAL_PACK.md

Retired-application history
  archive/docs/README.md
  archive/docs/BUILD.md
  archive/docs/GO_LIVE.md
  archive/docs/HOSTING.md
  archive/docs/NEXT.md
  archive/docs/PLAN.md
  archive/docs/PROPOSAL.md
  archive/docs/REVIEW.md

Earlier hospital all-in-one prototype
  hospital al in one platform/AGENTS.md
  hospital al in one platform/ARCHITECTURE.md
  hospital al in one platform/ARCHITECTURE-REVIEW.md
  hospital al in one platform/BUILD-PLAN.md
  hospital al in one platform/CLAUDE.md
  hospital al in one platform/DEPLOYMENT.md
  hospital al in one platform/hospital-platform-plan.md
  hospital al in one platform/jayamurugan clinic/README.md
  hospital al in one platform/MEDICATION-REMINDERS.md
  hospital al in one platform/PATIENT-APP-PLAN.md
  hospital al in one platform/PHARMACY.md
  hospital al in one platform/PILOT-SLICE.md
  hospital al in one platform/PILOT-V1.md
  hospital al in one platform/PLATFORM-PLAN.md
  hospital al in one platform/PLATFORM-REVIEW.md
  hospital al in one platform/prototype-build-prompt.md
  hospital al in one platform/README.md
  hospital al in one platform/RUNNING.md
  hospital al in one platform/WARD-ROUND.md
  hospital al in one platform/WHATSAPP-CHAT.md
  hospital al in one platform/scripts/control-panel/panel.html
```

The root `README.md` is the short entry point for setup, commands, project
structure, and deployment. This document remains the detailed technical source
and the index for all other documentation.
