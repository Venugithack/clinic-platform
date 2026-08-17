# Build plan — M0, and the gates after it

`PLAN.md` is the what. This is the how, starting from an empty directory.

**Status: M0–M6, M8, M9 and M11 built, 17 Aug 2026** — foundations, clinic
core, the live link, inventory, billing with the till, supplier purchasing,
presence, the legal registers, hardening, and the whole of the go-live
tooling: drug master, settings, staff and devices, corrections, and opening
stock. See §5–§18. **Every line of `PLAN.md` §16 that is code is now built.** **M7 (patient WhatsApp) is deferred at the client's request** — the
doctor has asked to leave patient messaging to a later phase, and it is the one
milestone that could not start on the developer's side anyway. `PLAN.md` §20 is
still unsigned; §0 below lists what must be true before the clinic runs on
this.

Local-first, per `HOSTING.md` §1a: Supabase in Docker, Next on the LAN, both
tablets on the clinic Wi-Fi. No hosting account, no Meta account, no spend until
M7.

---

## 0. Before day 1

### ~~One decision that genuinely blocks the first migration~~ — answered

**`PLAN.md` §18 Q15 — is this a one-off, or the first customer of a product?**

**Answered 16 Aug 2026: a one-off. Single-tenant.** Venu's call, taken against
the recommendation below, which is recorded as it stood.

| | One-off ← **chosen** | Multi-tenant from day 1 |
|---|---|---|
| Schema | no `clinic_id` | `clinic_id` on every table, in every RLS policy, in every transition |
| Cost now | — | **~3 days** |
| Cost later | — | **weeks.** Backfilling a tenant key through a live ledger, live RLS and twelve transitions, against real patient data |

*Recommendation as written: multi-tenant from day 1. Three days now against weeks
later is a cheap option on a second customer ever existing, and the clinic pays
nothing for it — a single-tenant deployment with a tenant column is
indistinguishable from one without.*

**What the decision costs, now that it is made.** The cost curve has turned: the
first migration is applied, and a second clinic is no longer a schema option
that can be taken cheaply. If one is ever wanted, the honest estimate is weeks,
not three days, and it is a migration against live patient data. The `clinic`
table is deliberately a single-row singleton with a check constraint saying so,
so the assumption is stated in the schema rather than merely absent from it.

### Non-code items to start this week

None of these need signature, all of them have lead times.

| Item | Owner | Why now |
|---|---|---|
| **Model number of the clinic's A4 printer** | doctor | If it is USB-only it cannot print from a tablet at all (`TABLET.md` §1). A purchase decision, not a go-live discovery |
| **Resolve the verification question** against Meta's own docs — the four points in `WHATSAPP.md` §0 | Venu, ~20 min | Could remove the longest pole in `PLAN.md` §9 entirely |
| **Order the two tablets and stands** | doctor | ~1 week to arrive, and M0's HTTPS setup wants them |
| **Start the drug master** from the last 6 months of purchase invoices | doctor | The real bottleneck, 1–2 weeks of his time (`INVENTORY.md` §9) |
| **§20 sign-off**, and the three open questions in §18.1 | both | Day 1 is defined as the day this is signed |

---

## 1. M0 — foundations

**7 days** (was 5; the plpgsql harness, PIN auth and the LAN certificate are
new). Nothing in M1 starts until every box in §1.8 is ticked.

### 1.1 Repo and toolchain — day 1

Next 16 · React 19 · TypeScript strict · Tailwind 4 · pnpm.

```
app/
  (clinic)/        authenticated clinic screens — consult, counter
  p/               patient portal, public, default-deny (rule 7)
  now/             public status page
components/
lib/
  db/              the ONLY module that talks to Supabase        (rule 1)
  transitions/     thin TS wrappers over the plpgsql RPCs        (rule 2)
  realtime/        adapter — swappable                (HOSTING.md §7)
  auth/            adapter — swappable                (HOSTING.md §7)
  units/           base-unit conversion             (INVENTORY.md §1)
supabase/
  migrations/      every schema change, forward-only
  functions/       edge functions — WhatsApp webhook, later
  tests/           pgTAP
e2e/               Playwright, tablet viewport only
```

The layout is the enforcement mechanism for rules 1 and 2. A lint rule fails any
import of `@supabase/*` from outside `lib/db/**`.

### 1.2 Local Supabase — day 1

`supabase init` then `supabase start`. Postgres, Auth, Realtime and Studio come
up in Docker.

**Migration-first, without exception.** Every schema change is a file in
`supabase/migrations/`. Nothing is clicked in Studio and kept. This is what makes
`supabase db push` to any host a non-event later.

### 1.3 HTTPS on the LAN — day 1, not later

The trap in `HOSTING.md` §1a. Camera, service workers and PWA install all need a
secure context, and `http://192.168.x.x` is not one.

1. Static DHCP reservation for the dev machine on the clinic router.
2. `mkcert` a certificate for that hostname.
3. Install the root CA on both tablets — once, five minutes each.

Done on day 1 it costs an hour. Discovered in M3 it costs a day and looks like a
defect.

### 1.4 The schema — days 2–3

Core tables from `PLAN.md` §7, and **`INVENTORY.md` §1 lands in the first
migration, not a later one**: `base_unit` on the drug; `units_per_strip`,
`strips_per_box`, `mrp` and `cost_per_base_unit` on the **batch**. Every quantity
column in the database is in base units, named so it cannot be mistaken
(`qty_base`, never `qty`).

RLS on every table **in the same migration that creates it.** Retrofitted RLS is
how a table ends up readable.

### 1.5 The transition harness — days 3–4

Build **one** transition end to end as the pattern the other eleven copy:

- a `plpgsql` function, `SECURITY DEFINER`, doing its state change and writing
  its `audit_log` row in the same transaction;
- direct `INSERT`/`UPDATE` grants revoked on the tables it owns;
- a thin typed wrapper in `lib/transitions/`;
- a pgTAP test proving the audit row exists, and a second proving a direct write
  is *refused*.

That second test is the point. It is what converts rules 2 and 3 from convention
into something Postgres enforces.

Use `dispense` — it is the one with real invariants (FEFO, expiry, H1, stock
never negative), so if the pattern survives it, it survives the rest.

### 1.6 Auth — day 5

Supabase Auth behind `lib/auth/`, plus the shared-device model from `TABLET.md`
§5: device registration, long-lived device session, 6-digit staff PIN, idle lock.
Every write carries the staff id from the PIN, because the H1 register needs a
person's name, not a tablet's.

### 1.7 CI — days 6–7

Blocking on every merge: typecheck · lint · Vitest · **pgTAP** · Playwright at
1280×800 with touch emulation · the two tablet lint rules from `TABLET.md` §8
(44 px minimum target, no `:hover`-only affordance outside `@media (hover: hover)`).

Also day 7: the backup script and **one practised restore**, locally
(`HOSTING.md` §5). It is a habit, and habits start on day 7 or never.

### 1.8 M0 is done when

- [ ] Both tablets open the app over HTTPS on the clinic Wi-Fi, installed as PWAs
- [ ] A staff member unlocks with a PIN on a registered device
- [ ] A row written from the UI produces an `audit_log` row naming that person
- [ ] A direct write to a transition-owned table is **refused** by Postgres, and a pgTAP test asserts it
- [ ] `pnpm test` runs unit, pgTAP and Playwright green
- [ ] CI blocks a deliberately broken merge
- [ ] A `pg_dump` has been taken and restored, and row counts match

---

## 2. The gates after M0

Detail lives in `PLAN.md` §8. What matters here is what each module must prove
before the next starts.

| | Module | Days | Proves |
|---|---|---|---|
| **M1** | Clinic core | 4 | Doctor registers a walk-in, consults, signs an Rx, and it prints on the clinic's actual printer at A4 |
| **M2** | **Doctor ↔ counter live link** | 4 | Rx signed on tablet A is on tablet B in under a second, in the two real rooms, over the clinic Wi-Fi. Counter raises "out of stock", doctor answers without leaving the consult screen |
| **M3** | Inventory | 6 + 12 | Two batches, different expiries, different MRPs, different strip sizes — dispensing takes the earlier, charges the right MRP, and the ledger reconciles. An expired batch is refused. A barcode scan at dispense stops the wrong box |
| **M4** | Billing, counter sale, till | 4 | A bill prints for a consult plus 4 medicines across 2 batches; the day's total matches the sum of its bills; the till reconciles against counted cash — **proved in `e2e/m4-gate.spec.ts`, §9** |

**M2 is the demo.** It is the feature the doctor bought and the first moment the
build justifies itself in the room. Show it the day it works.

**M3 starts at `INVENTORY.md` §1** and nowhere else. The base-unit model is not a
feature that can be retrofitted onto recorded stock.

**Deploy once around M4**, to a throwaway environment (`HOSTING.md` §1a). Not to
choose hosting — to find out early what differs once deployed: realtime latency,
certificate behaviour, PWA install from a real origin, printing.

---

## 3. What is blocked, and on whom

| Blocked | On | Until then |
|---|---|---|
| ~~First migration~~ | ~~Venu — Q15, multi-tenant or not~~ | **Unblocked 16 Aug 2026** — single-tenant. M0 is built; see §5 |
| ~~M3 completion~~ → M3 **go-live** | doctor — drug master with salt and strength | **The code is built** (§8, 16 Aug 2026) against a 22-drug seed and the schema does not care. What the drug master now blocks is the clinic using it, not the build continuing |
| M4 GST | deferred by Q4 | Fields captured, calculation off |
| M5 supplier orders | nothing — deep-link mode needs no Meta account | Ships during the local build |
| M7 patient WhatsApp | Meta verification, *if* required (`WHATSAPP.md` §0) | Everything else proceeds |
| Hosting choice | deliberately deferred | Adapters keep every option open |

---

## 4. Working agreements

| | |
|---|---|
| **Branch per module**, merged when its gate is green | The gates are the review, not a diff |
| **Migrations forward-only**, each with a written down-path | `PLAN.md` §16 |
| **No clinical inference, ever** | Rule 8. The doctor's sign-off (A8) lifts it for artefacts he has personally reviewed, and for nothing else |
| **Screens are built at 1280×800 touch from the first commit** | Not a desktop layout made responsive afterwards (`TABLET.md`) |
| **Show the doctor M2 the day it works** | Momentum, and it is the cheapest possible moment to hear "actually, what I meant was…" |

---

## 5. M0 status — built 16 Aug 2026

Everything in §1 that does not require the clinic's own hardware is written,
running and green. What is in the repository:

| §1.x | Delivered |
|---|---|
| 1.1 | Next 16 · React 19 · TS strict · Tailwind 4 · pnpm, in the §1.1 layout. The seam is an ESLint rule: `@supabase/*` cannot be imported outside `lib/db/**`, and `.rpc()` cannot be called outside `lib/transitions` |
| 1.2 | Seven forward-only migrations under `supabase/migrations/`, applied by `scripts/db-migrate.sh` exactly once each. Nothing is clicked in Studio and kept |
| 1.4 | Core tables from `PLAN.md` §7, single-tenant. `INVENTORY.md` §1 is in the first migration, not a later one: `base_unit` on the drug; `units_per_strip`, `strips_per_box`, `mrp`, `cost_per_base_unit` on the **batch**. Every quantity column is `qty_base`. RLS on every table in the migration that creates it |
| 1.5 | `app.dispense` — plpgsql, `SECURITY DEFINER`, FEFO across batches, expired stock excluded rather than flagged, Schedule H1 refused on a counter sale, stock never negative, line total clamped to the MRP ceiling, audit row written inside the same transaction |
| 1.6 | Registered device + 6-digit PIN + idle lock (`TABLET.md` §5). `app.current_staff_id()` resolves the PIN session first and the device's auth user only as a fallback, so `audit_log` names a person rather than a tablet |
| 1.7 | GitHub Actions blocking on typecheck · lint · Vitest · pgTAP · Playwright at 1280×800 touch. Backup script and restore drill run in CI on every merge |

**63 pgTAP assertions, 10 unit tests, 5 Playwright tests, all green.** The two
that matter most, both in `supabase/tests/20_transition_grants.sql`: a direct
write to `stock_movements` is refused by Postgres with `42501`, and the very
same role can still call `app.dispense`. That is rules 2 and 3 stopping being a
convention.

### What M0 §1.8 still needs, and it is not code

Four boxes cannot be ticked outside the clinic. They are all §1.3 or hardware:

- [ ] **§1.3 LAN HTTPS.** `scripts/lan-https.sh` is written and documents the
  router reservation and the root-CA install on both tablets. It has to be run
  in the clinic, on the clinic Wi-Fi.
- [ ] Both tablets open the app over HTTPS and install as PWAs
- [ ] A staff member unlocks with a PIN **on the real tablets**
- [ ] The A4 printer model number is checked — a tablet cannot print over USB

Until §1.3 is done, the camera, the service worker and PWA install all fail
silently on the tablets. That is the trap the section exists to avoid, and it is
an hour on day 1 against a day in M3.

### The one honest gap

`app.dispense` is the reference transition and the other eleven copy it, but
they are M3–M5 work and are not written. The lint rule that forbids `.rpc()`
outside `lib/transitions` is what keeps a screen from inventing its own path to
the tables in the meantime.

---

## 6. M1 status — clinic core, built 16 Aug 2026

**Gate:** *"Doctor registers a walk-in, consults, signs an Rx, and it prints on
the clinic's actual printer at A4."* Everything except the last five words is
built and covered end to end by a Playwright test at 1280×800 with touch,
against a real Postgres with real RLS and the real transitions.

| Delivered | |
|---|---|
| **Queue** | The default screen on both tablets. Big rows, token dominant, one tap to open. Allergies are legible from the queue, before the record is opened |
| **Walk-in registration** | Name, phone, age, sex, allergies, and DPDP consent as a deliberate recorded step (§15.1) — registration is blocked until it is given. A phone already on file offers a chooser rather than an answer, because families share one handset |
| **Consult** | Three panes: patient history and allergies, the form, and the rail with Sign Rx. Diagnosis, advice and follow-up, all typed |
| **Rx composer** | Full-screen drug search overlay, results in the top half above the keyboard, matching brand, generic and salt at three characters, with the frequent list before anything is typed. Quantities on the app's own numpad, converting strips and boxes to base units live |
| **Print** | A4, in millimetres. Clinic header, prescriber and registration number, and a signature block with real space in it — A7 makes the hand-signed sheet the legal document |

**Three transitions**, each with its invariant in plpgsql rather than in a form:
`book_appointment` allocates the day's token under an advisory lock so two
simultaneous walk-ins both get a number; `set_appointment_status` refuses a
queue that walks backwards; `sign_prescription` closes the prescription — only
the prescriber can sign it, an empty one cannot be signed, and a signed one
cannot be edited by anybody, including the doctor who signed it.

**91 pgTAP assertions, 10 unit tests, 8 Playwright tests, all green.**

### One thing built earlier than planned

The **live stock badge in the composer** (`PLAN.md` §11.2) was scheduled for M2
with real numbers wired in M3. It reads `available_stock`, which already exists
and already excludes expired batches, so it cost one view — and a composer that
shows what is on the shelf is the difference between prescribing and guessing.

### Three bugs the tests caught

Worth recording because each was invisible to the layer above it:

1. A plpgsql parameter `DEFAULT` does not apply when the caller passes an
   explicit `null`, and a JSON-RPC caller sends `{"p_date": null}` rather than
   omitting the key. Every registration from the browser failed on a not-null
   constraint; every pgTAP test passed, because they all omitted the argument.
2. `process.env[name]` with a dynamic key is not inlined by Next at build time,
   so the browser bundle had no database URL at all. Silent at build, total at
   runtime.
3. A request that neither succeeds nor fails left the lock screen empty
   forever, with no staff and no explanation. Every request is now bounded at
   12 seconds — the free tier has no SLA, so this is not hypothetical.

### Still outstanding, and still not code

The M1 gate does not close until the prescription prints on the clinic's own A4
printer, and that is now the riskiest open item in the build.

**16 Aug 2026 — resolved, and it went the good way.** The clinic's A4 is a
Bluetooth printer **and** has Wi-Fi/Ethernet. Nothing to buy, nothing to build:
the tablets reach it over the clinic Wi-Fi and the Bluetooth radio is never
used.

It is worth recording how close this came to being expensive. Bluetooth is not
a network, and had the printer been Bluetooth-only it would have been as
unusable as USB — Web Bluetooth is BLE-only and cannot speak the Classic SPP
that thermal printers use; Web Serial can, but only on desktop Chrome, not
Android; and Mopria, which is what `window.print()` reaches on Android,
excludes Bluetooth outright (`TABLET.md` §1). The word "Bluetooth" nearly read
as reassurance when it was the opposite.

**One residual step, added to the M0 §1.3 tablet setup:** Android does not
discover network printers by itself. It needs Mopria Print Service, or the
manufacturer's own plugin, installed on each tablet. Without one the print
dialog finds nothing and the printer looks broken when it is not.

So the M1 gate now needs exactly one thing, and it is ten minutes in the
clinic: install the plugin on both tablets and print one real prescription.

---

## 7. M2 status — the live link, built 16 Aug 2026

**This is the demo.** It is the feature the doctor bought and the first moment
the build justifies itself in the room (§4). Show it the day it works.

**Gate:** *"Rx signed on tablet A is on tablet B in under a second, in the two
real rooms, over the clinic Wi-Fi. Counter raises 'out of stock', doctor answers
without leaving the consult screen."*

Both halves are built and covered by a Playwright test driving **two browser
contexts** — separate storage, separate PIN sessions, separate subscriptions,
because one context proves nothing about a link between two devices. Measured
latency on the loopback stack is **126–166 ms**, and the test fails above 1.5 s
so a regression to polling breaks the build rather than quietly costing a
second.

| Delivered | |
|---|---|
| **Pharmacy queue** | Newest signed prescription at the top, arriving live, colour-coded full / partial / out. The colour is computed in the view, so the counter and the doctor cannot disagree about what "partial" means |
| **The return leg** | The counter raises out-of-stock, proposes a substitute, or asks a question. One open question per line |
| **The doctor's answer** | A strip above every clinic screen, not just the consult — the doctor is rarely still on that patient when the pharmacist reaches the shelf. Approve, amend or reject, then back to what they were doing |
| **Substitution** | Same salt, same strength, same form, or nothing — enforced on **both** ends of the loop, so neither a wrong screen nor a hand-written call can widen it (INVENTORY.md §7) |

Two tables and four transitions, exactly as §11.1 predicted:
`prescriptions` + `counter_queries`, and `sign_prescription` + `raise` +
`answer` + `withdraw`.

### Realtime is now real, and so is the exit ramp

`lib/realtime` had been an adapter with nothing behind it. It now ships two:
Supabase Realtime for production, and a WebSocket adapter over Postgres
`LISTEN/NOTIFY` for local development and the E2E suite. HOSTING.md §7's promise
— *"swap for a WS server without touching a screen"* — is therefore exercised on
every test run rather than asserted in a document, and the fallback it names
actually exists.

A change carries an **id, never a row**. The realtime payload does not pass
through RLS, so handing it to a screen would hand over fields the reader's
policies might not allow; screens are told that something changed and re-read it
through `lib/db`.

**What this does not prove** is the clause about the two real rooms. Wi-Fi
latency, a tablet's radio sleeping and the range from the cabin to the counter
are physical facts, and §2 already schedules that check for the throwaway deploy
around M4.

### A failure mode worth keeping

The E2E suite depended on a dev API somebody had started earlier. When an
orphaned PostgREST outlived its parent it kept the port and served a schema
cache from **before** the latest migration — so a transition that psql could see
perfectly well returned "could not find the function", and a button on the
counter screen quietly did nothing.

`scripts/dev-stack.sh` now owns the whole stack, kills orphans, and refuses to
report itself ready until every transition the app calls is visible through the
API. That class of bug is silent by nature; the probe is what makes it loud.

---

## 8. M3 status — inventory, complete, 16 Aug 2026

M3 is the centrepiece and the largest milestone in the plan — 6 days in
`PLAN.md` §8 plus 12 in `INVENTORY.md` §10. This slice closes its gate; the rest
follows below.

**Gate:** *"Two batches, different expiries, different MRPs, different strip
sizes — dispensing takes the earlier, charges the right MRP, and the ledger
reconciles. An expired batch is refused. A barcode scan at dispense stops the
wrong box."* **All of it green**, driven across two browser contexts against a
real Postgres.

| Delivered | |
|---|---|
| **`app.receive_goods`** | Packs in, base units stored — the one conversion, at the one boundary. Weighted average cost, with free goods diluting it across everything that arrived rather than arriving at zero |
| **Two refusals that catch a typo** | A batch already expired cannot be received, and neither can one expiring earlier than a batch already dispensed against. Both exist because a mistyped year is silent and expensive: FEFO then hands out the wrong box for the life of that batch |
| **The quick GRN** | Stock on the shelf with the invoice not yet entered is a daily occurrence. It posts a real receipt flagged `awaiting_invoice`, so there is a work queue instead of a negative shelf (INVENTORY.md §3) |
| **Barcodes** | One meaning per code; the first scan of an unknown one asks which drug it is and remembers. A code already registered to one drug cannot be quietly re-pointed at another — that is the failure that would make a scan *look* like it worked |
| **Scan-to-verify at dispense** | The safety feature worth naming to the doctor. Wrong drug is a red flash and a stop, the only place in the app that uses that treatment. A line with no barcode yet needs a deliberate second gesture rather than blocking the counter |
| **FEFO shown before it is committed** | The counter reads "take 10 from DL2503B (exp Nov 2026)" — which box to reach for, decided by expiry rather than by what is at the front of the shelf |
| **Valuation and margin** | `stock_valuation` and `dispense_margin`. Because the ledger records which batch each unit left from, cost of goods sold is exact rather than estimated (INVENTORY.md §4) |

**Camera caveat:** scanning is exercised through the manual-entry path.
`BarcodeDetector` and `getUserMedia` do not exist in headless Chromium — and
`getUserMedia` does not exist over `http://192.168.x.x` either, so the camera is
one more thing that depends on the LAN certificate in §1.3. Manual entry is real
functionality rather than a test hook: a scuffed strip or a denied permission
must leave the counter working.

### What M3 owed after the first slice, and where it landed

| Scope | `INVENTORY.md` | |
|---|---|---|
| Counter sale — walk-in, no prescription | §3, `PLAN.md` §18 Q3 | second slice |
| Blind stock-take with variance, recount and approval | §5 | second slice |
| Expiry returns, supplier credit notes, write-offs | §6 | third slice |
| Reorder intelligence and supplier price history | §8 | third slice |
| The goods-receipt **screen** (the transition was already done) | §2 | third slice |

The till and the cash day-close stay in M4 with the rest of billing, which is
where `PLAN.md` §8 put them. The counter sale moves stock and records what it
sold for; it does not pretend to be a till.

### Second slice — stock-take done, counter sale NOT

**The blind stock-take is complete** and behaves the way `INVENTORY.md` §5 asks:

| | |
|---|---|
| Blind, enforced | The counting role has no `SELECT` privilege on the expected quantity — column grants, not a screen politely looking away. A screen that decided to peek gets an error |
| Variance, by rupee value | Five missing thyroid tablets outrank twenty-two missing paracetamol. Sorting by count buries the one that matters, which is why this report is the theft-and-drift detector |
| Recount is a gate | Anything over the threshold is counted again before anything can post. Not a warning — the approval refuses |
| Only the doctor posts | And only then does one `adjust` movement per batch reach the ledger, carrying the take id as its reason |
| The counter keeps working | A count in progress moves no stock, and each line's variance is measured against the shelf as it was when the person stood in front of it |

One design mistake worth recording: the first cut made the variance view
`security_invoker`, so it ran as the counting role — which the column grant had
just denied the expected quantity. Blindness enforced so hard that the report
could never be produced. The two mechanisms now split the job properly: the
column grant stops direct reads, and the view's `WHERE` decides when the numbers
exist at all.

### The counter sale, and the bug that was hiding behind every success path

The counter sale is done: a walk-in buys, the total is right to the paise, the
ledger is written, and Schedule H1 is refused — by the database, not by the
screen.

Getting there turned up the most serious defect found in the build so far, and
it is worth writing down because of *how* it hid.

**PostgREST reserves SQLSTATEs beginning `PT`**, and reads the three characters
after the prefix as the HTTP status to return. Every transition in this build
raised `PT001`…`PT015`. So a Schedule H1 refusal (`PT003`) asked PostgREST for
HTTP status **3**. The response never framed, the browser's `fetch` neither
resolved nor rejected, and the counter screen sat on "Selling…" telling the
pharmacist nothing at all.

Every refusal in the build was affected. Stock never negative, expired batch,
MRP ceiling, H1, wrong prescriber, already signed, expiry in the past — none of
them could reach a screen. **Only the success paths worked**, which is exactly
why it survived M0, M1 and M2: no browser test had ever exercised a refusal.
pgTAP could not see it either, because pgTAP talks to Postgres directly and
never goes through PostgREST at all.

Two false trails on the way, both fixed on their own merits and neither the
cause: the dev proxy forwarding hop-by-hop headers, and its stubbed auth
endpoints answering 404 where a real auth server answers 400. The thing that
actually cracked it was noticing that the *successful* sale worked from the same
screen, so it was never the screen — and that the earlier proxy crash had said
`Invalid status code: 3` for `PT003`.

The codes are now `CL001`…`CL015`, and `20260816090600_transition_dispense.sql`
carries the reason so nobody shortens the prefix back. `e2e/m3-inventory.spec.ts`
holds the regression guard: a refusal has to reach the pharmacist as a sentence.

**The lesson for the remaining milestones:** a refusal is a feature, and every
one of them needs a browser test. A suite that only ever asserts success will
pass while every error in the system is invisible.

Three dev-stack faults *were* found and fixed on the way, all of which had made
failures point somewhere other than their cause: an orphaned PostgREST serving a
pre-migration schema cache, a proxy crash that took the whole stack down
mid-run, and no readiness probe to make either loud.

### Third slice — expiry, purchasing intelligence, and the receiving screen

**M3 is complete.** Three things closed it, and the first one is where the money
in `INVENTORY.md` actually is.

#### Expiry, worked all the way through (§6)

The section opens by pointing out that `PLAN.md` §12.3 defines `expiring_soon`
and never says what anybody does about it. Working it through turned up
something sharper than a missing workflow: **the date that decides whether stock
can go back to the supplier is not the expiry date.**

Distributors want stock returned some months *before* it expires so the claim
can be processed while the drug is still good — three to six months, and it
differs per supplier. So the deadline is `expiry - return_window_days`, and a
list built on "90 days from expiry" is already three months too late for a
supplier with a 180-day window. That is why §6 says the list is grouped by whose
window closes first, *not merely by expiry date*, and it is the whole reason the
section pays for itself.

The seed now carries both cases on purpose. Shelcal expires in about seven
months and is urgent — Kumar's door shuts in a few weeks. Zincovit expires in
six and nothing can be done: the window closed months ago, quietly, and under
the old design nobody would ever have been told.

| | |
|---|---|
| `expiring_soon` | Ordered by the supplier deadline. A closed window only surfaces once the stock is genuinely near expiry, because "you missed this a year early" is noise |
| `expired_stock` | Availability excludes expired batches by design (§3), which means that without this list they are on the shelf, on the books and on **no screen at all** |
| `app.return_to_supplier` | Stock out through the ledger, credit opened in the same transaction. A return note without a credit is how a clinic forgets it is owed money |
| `app.write_off_expired` | At cost, and it returns what it cost him — a write-off that does not name the loss teaches nobody anything |
| `app.settle_credit` | Netted off a later invoice, partially where that is what happened, so unreturned credits stay visible instead of forgotten |

Two refusals, both with a browser test: a return after the window shut (`CL016`,
which names the date it shut), and a write-off of stock that has not expired
(`CL017`). The second one matters more than it looks — six weeks of sellable
Zincovit is worth more than the tidiness of writing it off, and "no recorded
return window" is treated as *not knowing*, not as *any time*.

#### Reordering that learns, and still never acts alone (§8)

Consumption velocity from the ledger, **measured** supplier lead time, a buffer
sized from that supplier's own inconsistency rather than a flat 1.5× for
everyone, stockout history, and the last five purchase prices per drug per
supplier on the line.

Two things were worth getting right:

- **A claim is never presented as a measurement.** `supplier_lead_time.source`
  is `measured`, `claimed` or `assumed`, and below three real deliveries the
  view says so and uses the supplier's own figure. The seed supplier claims two
  days; the pgTAP fixture measures six.
- **Rule 4 is enforced by shape, not by discipline.** `app.draft_purchase_orders`
  creates drafts and nothing else, and a test asserts that exactly one function
  in the `app` schema touches purchase orders at all. The moment these numbers
  can reach a supplier unattended, one bad reorder level costs real money.

`purchase_orders` and `po_lines` are created here because measured lead time is
`sent_at → received_at` and there is nothing to measure without them. Everything
past `draft` — approval, the WhatsApp send, the acknowledgement, receiving
against a PO — is **M5** and is deliberately not built.

#### The goods-receipt screen (§2, `TABLET.md` §7)

The heaviest data entry in the build, and the one place a typo is expensive for
years. Scan first; the OS keyboard appears for exactly one field, the batch
number. Expiry is a month and a year tapped as buttons, because the strip prints
`MAR 2027` and a date picker asks for a day nobody has.

The detail worth keeping: **last year is on the year row.** A form that only
offers valid years does not catch a mistyped expiry — it makes the pharmacist
pick a plausible one instead, and a wrong date that looks right is exactly what
`CL011` exists to stop. Let it be entered, and let the database refuse it by
name and date. That refusal has a browser test too.

Cost is entered as the rate printed on the invoice — per strip — and divided
down in `lib/units`, which is the one module allowed to know what a strip is.
Four decimal places, because ₹9.99 for a strip of 30 is ₹0.333 a tablet and
rounding it to the paise puts a thousand tablets ₹3 short on the balance sheet.

#### One more fault in the harness, and it is the same fault as before

The readiness probe added in the first slice checked the API's RPC surface
exactly once, immediately after PostgREST printed its startup banner. PostgREST
starts listening *before* it has built the schema cache and answers `503` in
between, so the probe was a race — and one that gets slower to win as the schema
grows. Two migrations later it started losing, and reported "the schema cache is
stale" about a cache that was a second away from being correct.

It polls now, for up to fifteen seconds, and it checks the newer transitions
too. Worth recording because it is the third time in this milestone that a
diagnostic pointed confidently at the wrong thing: **a check that can be flaky
is worse than no check**, because people learn to re-run it.

**M3 totals:** 17 migrations, 222 pgTAP assertions, 12 unit tests, 23 Playwright
tests across five specs, nothing skipped.

---

## 9. M4 status — billing, the day-book and the till, built 16 Aug 2026

**Built and green.** The gate, verbatim from §2: *"A bill prints correctly for a
consult plus 4 medicines across 2 batches; the day's total matches the sum of
its bills; the till reconciles against counted cash."* All three run in
`e2e/m4-gate.spec.ts`, through the screens.

| | |
|---|---|
| Migrations | `20260816230100_billing.sql`, `20260816230200_till_and_daybook.sql` |
| Transitions | `raise_bill` · `take_payment` · `void_bill` · `open_till` · `record_cash` · `close_till` |
| Screens | `/billing` · `/bill/[id]/print` (A4 and 80mm) · `/day-book` |
| Tests | 35 new pgTAP assertions, 3 new Playwright tests |

### Four decisions worth defending

**The bill number is gapless, and a sequence is the wrong tool.** A tax invoice
series has to be unbroken, and a Postgres sequence consumes its value on a
transaction that then rolls back — leaving a hole nobody can explain to an
inspector. So the counter is a row taken `for update` inside the same
transaction; a rollback hands the number back. It serialises billing, which at
sixty bills a day is nothing.

**Rounding goes down, never up.** Bills round to the rupee. Rounding *up* can
push a line past the MRP printed on the strip, and selling above MRP is illegal
— so the paise are dropped. It costs the clinic under fifty paise a bill and
removes a category of problem. The setting can switch rounding off; it cannot
make it round up.

**A cancelled bill keeps its number.** Deleting one puts a hole in the series,
which is the single thing the series exists to prevent. Cancellation is a status
with a reason and a person. A *paid* bill can only be cancelled by the doctor,
because that is a refund and the cash has to come back out of a drawer somebody
is counting — which the transition also insists on.

**The till stores the count and the expectation, and never reconciles one to
the other.** A drawer that is never counted cannot tell a mistake from a theft,
and a system that quietly adjusts the count to match itself destroys the only
signal there is. Petty cash in and out is recorded with a mandatory reason, for
the same reason: an unexplained payout is indistinguishable from a shortfall.

### Two bugs, and what they have in common

**A transition returns a row, not a graph.** `app.raise_bill` returns `bills`,
so the object handed back has no `lines` — but the screen rendered
`bill.lines.map(...)` and took itself down with "This page couldn't load". The
fix was one line; the durable fix was typing the transition wrapper as `BillRow`
so the mistake cannot be made again, and re-reading the bill through
`lib/db/billing.getBill` when the lines are actually wanted.

**A consult fee that silently wasn't charged.** `raise_bill` derives the fee
from clinic policy only when there is an encounter to derive it against — which
is right, since a free follow-up is measured from the *last* visit. The billing
screen was passing no encounter at all, so ticking "add the consultation"
produced a bill for the medicines alone. Nothing errored. The gate caught it
because the gate asserts an amount.

Both were invisible to pgTAP and obvious in a browser, which is the same lesson
as the `PT` prefix in §8 arriving from a different direction: **the database
being right is not the same as the clinic being billed correctly.**

### Still outstanding, and it is hardware

`PLAN.md` §18 Q9 settled the A4 printer. The **80mm roll printer has not been
bought**, so the roll layout is built and verified in the browser and has never
met a thermal printer. It goes on the `BUILD.md` §1.3 tablet-setup checklist
alongside the A4 test.

**M4 totals:** 19 migrations, 257 pgTAP assertions, 12 unit tests, 26 Playwright
tests across six specs, nothing skipped.

---

## 10. M5 status — purchasing and the supplier send, built 16 Aug 2026

**Built and green.** The gate from `PLAN.md` §8: *"Low stock drafts one PO per
supplier; approve sends a template message; supplier's reply is captured; goods
received against the PO create batches."* All four run in `e2e/m5-gate.spec.ts`.

One word of that sentence changed, and it is the whole design.

### It is a deep link, not a template

`WHATSAPP.md` §0 settled this and M5 is where it pays. Meta's rules key on **who
initiates** a conversation, not on how many messages there are. A Cloud API send
— even one a day, even approved by a human first — is a business-initiated
message, and it drags in business verification, a dedicated number,
display-name approval, pre-approved templates, opt-in machinery and a published
privacy policy. Opening `wa.me` on the doctor's own phone is a person typing to
a contact and needs **none of it**, at ₹0, with commercial use explicitly
permitted.

What the clinic loses is nothing it was paying for. Knowing *what* to order and
*when*, drafting one order per supplier, tracking the reply, tying goods to the
order — all intact. Only the send button moved, out of this app and into his
WhatsApp.

### The two honesty problems that follow, and how they are answered

**The app can never know the message was sent.** So `wa_messages.status` stops
at `handed_off`. Not `sent`, not `delivered` — claiming an event nobody observed
is exactly what rule 6 forbids, and the same rule that made presence render "as
of" makes this stop short. The purchase order *does* move to `sent`, because
that is the doctor asserting he sent it, which is a different and honest claim.

**There is no inbound webhook.** So the supplier's reply is typed in by whoever
read it. Worse than an API; much better than an order nobody is tracking, and it
is what small clinics already do.

Rule 5 — *every send is a row before a send* — is why the message is recorded
inside the transition before the client is handed anything to open. If the
tablet dies between the two, the record over-states rather than misses, which is
the correct direction to fail in.

| | |
|---|---|
| Migration | `20260816240100_purchasing.sql` |
| Transitions | `set_po_lines` · `send_purchase_order` · `record_supplier_reply` · `cancel_purchase_order` · `receive_against_po` |
| Screens | `/orders`, and `/receiving?po=…` prefilling from the order |
| Tests | 32 new pgTAP assertions, 4 new Playwright tests |

### Details worth keeping

- **The number is assigned at the send, not at the draft.** A draft is internal
  and often abandoned; numbering it burns references on orders that never
  existed. Once it has gone to a supplier it keeps that number for good.
- **Re-sending is a first-class act** — suppliers lose messages — but it must
  not move `sent_at`, because `supplier_lead_time` measures sent → received and
  a chase three days later would make the supplier look faster than they were.
- **`receive_against_po` composes `app.receive_goods`** rather than duplicating
  it. Packs become base units in exactly one place, and a goods receipt with no
  purchase order at all stays valid, because that is how half the stock is
  actually bought (§12.5).
- **The seed now leaves Reddy Pharma without a WhatsApp number**, so the `CL022`
  refusal is met in development rather than on the first day somebody needs
  stock.

### Two races found, and only one was a test's fault

The expiry screen cleared the pharmacist's selection every time its three
fetches landed, so a batch tapped while the screen was still loading silently
un-selected itself — indistinguishable, on a tablet, from a button that does not
work. The selection is now pruned to what still exists rather than reset. The
second was the M4 gate reading a table before a refresh had landed, which is the
test's problem and was fixed there.

### Not built, and deliberately

§10.4's step 2 — *"8am: one WhatsApp digest to him, 3 orders ready for
approval"* — is a **business-initiated message to the doctor**, so it is the one
piece of this milestone that does need the Cloud API and the paperwork. It waits
for M7. Low-stock detection, drafting and approval all work without it; what is
missing is only the nudge, and until then the reorder list is where he looks.

**M5 totals:** 20 migrations, 289 pgTAP assertions, 12 unit tests, 30 Playwright
tests across seven specs, nothing skipped.

---

## 11. M6 status — presence and the public status page, built 16 Aug 2026

**Built and green.** The gate: *"Doctor logs in → status live in 30s. Laptop
shut → 'away' within 5 min. Closing time → 'closed' regardless of session."*

### Presence is computed, never stored

`PLAN.md` §13.1 lists four ways "logged in = he is there" lies, and all four are
daily or weekly: he forgets to log out and goes home, he logs in from home to
check something, the laptop sleeps, he steps out for lunch. Each one ends with a
patient being told he is in the clinic when he is not — the failure that gets
the app blamed.

So the answer is derived on read, in this order:

1. **Is the clinic open at all**, by its own hours and closures? If not, the
   answer is `closed` no matter who is signed in or how recently.
2. **Has the device pinged in the last five minutes?** If not, `away`.
3. Only then, what he last said he was doing.

Two things fall out of computing rather than storing, and both are the point. A
laptop that sleeps at 19:58 reads `away` at 20:03 **with nothing scheduled**;
and closing time cannot be missed by a cron that failed to fire, because there
is no cron. The nightly job this feature would otherwise need does not exist,
which on a free tier is worth as much as the correctness.

| | |
|---|---|
| Migration | `20260816250100_presence.sql` |
| Transitions | `presence_ping` · `set_presence` · `close_clinic_today` · `reopen_clinic_today` |
| Screens | `/presence` (his control), `/now` (public, phone-first) |
| Tests | 27 new pgTAP assertions, 3 new Playwright tests |

### Three decisions

**A heartbeat may wake `away` up; it may never overwrite something he said.**
"Back by 14:30" surviving until 14:30 is the entire value of having tapped it,
and a tablet left on the desk pinging every thirty seconds must not undo it.
`presence.source` carries `auto` or `manual` and the ping respects it.

**Only a clinic device may say he is in the clinic.** His laptop at home signs
in perfectly well, sees everything he needs, and is refused `in_clinic` with
`CL023`. The rule is expressed as the absence of a device row rather than as a
check somebody has to remember to write: `app.current_device_id()` resolves from
the PIN session, so a JWT-only caller has no device and therefore no clinic
device. The seed now registers a third device — `Home laptop`, not a clinic
device — so this path is exercised in development and in the browser.

**The wording is the feature.** `/now` never says "available". Every reading is
a sentence plus the time it was true: *"Dr Seed is in the clinic — as of 2
minutes ago."* When the heartbeat is old the page says the clinic is open but it
has not heard from his tablet, and to call before travelling. The Playwright
test asserts the absence of the word "available", because that is the assertion
pgTAP cannot make and the one that protects rule 6.

### The public surface, stated plainly

`clinic_now` is **the only object in this build `anon` may select**. It carries
the clinic's name, the doctor's name, a status, an `as_of` and whether the
clinic is open — all of which are already on the door. A pgTAP test signs in as
`anon` and confirms that `presence` and `patients` both still refuse it, so the
public page is not one join away from anything about a person.

### What is deliberately still push, and still waiting

§13.3 allows exactly one outbound message: `clinic_closed`, to patients who have
an appointment today. `app.close_clinic_today` returns how many that is and the
screen names the number, because that is the actionable half. **The sending is
Cloud API and waits for M7** — as does §10.4's 8am order digest. Both are
business-initiated messages, and both are blocked on the same paperwork.

**M6 totals:** 21 migrations, 316 pgTAP assertions, 12 unit tests, 33 Playwright
tests across eight specs, nothing skipped.

---

## 12. M8 status — registers and reports, built 16 Aug 2026

**Built and green.** The gate: *"H1 register exports for a date range in a form
an inspector accepts."*

### This milestone adds no transitions at all

Worth saying out loud, because it is the test of everything before it. A
register is a **reading of what already happened**. If one had needed a write to
be correct, the thing it reports on was recorded wrong — and after seven
milestones of putting every state change through a transition with its audit
row, every column §15.2 asks for was already there. The work was arranging it.

| Register | Reads |
|---|---|
| **Schedule H1** | date, patient name **and address**, drug, quantity, batch, prescriber and registration number, who dispensed it |
| **Batch trace** | who was given a batch, and when — the recall query |
| **Purchase register** | every invoice, its supplier and GSTIN, and what came in on it |
| **Expiry write-offs** | the disposal record, as a destruction rather than a negative number |
| **Sales register** | one row per bill, cancelled ones included — which is what makes it a register rather than a summary |

### Three things that came out of building it

**The H1 register is complete by construction, not by diligence.** Schedule H1
cannot leave on a counter sale — `app.dispense` refuses it, and has since M0 —
so every row has a prescription behind it and therefore a prescriber to name. A
pgTAP assertion states it directly: no H1 row can lack a prescriber. That is a
refusal written eight milestones ago paying for a legal document today.

**The register found a hole in the registration form.** The rule requires the
patient's *address* and the walk-in form never asked for one, so the register
would have exported blanks. Now the form has the field — optional, because
holding up a queue for an address nobody needs is worse — and **the register
flags every row that ends up without one**, with a count in the context pane.
The gap is visible on a Tuesday rather than during an inspection.

**A recall is not a date range.** Every other register here is bounded by dates;
the batch trace deliberately is not. A recall covers a batch for as long as it
has been leaving the shelf, and a range is exactly how somebody misses the first
three people who got it.

### The CSV is the deliverable, so it is treated like one

An inspector gets a file, and the file gets opened in Excel. Two details, both
tested:

- **Formula injection.** A cell beginning `=`, `+`, `-` or `@` is executed by
  Excel and LibreOffice. Nothing here lets a patient type into a register, but a
  supplier's name is free text and a batch number is whatever is printed on the
  box. A leading apostrophe costs one character and closes it.
- **A BOM.** Excel on Windows reads a UTF-8 file without one as Latin-1, which
  turns every ₹ and every Indian name into mojibake. The Playwright test asserts
  the downloaded file's first code unit is `U+FEFF`, because that is the sort of
  thing that is discovered by a client and never by a developer.

Printing is A4 **landscape** with the panes hidden and `thead` repeated on every
page, since a register that runs to four pages needs its headings on all four.

### The public surface is still exactly one view

M6 opened `clinic_now` to `anon`. This milestone added the most sensitive object
in the build — a list of named people, their addresses and the controlled drugs
they were given — so `A3_registers.sql` signs in as `anon` and confirms it, the
recall list and the day's takings are all still refused, and that the status
page still answers. **One public view, and still one** is now an assertion
rather than an intention.

**M8 totals:** 22 migrations, 335 pgTAP assertions, 17 unit tests, 36 Playwright
tests across nine specs, nothing skipped.

---

## 13. M9 status — hardening, built 16 Aug 2026

**Built and green.** `PLAN.md` §16's regime, minus the parts that are not code.

### The offline write queue, and the one bug that would have been unforgivable

The clinic's Wi-Fi drops mid-sale. Router, concrete wall, a 4G backup that takes
half a minute to take over (`HOSTING.md` §6). The counter cannot stop, so the
write waits on the tablet — which creates the only genuinely dangerous bug in
the whole build: **a queued dispense applied twice.** Stock leaves once and the
ledger says twice; or the patient is billed twice. A retry that is not
idempotent is worse than no retry, because it is silent and it is money.

`app.replay` takes a key the tablet generated *before* its first attempt. If
that key already has a result, the operation ran once and the stored result is
handed back; otherwise it runs. The property that makes it airtight:

> **the key row and the effect commit in the same transaction.**

There is no window where stock has moved and the key is unrecorded, so nothing
can be applied twice. And when the operation *raises* — insufficient stock,
because somebody sold the last strip while the tablet was offline — the whole
transaction rolls back including the key, so the queue can legitimately try
again. **Failure stays retryable, success becomes permanent, from one property.**

Dispatch is a hand-written `case` over three operations, not dynamic SQL over a
function name from a client, because that would be a remote code path into the
`app` schema.

### The line the client draws

> **If the database answered, it decided. If it never answered, we queue.**

A Schedule H1 refusal is an answer. Queuing it would retry it every twenty
seconds forever while telling the pharmacist it was "waiting for the network".
So anything carrying a SQLSTATE is rethrown and never queued — and that is a
Playwright test, not a comment.

The counter is never told "sold" for a queued sale. It is told *"saved on this
tablet, not yet in the ledger"*, and a strip above every screen counts what is
waiting. Rule 6 applies to our own writes as much as to the doctor's presence.

### The permissions review, written as a test

§16 asks for a permissions review. A review done once is a PDF nobody reads
again, so it is `A5_permissions.sql` instead: the whole grant matrix, asserted.
It found two things on its first run.

- **`appointments` is stricter than anybody remembered.** It is not directly
  writable at all — booking allocates a token under an advisory lock, so it was
  written as a transition in M1. A review's job is to find that the schema is
  tighter than the memory of it, as well as looser.
- **Twelve helper functions were executable by `PUBLIC`**, which is Postgres's
  default for a new function and a decision nobody made. None is exploitable
  today — they take no arguments and read the caller's own session — but
  `app.current_device_id()` is `SECURITY DEFINER` over `staff_sessions`, and the
  day somebody adds a parameter to it, that default grant turns a helper into a
  session lookup for anybody. Now revoked and re-granted deliberately.

### And the restore drill was quietly broken

`HOSTING.md` §5 says an untested backup is not a backup. Running the drill
during M9 produced a failure — eleven patients restored as four — and the
restore had worked perfectly. The drill compared the newest archive on disk
against the **live** database, which can only match in the seconds after a
backup is taken. Any consult, any sale, any test run breaks it.

**A drill that cries wolf is worse than no drill**, because the day it is right
everybody assumes it is stale. It now takes its own fresh dump and compares
against that; passing an archive explicitly asserts it loads and is not empty,
which is the honest question to ask of an old file.

### Two more things this milestone found

`clinic_health` is one row where every column should be zero — stock drift,
unbilled dispenses overnight, receipts still awaiting an invoice, a till left
open, supplier credits nobody is chasing, expired stock on the shelf, H1 rows
with no address. That is the nightly reconcile §16 asks for, and the alerting
rule is "any column is non-zero" rather than a threshold per metric.

The E2E suite was **time-of-day dependent** and nobody knew: the presence tests
passed all morning and failed at half past three, because the seeded clinic
hours are 09:30–13:00 and 17:00–20:30 and the status page correctly said the
clinic was shut. The development seed is now open all day, and the hard close is
proved in pgTAP where the timetable can be moved rather than waited for.

### What M9 still owes, and none of it is code

| Owed | Why it is not here |
|---|---|
| Sentry, uptime check on `/now` | Needs a deployed origin. `HOSTING.md` §1a defers hosting deliberately |
| Staging with the real drug list and fake patients | Needs the drug master (`BUILD.md` §3) |
| Load of real data | Same |
| Two-week parallel run, change freeze | `PLAN.md` §16 — that is M10, and it happens in the clinic |

**M9 totals:** 24 migrations, 360 pgTAP assertions, 17 unit tests, 38 Playwright
tests across ten specs, nothing skipped. Five of §16's six Playwright paths are
covered; the sixth is WhatsApp booking, which waits on M7.

---

## 14. M11a status — the drug master import, built 17 Aug 2026

`PLAN.md` §16's go-live checklist opens with one line:

> Load drug master, suppliers, opening stock (clinic closed, one day).

Until this slice that line meant *a developer with `psql`*. Which turns the
doctor's one to two weeks of typing (§3 — the longest pole in the entire
schedule) into a spreadsheet he emails somebody and then waits on, twice,
because the first file is never clean.

It is now a screen: `/import`, doctor and admin only.

### The rule the whole thing is shaped around

**All or nothing.** A file with one unreadable row imports nothing.

The tempting alternative — take the good rows, list the bad ones — is worse
than it sounds, and the reason is not tidiness. A drug missing from the master
is indistinguishable, at every other screen in this build, from a drug the
clinic does not stock. So the failure does not surface in the import screen
where somebody could act on it. It surfaces at the counter, mid-sale, as a
prescription that cannot be dispensed with the patient standing there. The
whole file goes in together or the whole file waits.

Two rules follow it, and both exist because of how the file actually arrives:

- **Dry run first.** The screen always previews before it commits: how many rows
  are new, how many update something that exists, and *every* row it cannot
  read — with its row number and a sentence, not the first failure. One error
  per attempt is how a person with five hundred rows gives up.
- **Idempotent on name + strength.** He will run it twice. Everybody does,
  usually after fixing three rows, in a file that still contains all the others.
  The second run updates; it does not duplicate. A duplicated drug master is a
  week of cleanup, and it is only ever noticed at the counter.

And one thing it deliberately does **not** do: delete. A drug that disappears
from the file is left alone. A row missing from a spreadsheet is far more often
a mistake than a decision, and `active = false` is a deliberate act somebody
takes on a screen.

### Two details that are load-bearing and look like polish

**An empty cell means "leave it".** The update path is `coalesce(file, column)`
throughout, so re-importing a trimmed-down file does not wipe the reorder levels
somebody set on a screen last week. In the transport, an empty CSV cell is
*dropped* rather than sent as `""` — because the database reads absence as
"keep" and an empty string as a value. That distinction is one line in
`toImportRow` and it is the difference between a safe second run and a
destructive one.

**Header matching is forgiving, but not eager.** "Drug Name", "UNITS PER STRIP"
and `salt_composition` all land where they should, because three different
people will have typed this file and one of them was a chemist's billing
software. What does *not* get matched is as considered as what does: "pack size"
is `10 TAB`, not a strength; "category" in a price list is a therapeutic class,
not a drug schedule; "company" is the manufacturer, which is not who the clinic
buys from. A column this build cannot read is ignored, and the preview table
shows the blank. A column it reads *wrongly* is silent damage in a master
nobody re-checks.

Suppliers arrive in the same file, by name, because that is the shape of the
doctor's spreadsheet. A name nobody has seen becomes a supplier with nothing
else filled in — the WhatsApp number and the return window are decisions, not
import data.

### The harness bug this found, which was not in this milestone

`scripts/db-test.sh` drops and rebuilds the schema underneath a running
PostgREST. It reconnects by itself — but if it reconnects *while the rebuild is
still in progress*, it caches whatever existed at that instant and nothing ever
tells it to look again. The symptom is a transition returning 404 to a screen,
against a database where the function demonstrably exists, and it would have hit
whichever milestone next added a transition. The script now sends
`notify pgrst, 'reload schema'` after restoring the seed.

### The gate

`e2e/m11-import.spec.ts`, four tests, and every assertion about what did or did
not land is made **at the counter's drug search** rather than in the import
screen's own summary — because that is where a bad import actually hurts.

The test helper waits for the search's own HTTP response before reading the
match count, which is not fussiness: "0 matches" is also what the screen says
while the query is still in flight, so reading it too early makes every
"nothing was written" assertion in the file pass for the wrong reason.

`supabase/tests/A6_import.sql` carries the other 19 assertions, including the
one worth stating out loud: after a refused import of a file whose *first* row
is perfectly good, `drugs` is still empty.

**M11a totals:** 25 migrations, 379 pgTAP assertions, 21 unit tests, 42
Playwright tests across eleven specs, nothing skipped.

### What M11 still owes

| Owed | What it is |
|---|---|
| **Opening stock import** | This slice loads drugs and suppliers. Opening stock is batches — batch number, expiry, cost, MRP, pack config — and it goes through goods receipt, so it is a different file and a different transition |
| **Settings screen** | `clinic` has no INSERT/UPDATE grant and no transition. Consult fee, opening hours, licence numbers and GSTIN are still SQL-only |
| **Staff and device admin** | `app.set_staff_pin` and the admin-only device policy exist with no screen in front of them |
| **Patient edit, bill void** | M8 flags a missing H1 address with no way to fix it; `app.void_bill` is tested and no screen calls it |

---

## 15. M11b status — clinic settings, built 17 Aug 2026

Everything in the `clinic` row is a setting the doctor is supposed to decide:
his consultation fee, whether a follow-up inside N days is free, his opening
hours, his registration number, the pharmacy's drug licence, the GSTIN, and
whether bills round to the rupee. There was no INSERT or UPDATE grant on that
table and no transition, so every one of them was a developer with `psql` — on
a row that appears on every printed bill.

`/settings`, doctor and admin only. `app.update_clinic`, CL026.

### The timetable is the dangerous one

`app.clinic_is_open` reads `open_hours` and treats a day it cannot parse as
**closed**. That default is right — it is the safe direction for a page
patients drive to a clinic on — and it is exactly what makes a typo invisible.
`{"mon": ["9:30-1:00 pm"]}` raises nothing anywhere. It quietly means "shut on
Mondays, forever", and the only screen that shows the consequence is the public
one, which nobody in the clinic ever looks at.

So the transition validates the timetable window by window and refuses in
words, naming the day: *"9:30-1:00 pm on wed is not a time window — write it
like 09:30-13:00"*. The screen deliberately does **no** repair of what was
typed. A parser that silently drops what it does not understand converts a typo
into a closed clinic, which is the failure this whole section exists to stop.

The input is one text box per day rather than a grid of time pickers. It is how
the doctor says it out loud — "mornings and evenings, half day Saturday" — and
a picker costs four taps per boundary, fourteen boundaries in a week.

### Null means "leave it", empty means "clear it"

The second way a settings screen ruins a month: a form that sends only what
changed, against a transition that reads an absent field as "clear it". Update
the phone number, and the drug licence quietly disappears from every bill
printed afterwards. Nobody notices until an inspector does.

So the convention is explicit and tested both ways: a field the caller did not
send keeps its value; a field sent as an empty string is set to null. The E2E
changes exactly one field and then asserts the other three survived a reload,
which is the assertion that would have caught it.

### Two smaller decisions

**The GSTIN is checked against its actual shape** — 15 characters, state code +
PAN + entity + Z + checksum. It is printed on every bill, and a bill is a legal
document that cannot be un-printed. Fourteen characters is a typo worth
refusing.

**It creates the clinic if there is none.** That is a real state, not an error:
day one of go-live on an empty database. The name is the only thing that cannot
be defaulted, so it is the only thing required. Nobody should need psql to
leave "the clinic does not exist yet".

Changes are audited with the before and the after, because "since when has the
fee been ₹400?" is asked three months later.

### The gate

`e2e/m11-settings.spec.ts`, five tests; `supabase/tests/A7_settings.sql`, 22
assertions.

One of those pgTAP assertions was written wrong first and is worth keeping in
mind: `date_trunc('week', current_date) at time zone 'Asia/Kolkata'` resolves
`date_trunc` to the *timestamptz* overload, so `at time zone` runs the
conversion backwards and Monday 10am becomes half past three. It passed the
"closed" assertion and failed the "open" one — in a file whose subject is a
timetable being read correctly. The fix is an explicit `::timestamp` on the
naive local time before giving it a zone.

**M11b totals:** 26 migrations, 401 pgTAP assertions, 21 unit tests, 47
Playwright tests across thirteen specs.

---

## 16. M11c status — staff and device admin, built 17 Aug 2026

`app.set_staff_pin` and an admin-only device policy have existed since M0 with
nothing in front of them. So the two most ordinary events in a clinic's year —
*the new pharmacist starts on Monday* and *the counter tablet was left in an
auto-rickshaw* — were a developer with `psql`.

`/admin`, admin only. Four transitions: `add_staff`, `update_staff`,
`register_device`, `revoke_device`. CL027.

### The last admin cannot switch themselves off

A single-doctor clinic has one or two admins. Deactivate or demote the last one
and nobody can ever register a tablet, add staff or reset a PIN again — the
system needs a developer to get back in, which is precisely what M11 exists to
remove. `app.update_staff` counts admins over the state the change would
**leave**, not the state it started from, so demoting and deactivating are
caught by the same arithmetic and neither needs its own special case.

The refusal says what to do about it: *"this is the only administrator left —
make somebody else an admin first."*

### Revoking a tablet ends the session on it

`revoked_at` alone stops the **next** unlock. It does nothing about the tablet
that is currently unlocked and in somebody else's bag — which, on a tablet
somebody is actively using, is never. So `revoke_device` ends the live sessions
in the same transaction as it sets `revoked_at`. Ended, not deleted: who was
signed in on that tablet, and until when, is exactly the question somebody asks
after a device goes missing.

The E2E proves the whole loop in a browser: register a tablet, bring a fresh
browser context up from the code it showed once, sign in, revoke from the other
tablet, and watch the same credential stop working. What that last step
displays is **"Incorrect PIN."** — not "this tablet was revoked" — because the
lock screen refuses a wrong PIN, an unknown person and a revoked device
identically (TABLET.md §5). Somebody holding a stolen tablet learns nothing
from it.

And you cannot revoke the tablet in your hands. If it is genuinely the one that
is lost, it is not the one you are holding.

### Three smaller decisions

**A new staff member gets a PIN in the same step.** Somebody created without
one appears on the lock screen and cannot pass it, which reads as a broken
tablet rather than as half-finished setup.

**`add_staff` creates the first admin on an empty database, and then never
again.** Same argument as `update_clinic` creating the clinic: day one of
go-live is a real state and nobody should need psql to leave it. The bootstrap
window closes the instant the first staff row exists and cannot reopen — a
database with staff in it takes that path exactly once, ever.

**The registration code is shown once.** It is generated in the database rather
than the browser (24 bytes from pgcrypto beats whatever random source the page
had), returned exactly once, and there is no read path back to it anywhere in
this build — `lib/db/admin.ts` does not select the column. A code that can be
re-displayed forever is a code that gets photographed.

### `devices` lost its exemption

The M9 permissions review blessed exactly one table as directly writable
without a transition behind it: `devices`, narrowed by an admin-only RLS
policy. That was fair while registration was a plain INSERT. It stopped being
fair the moment the token needed generating server-side and revocation needed
to do two things atomically — so devices went behind transitions and
`A5_permissions.sql` went from seven writable tables to six.

Two dead policies came off `staff` at the same time. It never had a write grant
at all, so `staff_admin_write` and `staff_admin_update` had been narrowing a
permission nobody held since M0 — and a policy that cannot fire is a policy
somebody eventually reads as proof that the table is writable.

That is the review working exactly as designed: it is deliberately annoying to
update, and this update made the matrix stricter.

**M11c totals:** 27 migrations, 426 pgTAP assertions, 21 unit tests, 52
Playwright tests across fourteen specs.

---

## 17. M11d status — the two loose ends, built 17 Aug 2026

Two things this build could describe and could not do.

**M8 flagged a Schedule H1 row with no patient address** — the rule requires
one, and a register with blanks in it is not one — and then offered nobody a
way to fix it. The pharmacist reading that red row had to find a developer,
which makes it a flag nobody acts on.

**M4 wrote and tested `app.void_bill`** — including the part where cancelling a
paid cash bill is a refund that has to come out of a drawer somebody is
counting — and no screen ever called it, for two milestones. A transition with
no caller is a feature the clinic does not have.

Neither needed a new transition. What they needed was a way in, and one thing
that was missing underneath.

### Patient edits are now audited

`patients` is one of the six tables this build writes to directly: ordinary
CRUD under RLS, moving neither stock nor money. That is still the right call —
registration is a walk-in screen with a consent tick, not a transition — but an
**edit** is a different act from a creation. Somebody changing a recorded
allergy, or the phone number reminders go to, or the address the H1 register
prints, left no trace whatsoever.

An `AFTER UPDATE` trigger closes that without moving the table behind a
transition and without touching the registration screen. Two details make it
usable rather than noisy:

- it compares the rows **without `updated_at`**, so a save that changed nothing
  writes nothing — otherwise every re-save of a form logs a change;
- `app.write_audit` already stores changed fields only, so editing one field
  logs one field. A log full of unchanged columns is a log nobody reads.

The permissions review caught the new trigger function the moment it was
written: Postgres grants EXECUTE to PUBLIC by default, and `A5_permissions.sql`
§5 refuses that. (A trigger function does not need the grant to fire — the
check is TRIGGER on the table, at creation.) That test has now found the same
class of mistake twice.

### The register learned who each row is about

`h1_register` carried the patient's name and their missing address and not
their id, so a screen could show the gap and could not offer to fix it. One
column, appended at the end so the existing column order — and therefore the
CSV an inspector gets — is untouched. The report's "Add address" button is
`print:hidden` and outside the exported columns for the same reason.

### Cancelling a bill

The screen decides nothing. It collects a reason and calls the transition,
which refuses a paid bill from the counter (that is a refund, and it is the
doctor's call) and refuses a cash refund with no till open (it has to come out
of a drawer somebody is counting). Both refusals arrive as sentences, which is
how the pharmacist learns the real reason rather than the screen's guess.

What the screen *does* say, before the button is pressed, is the thing that is
otherwise discovered at the next stock-take: **the medicines do not come back
into stock.** Cancelling a bill is a paperwork correction; what left the
counter returns through the ledger or not at all.

### The gate

`e2e/m11-corrections.spec.ts`, two tests, both starting where the person
actually is — looking at the flagged register row, and holding a bill made out
to the wrong patient. `supabase/tests/A9_patient_and_void.sql`, 14 assertions.

**M11d totals:** 28 migrations, 440 pgTAP assertions, 21 unit tests, 54
Playwright tests across sixteen specs.

### What M11 has left

| Owed | What it is |
|---|---|
| **Opening stock import** | M11a loads drugs and suppliers. Opening stock is batches — batch number, expiry, cost, MRP, pack config — and it belongs behind goods receipt rather than a second copy of the ledger write |

Everything else on the go-live checklist that is code is now built. What
remains is `BUILD.md` §1.3 (LAN HTTPS, the tablets, the printers) and M10 — the
parallel run — and both of those happen in the clinic.

---

## 18. M11e status — opening stock, built 17 Aug 2026

The last line of go-live tooling, and the one that decides whether every stock
number in the system is right or quietly wrong from the first morning: the
shelf already holds four hundred batches nobody entered, each with a batch
number, an expiry, a cost and an MRP.

`/import` now has two tabs, numbered, because the order is not a preference —
opening stock names drugs, so a stock file loaded first is a file where every
row is an error.

### It goes through `app.receive_goods`, not around it

Opening stock is a delivery that happened before the system existed, and
everything the goods receipt already does is what opening stock needs:
pack-to-base-unit conversion at the one boundary, the past-expiry refusal, the
ledger row that makes `qty_base_on_hand` a cache rather than a claim (rule 3),
and a GRN the purchase register can show.

A second path writing `stock_batches` directly would have been shorter and it
would have been a second place for the ledger to drift — and drift in the
**opening balance** is drift nobody ever finds, because there is nothing to
reconcile it against.

One goods receipt per supplier, per invoice. Per supplier is not bookkeeping
tidiness: `stock_batches.supplier_id` comes from the receipt, and a batch that
does not know who supplied it can never be returned to them (INVENTORY.md §6).

### The one refusal that matters

**A batch already on the shelf is refused, by name.** `receive_goods` *adds* to
an existing batch, which is exactly right for a real delivery and catastrophic
here: load the opening file twice and the shelf silently doubles. Nothing else
in the system would look unusual, and the first person to notice would be doing
a stock-take three months later, unable to explain it.

Opening stock is by definition stock the system does not have yet, so that is
what the transition checks — including the same batch appearing twice inside
one file, which is the same mistake made faster.

### The file says what its numbers mean

A quantity is in strips, boxes or loose units, and so is a cost, and **the two
can differ on the same row** — a distributor quotes a rate per strip and counts
in boxes. Getting it wrong is a 10× or 150× error in either the shelf or its
valuation, so each is declared per row, defaulting to `strip`.

The client-side mapping refuses to be clever about it: `strips`, `Strips of
15`, `tab`, `pcs` all resolve, and **anything it cannot place is passed through
untouched so the database refuses it by name.** Quietly defaulting an
unrecognised unit to `strip` would turn a typo into a 15× error in the shelf,
which is the single most expensive thing that module could do.

### The number the preview exists for

Not the row count. **The whole shelf, at cost.** A doctor who knows his stock
is worth about four lakh spots a misdeclared cost basis at forty lakh
instantly — faster than any per-row check could tell him, and it is the only
check that catches a file where every row is individually plausible.

It shows what will be *stored*, not what the invoice adds up to. A box at ₹170
over 150 tablets is ₹1.1333 a tablet at the four decimal places the batch
keeps, so the preview says ₹1,029.99 where the invoice says ₹1,030.00. A
preview that disagreed with the stock valuation screen five minutes later would
read as a bug; one paisa is not the error this figure exists to catch.

### The defect this milestone found, which was not in this milestone

The full suite failed once on `m4-gate`, in a run of everything rather than
that file alone: *"cash cannot be taken into a drawer nobody has opened"*,
asserting a refusal that was not on screen.

The refusal was real. It had been **erased**. Every screen's `refresh()`
cleared the error on completion, and raising a bill fires a refresh — so a
refusal raised while that refresh was still in flight vanished the moment it
landed, leaving a screen that had simply not done what was asked. Under load
the window was wide enough to fail a test; at a counter it is wide enough to
make somebody tap Cash twice.

**A read landing is not evidence that the last write succeeded.** The rule now
is that a read clears the error when it *starts*, never when it finishes. That
is fourteen screens, and the worst of them was the counter, which refreshes on
every realtime event — a refusal the pharmacist was reading could be erased by
a prescription arriving at the other tablet.

`e2e/m4-gate.spec.ts` holds it now, by delaying the refresh's first read and
asserting the refusal survives it. Reverting the fix fails that test, which is
the only way to know a regression test is one.

**M11e totals:** 29 migrations, 472 pgTAP assertions, 21 unit tests, 59
Playwright tests across seventeen specs.

### M11 is finished

| | |
|---|---|
| M11a | drug master and supplier import |
| M11b | clinic settings |
| M11c | staff and device administration |
| M11d | patient corrections and bill cancellation |
| M11e | opening stock |

Everything on `PLAN.md` §16's go-live checklist that is code is built. What is
left is §1.3 — LAN HTTPS, the root CA on both tablets, PWA install, the
printer's Android print service plugin, one real prescription printed and one
real bill on each paper size — and M10, the parallel run. Both happen in the
clinic.
