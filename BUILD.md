# Build plan — M0, and the gates after it

`PLAN.md` is the what. This is the how, starting from an empty directory.

**Status: not started.** `PLAN.md` §20 is unsigned, and §0 below lists what must
be true before day 1. Everything here is executable the moment it is.

Local-first, per `HOSTING.md` §1a: Supabase in Docker, Next on the LAN, both
tablets on the clinic Wi-Fi. No hosting account, no Meta account, no spend until
M7.

---

## 0. Before day 1

### One decision that genuinely blocks the first migration

**`PLAN.md` §18 Q15 — is this a one-off, or the first customer of a product?**

It is unanswered, it is Venu's to make, not the doctor's, and it cannot wait
because it changes the very first migration.

| | One-off | Multi-tenant from day 1 |
|---|---|---|
| Schema | no `clinic_id` | `clinic_id` on every table, in every RLS policy, in every transition |
| Cost now | — | **~3 days** |
| Cost later | — | **weeks.** Backfilling a tenant key through a live ledger, live RLS and twelve transitions, against real patient data |

**Recommendation: multi-tenant from day 1.** Three days now against weeks later
is a cheap option on a second customer ever existing, and the clinic pays nothing
for it — a single-tenant deployment with a tenant column is indistinguishable
from one without. Decide before the first migration; after that the cost curve
turns.

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
| **M4** | Billing, counter sale, till | 4 | A bill prints for a consult plus 4 medicines across 2 batches; the day's total matches the sum of its bills; the till reconciles against counted cash |

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
| First migration | **Venu — Q15, multi-tenant or not** | Nothing. This is the one that stops day 1 |
| M3 completion | doctor — drug master with salt and strength | Build against a 20-drug seed; the schema does not care |
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
