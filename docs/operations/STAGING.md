# Staging, and the reason it exists

`docs/README.md` §3 says it plainly:

> **`npm run dev` points at whatever `NEXT_PUBLIC_FUNCTIONS_URL` says, and today
> that is the deployed functions, which are in front of the clinic's live
> database.** [...] There is no guard against this in the code.

That was true. This document describes what replaced it, and what is still
missing.

---

## 1. What you get

Six commands, no Supabase account, no Deno, no `supabase/config.toml`:

```bash
npm run staging:up            # a PostgreSQL 17 container, the migrations, the fixtures
npm run test:db               # the characterization suite against it
npm run staging:drill         # the real backup and restore scripts, rehearsed
npm run staging:archive-drill # the STORED-object restore proof, rehearsed — §5c
npm run staging:rehearse      # every migration from Slice 2 on, over a clinic with history
npm run staging:down          # stop it (add :destroy to remove it entirely)
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

## 3. Three things found the hard way

The first two were found by trying to build a database from the committed
migrations, which nothing had done before. The third was found on 19 September
2026 by the staging script itself, and had been misdiagnosed twice before that.

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

### 3.3 `staging:up` called the database ready a second too early

Found on 19 September 2026, while running the Slice 4 gate, after being
suspected twice the day before.

`up.mjs` decided the container was ready by running
`docker exec jmc-staging pg_isready` in a retry loop. On a **fresh** container
that is wrong, and on a warm one it is right — which is why running the
command a second time always "fixed" it and nobody caught it.

The postgres image's entrypoint, on an empty data directory, runs `initdb` and
then starts a **temporary server** to run the initialization scripts. That
server listens on the Unix socket only. `docker exec … pg_isready` talks to
the Unix socket. The container's own log has the whole thing in five lines:

```text
[60] LOG:  database system is ready to accept connections   ← the temporary one
[60] LOG:  database system is shut down
PostgreSQL init process complete; ready for start up.
[85] FATAL: the database system is starting up              ← us, in the gap
[1]  LOG:  database system is ready to accept connections   ← the real one, 96 ms later
```

`up()` threw on that FATAL and exited 1, which is correct and was never the
problem. The problem is what it leaves behind: a container that **is**
running, a `jmc` schema with nothing in it, and — for anybody who then runs
the database suite anyway — two hundred red tests in every file, each about
five milliseconds long, all saying `relation "jmc.staff" does not exist`. It
looks exactly like a broken migration and is nothing of the kind. A uniform
few-millisecond failure across unrelated suites is the tell.

**The fix** is to ask the question the way every consumer asks it:
`awaitReady` opens a real client connection over **TCP from the host** and
runs `select 1`, twice, a moment apart. The temporary server does not listen
on TCP at all, so the entire class of false-ready disappears rather than being
timed around; and "answered once" and "is up" stay different claims.

`tests/staging-readiness.test.mjs` — in `npm test`, no Docker, no database —
holds the predicate against the two states the old check mistook for ready:
nothing listening, and a socket that accepts and never speaks. It also holds
the refusal to printing no connection string, for the reason §2 gives.

**One thing this did not change**, because it was already true: the command
exits non-zero when migrations, verification or fixtures do not finish. What
hid that during the incident was the invocation, not the script —
`npm run staging:up | tail -3` reports `tail`'s exit status, and an `&&` chain
after it runs happily. Do not pipe a gate command.

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
  over instead of listening, and mounts the fifteen of them on one Node server.
  It passes the request body through as raw bytes, which the `whatsapp` webhook
  depends on: its signature check is over the bytes that arrived and a server
  that re-encoded them would make a correct signature fail here and only here.

**What this is not.** It is not Deno. The code is the same code; the runtime
under it is not. Deno's permission model, its own `npm:` resolution and its CPU
budget are not being exercised. Two things cover that and neither is this
harness: CI runs `deno check` over every function, and the clinic runs the
deployed ones. A green run here is evidence about the clinic's logic, not about
its runtime.

### 4.1 Driving the dispatch worker on staging

There is no scheduler here and there must not be one. What there is, is the
same protected endpoint the clinic will have, reachable on loopback and only on
loopback:

```bash
npm run staging:up
STAGING_FUNCTIONS_PORT=54321 CLINIC_WORKER_TOKEN=staging-only-worker-token   node scripts/staging/functions-server.mjs

# in another shell — one cycle, by hand
curl -s -X POST http://127.0.0.1:54321/functions/v1/worker   -H 'Authorization: Bearer staging-only-worker-token'   -H 'Content-Type: application/json' -d '{}'
```

With no `WHATSAPP_*` variables set — which is the default here and the state of
the clinic — the answer is counts, and every due message is suppressed with
`channel_not_configured`. That is the honest result and it is what to expect.

Two things this deliberately does not do. It does not schedule anything: a
`pg_cron` job in a staging database is a rehearsal of the one thing that must
not be rehearsed by accident against the wrong connection string. And it does
not set a real credential — `staging-only-worker-token` is a value in this
document, which is exactly what a real one must never be.

The webhook is reachable the same way, but a request to it needs a signature,
so the useful way to exercise it is
`tests/characterization/slice3b-delivery.test.mjs`, which computes one.

---

## 5. The browser gate

```bash
npm run test:browser
```

One command, which does all of it and cleans up after itself: rebuilds the
staging database with fixtures, seeds a doctor-ONLY account (the fixtures'
doctor also holds admin, and the union of both roles hides exactly the gaps
Slice 1 was fixing), builds the static export against the local functions,
starts the functions and the page, and drives a hundred and seventeen journeys
through Chrome. A hundred and eight of those are written out; the other nine
come from loops — three in `clinic-gate.test.mjs` that run one journey at two
shapes or once per role, and one in `appointment-book.test.mjs` that runs one
journey at each of the plan's five shapes — which is why counting `test(` in
the source comes up short.

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

Slices 3 to 6, and then the theme and window work, added thirty-four more,
each of them a thing no database test can see:

- **Formulary and receiving** — building a package ladder and verifying it
  against the pack; receiving boxes and strips and reading the base-unit
  preview before posting; a blind opening count that genuinely hides the
  expected figure until a number is entered; an unknown barcode queueing for
  an admin.
- **The counter** — a consultation fee arriving with no prescription behind
  it; partial dispensing with prescribed, supplied, available and remaining
  all on screen; a split payment across cash and UPI; pay-later leaving a
  balance that the day book and the till agree about.
- **Images** — capture refusing to start without an open patient and a
  recorded consent; the pharmacy rail carrying no image control at all; and
  an assertion that no durable image URL exists anywhere in the page's markup
  after a photograph has been viewed.
- **Who may work the counter** — a pharmacist offered all three counter
  stations, and an administrator who is not a pharmacist offered Take payment
  and neither of the two that move medicine. The other end of that claim is a
  database test that calls the commands directly; the two have to agree or one
  of them is decoration.
- **Admin and reports** — the administrator's twenty stations divided into the
  five sections with nothing lost; a report about now offering no date range
  and a dated one offering one; a pharmacist's report list with Consultation
  fees, Reversals and Image access simply absent from it rather than greyed
  out; no raw identifier printed at a reader; no sideways scroll at either
  tablet orientation on the widest table this application draws; and the
  review queue offered to a doctor and not to the pharmacy.

Slice 3A added no journey at all, and that is worth saying rather than leaving
to be noticed. It builds a backend contract with no screen in front of it: the
four messaging read models are reachable and typed, nothing renders them, and
there is nothing for a browser to drive. What it did add to this suite is a
negative — the whole gate ran unchanged, which is the evidence that five new
tables and a call inside five appointment commands changed nothing anybody
touches.

Slice 4's doctor-review cutover contributes thirty-two, and they are unusual
in one respect: they arrange their own state over HTTP through the real
commands rather than through `fixtures.mjs`. A report that arrived through
`order_investigation` and `record_result` is provably reachable, where a
hand-written fixture row proves only that somebody can write a row — and the
fixture file is shared with every other journey in the suite. Most of what
they assert is words: that acceptance is not delivery, that a laboratory's
signature is not a clinic review, that acknowledging a critical result is not
reviewing it, and that nothing anywhere says the patient was notified unless
the provider said so.

Eight of them are about the reply that never comes back. They break `fetch`
in the page, press the control, and — three of them — reload the tablet,
then read the order back through `view.investigation_order` and count what is
actually there: one review on the result, one authorization stamp, and a
notification the record still does not call delivered. That count is the only
way to prove that recovering from a lost reply did not quietly do the work
twice. They also read `sessionStorage` directly, to prove the recovery note
holds identifiers and nothing a patient would recognise.

The consultation-attempt work now contributes ten journeys, and they are the only
journeys in the suite that assert on something invisible: the reference a
consultation is signed under. They read `sessionStorage` directly rather than a
mock, because the storage is the mechanism. The recovery journeys also drive
the real doctor-only screen and assert its durable database result.

Four are about the reference's own life. It is held while the outcome is
unknown and survives leaving the station and reloading the tablet; it is
released when the clinic confirms the signing; it is NOT released by discarding
a draft, because a discard says nothing about whether a signing committed; and
it IS released by a signing that confirms after the doctor has walked away from
the screen, which is the case a release written inside a render callback
silently misses.

Six more are about the visit moving under the doctor mid-attempt, and they
exist because those defects are in what the panel SENDS — invisible to a
storage test and to a database test alike, both of which were green while a
consultation succeeded and the visit it belonged to sat in the queue attached
to nothing. A walk-in opened from the register, the reply lost, and the doctor
then creating today's visit: the second press attaches the consultation to that
visit and closes it. The same, where the first press HAD committed and its reply
was lost across a reload: **Same attendance** closes the leftover visit with one
encounter and one ₹300 fee. A retry crossing midnight is a replay, not a second
fee. A queued visit **cancelled** under the attempt may be explicitly abandoned
only after the backend offers it. **New attendance** releases only after the
audited decision, and a double press records one decision before the genuine
return is signed. Finally, a transaction-held signing proves that both recovery
and signing stay disabled while the earlier outcome is still in flight.

The appointment station adds `appointment-book.test.mjs`, and like the
consultation-attempt file it brings its own patients, publishes its own hours
through the real command, and removes all of it afterwards — the bookings,
their append-only history and receipts, the queue rows and the reminder
schedules the commands wrote. Most of its journeys end by counting rows:
a nurse's booking is one booking and **no** queue row until check-in, which
then makes exactly one; a late booking checked in joins the queue behind the
people who arrived before it; a no-show is still `booked` fifty minutes on
until a person records it, and is refused earlier. A nurse outside published
hours is refused and offered no override — also at the server, with a reason
sent anyway — while a doctor outside her own hours and an administrator
overbooking a taken slot are each asked why, and the recorded booking went
under the **same reference** as the refused first attempt. Pharmacy is shown
no station and refused by every read and command.

Four of its journeys are about the reply that never comes back, and they read
the reference itself: every command's `idempotencyKey` is recorded in the page
as it leaves, so "the retry went under the same reference" is a comparison
rather than a belief. A booking whose reply is lost, then sent again: one
booking, one receipt. The same across a reload, where the tablet asks
`view=appointment_outcome` instead and shows what was recorded. A check-in
whose reply is lost and which a doctor then undoes by moving the appointment:
the retry shows the original token **and** that the patient is not in the
queue under it, and there is still exactly one arrival. And a check-in that
never left the tablet, checked while the clinic is still unreachable, then
found `not_committed` and sent once. They also read `sessionStorage` to prove
the note holds no name, reason or time. The rest: a slow read saying so, an
unreachable read saying so and recovering, the stale-read notice, the keyboard
reaching a booking's history with Escape returning focus, and all five of the
plan's shapes with no sideways scroll and no control under 44px.

The blind-count journey is the one worth singling out. Its first version
passed without proving anything — the start screen and the counting screen
share a heading, so a wait on the title was satisfied before the count began.
It now requires the count reference and the "Counted zero" control to be
present before it will assert, which is the difference between testing the
screen and testing that a screen exists.

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
awkward history into it, applies every migration from Slice 2 onwards the way
`apply-migrations.mjs` does, and reads out what happened to each row. The
awkward cases are not invented shapes; they are what a hand-maintained JSON
column accumulates: an item pointing at a medicine row somebody later removed,
a prescription with no items, and items written before quantity was a number.

It confirms numbering is gapless and unique, that the sequence does not hand
the next patient a number already printed on a slip, that identity snapshots
come from the formulary rather than from parsing a name, and that a later
rename does not reach back into signed history.

It also found something about itself. Until 14 September 2026 the set under
rehearsal was a hard-coded list of seven filenames, and the three migrations
written after Slice 5 were never added to it — so they fell into the "before"
set, where `20260915_financial_edge_states.sql` builds a view over
`jmc.invoices`, a table Slice 4 creates and this script deliberately holds
back. The whole rehearsal died on `relation "jmc.invoices" does not exist`, and
had been dead since the day the first of those three was written: every
migration from `20260915` on had never been rehearsed at all. The boundary is
now a position rather than a list, so a new migration is rehearsed by default
instead of by somebody remembering. `reference/BACKEND_PROGRAMME_REGISTER.md`
§4 has the detail.

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

## 5c. Rehearsing the stored-object restore proof

`staging:drill` and `staging:archive-drill` answer two different questions and
it is worth being exact about which, because for a year the first was mistaken
for the second.

| | What it does | What it proves |
|---|---|---|
| `npm run staging:drill` | Runs `scripts/db-backup.sh` and `scripts/db-restore-drill.sh` against staging: a **fresh dump**, straight back into a scratch database. | `pg_dump` output can be restored, and the three-schema selection brings `jmc` back. |
| `npm run staging:archive-drill` | Runs `scripts/db-restore-archive.sh` against a **directory standing in for the bucket**: select an object, download it, compare sizes, decrypt, verify the gzip stream, restore, count, clean up. | The restore-proof tooling works, including every refusal. |
| *(nothing yet)* | Fetch a real object from R2 with read-only credentials and the real age identity. | **That the clinic's archive is readable.** Not done. W9. `ROLLOUT.md` §8.1. |

The rehearsal runs in its own container — `postgres:17` plus `age` and
`rclone`, built once from `scripts/staging/archive-restore.Dockerfile` — for
the same reason the restore drill does: it runs the real bash script rather
than a Windows reimplementation of it, and a rehearsal of a reimplementation
rehearses the reimplementation. The first run builds the image and needs the
network for one `apt-get`. Nothing after that step reaches a network at all.

What it sets up, and why each piece is there:

- **A directory as the bucket.** `rclone` addresses a local path as a remote,
  so the same `lsf` and `copyto` calls run that will run against R2. No MinIO,
  no second container, no credential.
- **A throwaway age identity**, generated per run by `age-keygen` and destroyed
  with the temporary directory. A second, wrong identity exists so that
  "decrypts with the wrong key" can be tested rather than assumed.
- **Two objects built from one dump.** The older object is the dump. The newer
  one is the dump plus a marker table that exists nowhere else on the machine,
  and every plaintext copy is deleted before the first case runs. Selecting the
  newest restores one more table than selecting the older by name, and each
  run's reported SHA-256 matches the object it claims to have fetched. That is
  what stops the rehearsal passing because it restored the dump lying next to
  it, which is precisely the flaw in the nightly drill that W9 exists to fix.
- **Recording shims for `rclone` and `psql`**, so "it issues no write to the
  bucket" and "it refuses a non-loopback target before any database command"
  are assertions about what actually ran, not greps over the source.

Eighty-five checks. The failures are as important as the success: an empty
prefix, a prefix that will not list, a prefix holding exactly one object, a
missing object, an unencrypted `.sql.gz`, a wrong extension, path traversal, a
cross-prefix name, shell metacharacters, control characters, a zero-byte
object, a short transfer, corrupted ciphertext, a wrong identity, a broken
gzip stream, unloadable SQL, a non-loopback target, the live and staging
database names, a database that already exists, and an environment carrying the
backup writer's credentials. Each one also asserts that the temporary files and
the scratch database are gone afterwards.

The restore target is a PostgreSQL 17 started inside the rehearsal container on
its own loopback, never the staging container, and its database name is
generated as `clinic_restore_drill_archive_<random>` — which is what
`scripts/staging/guard.mjs` already allows and what nothing else uses.

## 6. What is still missing

Named rather than implied, in the register `docs/README.md` §6 uses.

**The browser suite is now in CI, and has never run there.** `.github/workflows/ci.yml`
gained a `browser` job: Node 24, `npm ci`, Chrome pinned to `131.0.6778.85` by
`browser-actions/setup-chrome`, and `npm run test:browser` with
`AGENT_BROWSER_EXECUTABLE_PATH` pointing at it, so the driver takes the browser
by path instead of discovering whatever the runner image happens to ship. It
has no `services: postgres` block, unlike the `database` job, because
`up.mjs` creates its own `jmc-staging` container on 55432 and a service
container on the same host port would collide before a migration ran.

Nothing in this programme has been pushed, so no runner has executed that job.
Chrome headless on a GitHub runner has failure modes a laptop cannot reproduce
— sandbox flags, missing fonts, the shared-memory size that makes it fall over
in a container — and none of them have been ruled out here. Treat it as a job
that reports rather than a gate, and make it a required check only after it has
been green twice.

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

**`supabase start` is still not set up**, and Slice 5 went around it. There is
no `supabase/config.toml`; the full stack — Auth, Storage, PostgREST, the Deno
edge runtime — is eleven containers, and clinical images needed one of them.
So `storage.ts` writes through Supabase Storage when it is configured and to
the directory named by `CLINIC_IMAGE_ROOT` when it is not, and the gate points
that at a temporary directory it deletes afterwards.

That exercises this application's rules — the ticket, the checksum, the
role check, the audit row — against a real filesystem. It says nothing about
Supabase's: that the bucket is private, that an anonymous GET is refused, that
no service key reaches the browser. §`docs/operations/ROLLOUT.md` §7 carries that as a
deployment check, because it can only be answered where the bucket is.

---

## 7. The checks that belong to a deployment, not to staging

Staging can prove the clinic's logic. It cannot prove the things that are true
only of the deployed artefact and the deployed project, and those have their
own short list. `docs/operations/ROLLOUT.md` is the operating document; this is the part of it
that is about this repository.

### 7.1 What is in the bundle

A static export bakes its configuration in at build time, so the deployed
JavaScript is the only place the question can be asked:

```bash
# The live project must not appear in a build made anywhere but the deploy.
grep -rIl "supabase.co\|service_role\|eyJhbGciOi" out/ || echo "clean"

# What the page will actually call.
grep -rho "https\?://[^\"']*functions/v1" out/ | sort -u
```

The browser gate does this for itself before it will serve a page — see §5's
third guard — and refuses if the live project appears. Do the same by hand
before a deploy, because the gate is not what publishes `out/`.

### 7.2 What Storage will allow

`storage.ts` runs against a directory under `CLINIC_IMAGE_ROOT` in staging, so
every rule this application enforces is exercised and none of Supabase's are.
At the project, once:

- the bucket is **private** — an anonymous GET of a known object path is
  refused;
- the service key is in the Edge Function environment and **not** in any
  `NEXT_PUBLIC_` variable;
- no bucket policy grants `anon` or `authenticated` read.

A durable, shareable image URL is the failure this design exists to prevent.
If one can be produced by any means, stop and fix it before the feature is
switched on for the clinic.

**Slice 4 adds a second area and the same paragraph applies to it.** Result
documents — the PDF the laboratory emailed, the scan of the paper report — go
to their own bucket (`CLINIC_DOCUMENT_BUCKET`, default `result-documents`) and
their own staging directory (`CLINIC_DOCUMENT_ROOT`, which
`scripts/staging/functions-server.mjs` creates alongside the image one). Two
areas rather than two prefixes, because photographs and received reports are
governed by different owner items and a retention decision about one must not
be able to reach the other. Both buckets need the same three checks above, and
`result_documents` has **no URL column at all** — a test walks
`information_schema.columns` across all six Slice 4 tables asserting that none
of them is named like one.

### 7.3 What the database role is

`§7.4` of `SCHEMA_AND_TYPES.md` sets out the whole argument. The short version:
the application is written and tested against the pessimistic case — a role
that is neither superuser nor `BYPASSRLS` — so it works either way, but nobody
here has read what the deployed role actually is, because nothing in this
programme queries production. Preflight query 7 in `docs/operations/ROLLOUT.md` reads it. It
returns five booleans and no clinic data.

### 7.4 What a printer does

Print layout is checked in a browser at A4 and at 80 mm widths, which proves
the CSS and proves nothing about paper. Margins, page breaks in a long medicine
list, and whether a reprint is legibly marked as one are answered by an HP
Smart Tank 580 with paper in it. `docs/operations/ROLLOUT.md` §7 keeps that open, and it should
stay open until somebody in Chennai holds the page.
