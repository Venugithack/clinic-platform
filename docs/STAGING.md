# Staging, and the reason it exists

`docs/README.md` §3 says it plainly:

> **`npm run dev` points at whatever `NEXT_PUBLIC_FUNCTIONS_URL` says, and today
> that is the deployed functions, which are in front of the clinic's live
> database.** [...] There is no guard against this in the code.

That was true. This document describes what replaced it, and what is still
missing.

---

## 1. What you get

Four commands, no Supabase account, no Deno, no `supabase/config.toml`:

```bash
npm run staging:up       # a PostgreSQL 17 container, the migrations, the fixtures
npm run test:db          # the characterization suite against it
npm run staging:drill    # the real backup and restore scripts, rehearsed
npm run staging:rehearse # the Slice 2 migrations, over a clinic that has history
npm run staging:down     # stop it (add :destroy to remove it entirely)
```

`staging:up` prints the connection string the other commands want:

```bash
export STAGING_DB_URL="postgresql://postgres:staging@127.0.0.1:55432/clinic_staging"
```

**`npm run test:db` wipes the fixtures.** Every characterization file resets the
database to empty and builds its own state through the real commands, which is
deliberate — a test that leans on a fixture fails the day somebody adds a
medicine to it for an unrelated reason. So the fixtures are for driving the app
by hand and for the browser suite, and `npm run staging:up` puts them back.

One thing is not wiped, because it is not fixture data. The approved clinical
vocabulary — the eighty phrases of release `en-2026.09` — is installed by
`20260911120000_slice2_clinical_vocabulary.sql` and carried across every reset
by `tests/support/clinic.mjs`, the same way the clinic's own database will
carry it. A database that has somehow lost it fails loudly and names
`staging:up`, rather than quietly testing an autocomplete with nothing in it.
The fixtures seed the layer above it instead: one doctor's favourites and use
counts, which is what makes the ranking visible.

To drive the actual application against it, run the Edge Functions locally too:

```bash
node --import ./tests/support/register.mjs scripts/staging/functions-server.mjs
# then, in another shell:
NEXT_PUBLIC_FUNCTIONS_URL=http://127.0.0.1:54321/functions/v1 npm run dev
```

`NEXT_PUBLIC_FUNCTIONS_URL` is baked into the bundle at build time, so it has
to be set **on the `npm run dev` command itself**. Exporting it afterwards
changes nothing, and the tablet will still be talking to Chennai.

---

## 2. The guard

`scripts/staging/guard.mjs` is imported by every entry point that can write to
a database. It is an **allowlist**, not a blocklist, because a blocklist of
"not supabase.co" is one new hostname away from being wrong and the failure
mode is a real patient in a real register.

A connection is refused unless both of these hold:

| | |
|---|---|
| Host | `localhost`, `127.0.0.1`, `::1` or `0.0.0.0` |
| Database name | `clinic_staging`, `clinic_test` or `clinic_restore_drill`, optionally with an `_suffix` |

It throws rather than warning, and it never prints the URL, which carries a
password. The same guard runs in CI. There is no weaker rule for automation.

---

## 3. Two things found while building this

Both were found by trying to build a database from the committed migrations,
which nothing had done before.

### 3.1 The migrations only land in `jmc` if something wraps them in a transaction

Every migration begins:

```sql
set local search_path = jmc;
```

`SET LOCAL` outside a transaction block does nothing at all. Postgres says
`WARNING: SET LOCAL can only be used in transaction blocks` and then runs the
file anyway with the default `search_path`. Applied that way,
`create table if not exists staff (...)` creates **`public.staff`**.

Run through `psql` with no transaction, all thirty tables land in `public` —
which on the clinic's shared database is where the retired application's 74
tables live, and **eight of the names collide exactly**: `staff`, `patients`,
`bills`, `appointments`, `vitals`, `prescriptions`, `encounters`, `suppliers`.
Nothing errors. The application then reads whichever the `search_path` finds
first, which is the exact failure `docs/README.md` §1 describes as the reason
the backend is not behind Hyperdrive.

Production is correct today only because `supabase db push` happens to wrap
each migration in a transaction. Nothing states that requirement anywhere, and
nothing checks it.

`scripts/staging/apply-migrations.mjs` does both: it always opens a
transaction, and afterwards it asserts that five canary tables are in `jmc` and
that none of them also appeared in `public`. If the wrap ever stops happening,
the applier says so instead of building a working-looking clinic in the wrong
schema.

**Still open:** production applies these files through a tool whose transaction
behaviour is an implementation detail. The durable fix is to schema-qualify the
DDL, or to add an assertion to the migration set itself. Both change files that
have already been applied to production, so both need owner sign-off — see
§6.1 of the Slice 0 report.

### 3.2 The migration set cannot build a fresh clinic

`20260909125237_harden_active_clinic.sql` reaches into the **retired**
application's objects: it flips `security_invoker` on 33 `public` views and
revokes `anon`'s execute on five `app.*` functions, two of which are
`unlock_pin` overloads that were a public PIN-verification surface.

Against production that is correct and important. Against an empty database it
dies on its first statement:

```
ERROR: relation "public.available_stock" does not exist
```

So the committed migration set builds eight ninths of a clinic and then stops,
and what it stops before is the entire security posture: no RLS, no revoked
grants, none of the 41 foreign-key indexes.

A staging database that skipped that migration would be a worse lie than no
staging at all, so staging does not skip it. `scripts/staging/legacy-stubs.sql`
creates the retired application's objects as empty views and no-op functions
first, and then the **real** hardening migration runs exactly as it ran in
production. Verified afterwards: 29 tables, RLS enabled on all 29, zero grants
to `anon`/`authenticated`/`service_role`, `anon`'s execute on the `app.*`
functions revoked.

**Still open:** disaster recovery onto a brand-new Supabase project would hit
this. The backup does carry `public` and `app`, so a restore-then-migrate path
works; a migrate-from-scratch path does not. Making the hardening migration
tolerate absent legacy objects would fix it, and would edit a migration that
has already been applied — see §6.1 of the Slice 0 report.

---

## 4. Running the backend under Node

`tests/support/register.mjs` makes the Edge Functions importable by Node. Two
things stand in the way and both are fixed in the harness rather than in the
backend, because the backend has to keep running on Deno unchanged:

- **`npm:` specifiers.** `npm:postgres@3.4.5` is rewritten to `postgres`, which
  resolves out of this repository's own `node_modules`. `postgres` and
  `csv-parse` are devDependencies for exactly this reason; nothing in the page
  imports either.
- **The `Deno` global.** Shimmed to `Deno.env.get` over `process.env`, which is
  the only Deno API the shared files use. `scripts/staging/functions-server.mjs`
  additionally replaces `Deno.serve` so that each `index.ts` hands its handler
  over instead of listening, and mounts the nine of them on one Node server.

**What this is not.** It is not Deno. The code is the same code; the runtime
under it is not. Deno's permission model, its own `npm:` resolution and its CPU
budget are not being exercised. Two things cover that and neither is this
harness: CI runs `deno check` over every function, and the clinic runs the
deployed ones. A green run here is evidence about the clinic's logic, not about
its runtime.

---

## 5. The browser gate

```bash
npm run test:browser
```

One command, which does all of it and cleans up after itself: rebuilds the
staging database with fixtures, seeds a doctor-ONLY account (the fixtures'
doctor also holds admin, and the union of both roles hides exactly the gaps
Slice 1 was fixing), builds the static export against the local functions,
starts the functions and the page, and drives seventeen journeys through Chrome.

It runs the built export rather than `next dev`, because the export is what
Cloudflare serves and `NEXT_PUBLIC_FUNCTIONS_URL` is baked into it at build
time — the dev server would hide the one difference that matters.

### What it covers

Four-digit sign-in at both tablet orientations, a wrong PIN, Delete;
doctor-only and nurse rails; duplicate suggestions before registration;
registering a walk-in, issuing a token, recording two readings out of five;
Call in carrying the patient into Consult; one whole consultation — typing
`fev` into Complaint, tapping the approved suggestion, saving it as a personal
favourite, leaving the station and finding the draft rebuilt from the server,
then a template, a signature and a print; no sideways scroll and no control
under 44px at 1024x768 and 768x1024; a real Tab press landing somewhere named
and visibly marked; every control having an accessible name; a busy state
while a command is in flight; and a dropped connection reported as words.

## 5a. Rehearsing a migration over a clinic that already has history

```bash
npm run staging:rehearse
```

`staging:up` applies every migration to an empty database. That is the right
thing for a test database and the wrong thing for evidence about a migration,
because the two backfills in Slice 2 — giving every existing prescription a
number, and building normalized lines out of the legacy `items_json` — then run
over zero rows. A backfill over zero rows proves nothing at all. In the clinic
they run over two years of signed prescriptions, once, with no undo.

So this builds the schema as it stood *before* Slice 2, puts deliberately
awkward history into it, applies the two Slice 2 migrations the way
`apply-migrations.mjs` does, and reads out what happened to each row. The
awkward cases are not invented shapes; they are what a hand-maintained JSON
column accumulates: an item pointing at a medicine row somebody later removed,
a prescription with no items, and items written before quantity was a number.

It confirms numbering is gapless and unique, that the sequence does not hand
the next patient a number already printed on a slip, that identity snapshots
come from the formulary rather than from parsing a name, and that a later
rename does not reach back into signed history.

Running it is what found the two defects Slice 2.1 fixes. The Slice 2 backfill
dropped any item whose medicine row was gone, and turned a missing or zero
quantity into quantity **1** — both silently, on real prescriptions. Neither is
acceptable behaviour and neither is described here as though it were: the
script now asserts the corrected behaviour instead, that every legacy item
produces a line, that an unreadable one keeps its name and directions while
naming no medicine, that an unrecorded quantity stays unknown, and that both
are blocked from dispensing until a doctor resolves them.

What it still prints is the size of the queue that creates:

```text
Doctor review queue this migration would create:
  1 line(s) name a medicine that is not in the formulary.
  2 line(s) have no recorded quantity.
```

That is work only a doctor can do, and counting it against the clinic's own
rows — with the query the script prints — is how the clinic finds out before
deploying whether it is an afternoon or a fortnight.

Like `test:db`, it rebuilds the schema and so destroys the fixtures; run
`npm run staging:up` afterwards.

## 5b. The database runtime role

`npm run test:db` includes `tests/characterization/runtime-role.test.mjs`,
which is the only thing here that does not connect as a superuser.

Everything else in the suite connects as `postgres`, which in the staging
container bypasses row security, ignores grants and never meets a permission
error — so a green suite says nothing about whether the application can reach
its own tables once deployed as something less privileged. That gap hid a real
defect: Slice 2's `force row level security`, on tables with no policies, makes
every one of them return zero rows to an owner without `BYPASSRLS`, silently.

So that file creates `jmc_runtime` — `LOGIN NOSUPERUSER NOBYPASSRLS
NOCREATEDB NOCREATEROLE` — hands it ownership of the `jmc` schema the way a
deployed project's migration role owns it, and runs a nurse arrival, vitals, a
draft, a template, a signature, a print and a pharmacy queue read through the
real command layer as that role. The application runs in a child process
because `db.ts` fixes its connection at import and cannot be repointed inside a
running one.

Ownership is handed back in `finally`. If the file is killed mid-run, staging
is left owned by `jmc_runtime`, which is harmless — `postgres` is still a
superuser — and `npm run staging:up` rebuilds it regardless.

See `docs/SCHEMA_AND_TYPES.md` §7 for what each layer is actually enforcing.

### The third guard

`guard.mjs` refuses a non-local database and the runner does the build itself,
but both can be satisfied by somebody who then runs `npm run build` in another
shell and leaves `out/` pointing at production. So the harness re-reads the
built bundle before the server will serve it, and refuses if the live project
appears anywhere in the JavaScript. Verified by building against the live URL
on purpose and watching it refuse, naming the chunk.

That matters more here than anywhere else in this repository: this suite
registers patients, issues queue tokens and records vitals. Against the wrong
backend it would do all of that to the clinic, and there is no undo.

### One environment note

The browser is launched outside whatever sandbox the shell is in, so it cannot
reach a port bound inside one. If every journey fails to reach the page while
`curl` reaches it happily, that is the cause — run the gate from an ordinary
shell.

---

## 6. What is still missing

Named rather than implied, in the register `docs/README.md` §6 uses.

**The browser suite runs, and does not run in CI.** `npm run test:browser`
drives seventeen journeys through a real Chrome — see §5. It is not wired into
`.github/workflows/ci.yml`: the runner would need Docker for the staging
database (which GitHub's ubuntu images have) and a Chrome download via
`agent-browser install` (which they do not), and a pipeline that goes red for
a missing browser teaches people to ignore it. Adding it is a small job and a
deliberate one.

**Deno is not a dependency of this repository**, and does not need to become
one. `npm exec` fetches the pinned version on demand, so the check CI runs is
available locally without installing anything permanently:

```bash
shopt -s globstar
npm exec --yes -- deno@2.9.6 check --node-modules-dir=none supabase/functions/**/*.ts
```

`--node-modules-dir=none` is not optional; `docs/README.md` §6 explains what
happens without it. The version is pinned to match `.github/workflows/ci.yml`,
because the TypeScript compiler doing the checking ships inside Deno and a
floating version means the verdict can change on a morning nobody touched the
code.

**The staging database is not the clinic's data.** The fixtures are synthetic
and small. Nothing here proves a migration will behave against two years of
real rows; rehearsing that needs a restored copy of a production backup, which
is a separate exercise and needs owner approval to handle real patient data.

**`supabase start` is still not set up.** There is no `supabase/config.toml`.
The full Supabase stack — Auth, Storage, PostgREST, the Deno edge runtime — is
eleven containers this project does not currently need; Slice 5 needs private
Storage and will need it then.
