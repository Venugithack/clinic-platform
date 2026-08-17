# Build plan — M0, and the gates after it

`PLAN.md` is the what. This is the how, starting from an empty directory.

**Status: M0–M6 built, 16 Aug 2026** — foundations, clinic core, the live link,
inventory, billing with the till, supplier purchasing, and presence. See
§5–§11. `PLAN.md` §20 is still
unsigned; §0 below lists what must be true before the clinic runs on this.

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
