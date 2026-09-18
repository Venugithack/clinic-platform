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

Backend programme status: Slices 0–2 are complete and accepted, and the bounded
**Slice 3A** — the durable foundation for reminders, recalls and delivery truth
— and **Slice 3B** — the provider adapter, the authenticated webhook and the
protected worker contract — are implemented. The bounded Slice 2 frontend safety cutover is also
implemented locally: the consultation screen holds one attempt across visit
changes and gives doctors the audited reconciliation workflow. The full
appointment-calendar UI is not implemented.

Slice 3A adds five tables, a provider-neutral state machine and the commands
and on-demand reads around them, against owner items 76–83. Slice 3B adds one
more table, the adapter that speaks to Meta, the signed statuses webhook, and
the protected endpoint a scheduler will call.

**Nothing has been sent, and no scheduler is provisioned.** There is no
credential, no approved Meta template, no `pg_cron` job and no `pg_net` call,
and no line of the adapter has ever been answered by Meta. With the clinic's
connection unconfigured — which is its state — every due message is suppressed
into the admin's queue with `channel_not_configured` against it, the webhook
refuses every request, and the worker endpoint refuses every caller.
`SCHEMA_AND_TYPES.md` §15 and §16 are the contract; §16.9 is what is still
owed, and `operations/ROLLOUT.md` §9 is the procedure for switching it on.

### Read by task

| Task | Read next |
|---|---|
| UI/UX or a doctor, nurse, pharmacy, or admin workspace | `UI_UX_PLAN.md`, then the relevant material in [`reference/`](reference/) and the interactive files in [`design/`](design/) |
| Clinical vocabulary or medicine identity | [`reference/CLINICAL_TERMINOLOGY_AND_MEDICINE_DATA_RESEARCH.md`](reference/CLINICAL_TERMINOLOGY_AND_MEDICINE_DATA_RESEARCH.md) |
| Packages, stock, FEFO, costing, or expiry | [`reference/INVENTORY.md`](reference/INVENTORY.md) plus the medicine-identity research |
| Tablet hardware or touch interaction | [`reference/TABLET.md`](reference/TABLET.md); current interface decisions still come from `UI_UX_PLAN.md` |
| WhatsApp | [`reference/WHATSAPP.md`](reference/WHATSAPP.md), with time-sensitive policy rechecked before release |
| Competitor features, workflows, and market positioning | [`reference/COMPETITIVE_LANDSCAPE_2026.md`](reference/COMPETITIVE_LANDSCAPE_2026.md) |
| Backend implementation of the competitive and workflow improvements | [`reference/CLAUDE_BACKEND_IMPLEMENTATION_PROGRAMME.md`](reference/CLAUDE_BACKEND_IMPLEMENTATION_PROGRAMME.md), then the current core documents it requires |
| What that programme found, what it still has to decide, and in what order | [`reference/BACKEND_PROGRAMME_REGISTER.md`](reference/BACKEND_PROGRAMME_REGISTER.md) — the evidence baseline, work register, decision register and compatibility map |
| Building a screen on what the backend programme has already delivered | [`reference/SLICE1_FRONTEND_CONTRACT.md`](reference/SLICE1_FRONTEND_CONTRACT.md) — the `workspace` endpoint's fields, role matrix, states, retry rules and stated limits, then [`reference/SLICE2_FRONTEND_CONTRACT.md`](reference/SLICE2_FRONTEND_CONTRACT.md) — the accepted appointment-book, queue-convergence, and consultation-attempt reconciliation contract. The bounded consultation safety cutover exists; the full appointment-book/calendar UI does not. |
| Staging, rollout, or PIN recovery | The applicable runbook in [`operations/`](operations/) |
| Product rationale from the design sessions | [`reference/PRODUCT_UX_DISCOVERY.md`](reference/PRODUCT_UX_DISCOVERY.md); later core documents take precedence |
| Why an earlier decision was raised | [`../archive/docs/current-programme/`](../archive/docs/current-programme/) |
| Comparing the simpler earlier interface | `../archive/local/hospital-all-in-one-reference/`, when that ignored local reference folder is present |

### When documents differ

1. Source code, migrations, and tests show what the application does now.
2. `OWNER_POLICY_REGISTER.md` records approved product policy.
3. `UI_UX_PLAN.md` records the target interface and workflow.
4. `SCHEMA_AND_TYPES.md` and `AGENT_IMPLEMENTATION_BRIEF.md` define the current
   technical contract and delivery constraints.
5. `reference/` explains specialist research and earlier discovery.
6. `archive/` preserves tracked history and ignored local comparison material.

If two current sources still conflict, record and resolve the conflict instead
of silently choosing one.

---

## 1. Two halves, and why

The application is two programs that never share a process:

| | | |
|---|---|---|
| **the page** | `app/`, `components/`, `lib/` | a **static export**. `next build` writes plain HTML, CSS and JavaScript to `out/`; Cloudflare serves those files. Nothing runs behind them |
| **the backend** | `supabase/` | **Deno**. Thirteen Edge Functions deployed beside the database, talking to Postgres directly |

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
`Authorization: Bearer <token>`. There are fifteen — thirteen driven by a
member of staff holding a session, and two, added by Slice 3B, that are not
driven by a person at all:

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
| `reports` | fifteen named reports, each with its own role gate |
| `inventory` | the stock ledger, goods receipts, a barcode lookup, the formulary — read on demand rather than polled |
| `images` | clinical image tickets, bytes and metadata. Pharmacy is refused outright |
| `whatsapp` | **not a person.** Meta's verification challenge and its signed statuses webhook. Verifies `X-Hub-Signature-256` over the raw request bytes before parsing anything, and is the only thing in this application that can say a message was delivered |
| `worker` | **not a person.** One dispatch cycle, behind `CLINIC_WORKER_TOKEN`. A staff session is refused here exactly as an anonymous caller is; see `SCHEMA_AND_TYPES.md` §16.6 |
| `workspace` | what a workspace opens with — patient search, the patient band, actionable counts and their drill-downs, visit progress, safe-exit obligations, what an idempotency key committed, proven-equivalent products, and the three Slice 2 views: the appointment calendar, a patient's own appointments, and the reconciliation of an unresolved consultation attempt. Read on demand; its roles come from one capability table |

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
  attempt-key.ts        the consultation attempt's browser-storage lifecycle
  consultation-attempt.ts  client handling for attempt refusal and recovery
  consultation-reconciliation.ts  coded recovery and retry policy
  types.ts              the frontend door to the backend's shared type contract
public/
  _headers              the four security headers, applied by Cloudflare —
                        a static export has no server to set them
supabase/
  functions/
    _shared/            auth · commands (the large one) · counter · inventory ·
                        snapshot · types · db · http · password · money ·
                        packages · images · storage · whatsapp · order-status ·
                        capabilities · idempotency · workspace ·
                        appointments · clinic-policy · command-input ·
                        messaging · messaging-transport · whatsapp-cloud ·
                        internal-auth
    <fifteen dirs>/     index.ts each, one Deno.serve per endpoint
  migrations/           forward-only SQL, named by timestamp. Creates `jmc`
scripts/
  set-db-url.mjs        writes DATABASE_URL into .env.local without it passing
                        through a shell whose quoting rules you have to guess
tests/
  *.test.ts             four files of pure unit tests — `npm test`
  characterization/     the database suite — `npm run test:db`, §6
  browser/              real-Chrome journeys — `npm run test:browser`, §6
  support/              the bridge that points both suites at guarded staging
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
npm test             # node --test, the four unit files in tests/
npm run build        # writes out/
```

`npm run preview` (or `npm start`) serves the built `out/` directory through
Wrangler on `http://localhost:3000`. Run `npm run build` first.

### The trap: `npm run dev` is not the sandbox

This repository has no `supabase/config.toml` — it was deleted with the retired
application — so `supabase start` and `supabase functions serve` are not set up
here. What replaced them is `npm run staging:up`: a disposable PostgreSQL 17 in
Docker with the real migrations and synthetic fixtures, and
`scripts/staging/functions-server.mjs`, which runs all thirteen real Edge
Functions under Node. That is a complete offline stack and
[`operations/STAGING.md`](operations/STAGING.md) is how to drive the application
against it.

What it is not is the default. **`npm run dev` points at whatever
`NEXT_PUBLIC_FUNCTIONS_URL` says, and today that is the deployed functions,
which are in front of the clinic's live database.** Plain `npm run dev` is not
a sandbox. A command you send from `localhost:3000` while trying
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
| `WHATSAPP_*` | five values, four of them required together. Until all four exist the adapter is fully disabled, the `whatsapp` webhook refuses every request including a correctly signed one, and every automatically scheduled message is suppressed into the admin's queue with `channel_not_configured` against it rather than silently dropped. There is no partial mode and no development default. `WHATSAPP_API_VERSION` is the optional fifth and defaults to `v23.0` |
| `CLINIC_WORKER_TOKEN` | **required by the `worker` endpoint, and by nothing else.** One long random string, held by the scheduler. Unset means the endpoint refuses everybody, including a correct caller — an unset secret must never mean "no check". It is not a staff credential and never goes on a tablet |
| `CLINIC_PUBLIC_PAGE_URL` | optional. The one destination a Slice 3A template may link to. A template that interpolates `{{link}}` is suppressed with `link_destination_unavailable` while this is unset |

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
| `npm test` | Forty unit tests over four files, no database, no network. |
| `npm run build` | The static export. |
| `deno check` | The backend's types. The command is below; it is not covered by `typecheck`. |
| `npm run test:db` | **888 tests** over thirty files, against a real PostgreSQL 17 with the real migrations applied. Sign-in, roles, the queue, consultation, the unreadable-history resolutions, packages, receiving, the ledger, dispensing, fees, invoices, payments, images, the Slice 6 security sweep, the counter authorization matrix, the consultation idempotency key, which visit a consultation belongs to through every way the two can part, the workspace read models with their role matrix, the appointment book against owner items 65–71, the consultation/visit reconciliation against items 72–75, Slice 3A's message templates, consent, schedules, outbox and delivery attempts against items 76–83, and Slice 3B's provider adapter, dispatch worker and authenticated webhook — plus concurrency tests that open separate connections and race them, including two tablets signing one queued patient under one reference, two tablets checking one booking in, two bookings for one slot, two doctors reconciling one attempt, three workers dispatching one message, and a consent withdrawal racing a worker that is already preparing it. **No test here makes an external provider request**: the messaging channel is injected, the test adapter refuses at construction to address anything but loopback, and the Slice 3B suite replaces `fetch` itself with a stub that throws and records, then asserts at the end that nothing was ever attempted. |
| `npm run test:browser` | **66 journeys** through a real Chrome against the built export. `docs/operations/STAGING.md` §5 lists them. |
| `npm run staging:rehearse` | Twenty-five checks. Applies every migration from Slice 2 onwards to a database that already has history — including five legacy arrivals, two of them sharing a token — then applies them a second time to prove the backfills are idempotent. It had been dead since `20260915` was written — see `reference/BACKEND_PROGRAMME_REGISTER.md` §4 — and was repaired on 14 September 2026. |
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

**The bounded safety cutover is not the full Slice 2 UI programme.** The current
consultation screen implements attempt recovery and reconciliation, but the
appointment calendar and broader appointment-management screens remain unbuilt.

**Slice 3B built the adapter and the webhook, and still nothing has been
sent.** No message has ever gone out, no provider has ever answered a line of
this code, no credential exists, no Meta template has been approved, no
scheduler is provisioned, and no screen renders any of the read models. The
adapter is disabled without its four `WHATSAPP_*` values and the worker refuses
every caller without `CLINIC_WORKER_TOKEN`; both are unset.

What that means precisely: the *logic* of sending is now tested — the payload,
the acceptance-is-not-delivery rule, the retry ceiling, the signature check, the
deduplication, the out-of-order rules — against a transport that cannot leave
the machine. The *integration* is untested, because there is nothing to
integrate with yet. Two constants and the named-parameter payload shape are
marked provisional in the code for exactly that reason, and
`SCHEMA_AND_TYPES.md` §16.9 and `operations/ROLLOUT.md` §9 list what has to be
true before any of it is switched on.

**Retrospective finished-visit linking is not discoverable in this bounded
screen.** The accepted command can link Same attendance to a visit already
marked `done`, but the reconciliation read returns only `openVisits`. The screen
therefore cannot offer a finished visit identifier it was never given. The
backend contract was not changed in this frontend cutover.

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
describe a retired application. The ignored local
`../archive/local/hospital-all-in-one-reference/` folder preserves the earlier,
simpler interface for comparison when it is available. None of these
historical sources is an operating instruction.

### Complete documentation inventory

There are **21 active Markdown documents** and two HTML design references. The
11 tracked historical Markdown documents are listed separately; ignored local
archives, generated files, and dependency documentation are deliberately not
expanded here.

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
  docs/reference/BACKEND_PROGRAMME_REGISTER.md
  docs/reference/CLAUDE_BACKEND_IMPLEMENTATION_PROGRAMME.md
  docs/reference/SLICE1_FRONTEND_CONTRACT.md
  docs/reference/SLICE2_FRONTEND_CONTRACT.md
  docs/reference/COMPETITIVE_LANDSCAPE_2026.md
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
  archive/README.md
  archive/docs/README.md
  archive/docs/BUILD.md
  archive/docs/GO_LIVE.md
  archive/docs/HOSTING.md
  archive/docs/NEXT.md
  archive/docs/PLAN.md
  archive/docs/PROPOSAL.md
  archive/docs/REVIEW.md

Local-only comparison material (not tracked or counted above)
  archive/local/hospital-all-in-one-reference/
```

The root `README.md` is the short entry point for setup, commands, project
structure, and deployment. This document remains the detailed technical source
and the index for all other documentation.
