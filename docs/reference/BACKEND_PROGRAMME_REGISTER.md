# Backend programme register

> Historical register note, 17 September 2026: statements below that the client
> still rotates on a visit change or lacks reconciliation describe the state at
> backend Slice 2 acceptance. The later bounded frontend safety cutover is now
> implemented locally; see `SLICE2_FRONTEND_CONTRACT.md` §1.1. This register's
> acceptance chronology is intentionally not rewritten.

The evidence baseline, work register, decision register, contract sequence and
compatibility map produced by **Slice 0** of
[`CLAUDE_BACKEND_IMPLEMENTATION_PROGRAMME.md`](CLAUDE_BACKEND_IMPLEMENTATION_PROGRAMME.md).

Slice 0 implements no feature. What it produces is the ground truth every later
slice is measured against, the decision history (including questions answered
after Slice 0), and the order the contracts have to arrive in. Where this document states what the
application does, it was read out of source or out of a database that ran the
real code — never out of another document. Where a claim could not be checked,
it says so.

Status: **Slice 0 complete, 14 September 2026. Slice 1 complete, 14 September
2026. Slice 2 accepted, 17 September 2026, after six bounded acceptance
corrections. Slice 3 policy approved, 17 September 2026, and ready but not
started.** Slices 4–12 not started.
Slice 1's own record is [§11](#11-slice-1-what-was-built), Slice 2's is
[§12](#12-slice-2-what-was-built), and the six acceptance corrections are
§12.1 to §12.6; what each changed in the tables below is marked in place.
Where they disagree, the later section is the current behaviour.

## Contents

1. [How this was built](#1-how-this-was-built)
2. [The baseline](#2-the-baseline)
3. [The five suspected conditions, verified](#3-the-five-suspected-conditions-verified)
4. [What Slice 0 found that was not on the list](#4-what-slice-0-found-that-was-not-on-the-list)
5. [The work register](#5-the-work-register)
6. [The decision register](#6-the-decision-register)
7. [Contract and migration sequence](#7-contract-and-migration-sequence)
8. [Compatibility map](#8-compatibility-map)
9. [Documentation corrected](#9-documentation-corrected)
10. [What Slice 0 did not do](#10-what-slice-0-did-not-do)
11. [Slice 1: what was built](#11-slice-1-what-was-built)
12. [Slice 2: what was built](#12-slice-2-what-was-built)
12.1 [Slice 2 was returned unaccepted, and what the correction changed](#121-slice-2-was-returned-unaccepted-and-what-the-correction-changed)
12.2 [Returned again, and what the second correction changed](#122-returned-again-and-what-the-second-correction-changed)
12.3 [Returned a third time, and the one that could take money twice](#123-returned-a-third-time-and-the-one-that-could-take-money-twice)
12.4 [Returned a fourth time: a closure that is performed, not claimed](#124-returned-a-fourth-time-a-closure-that-is-performed-not-claimed)
12.5 [Returned a fifth time: a convention is not a capability](#125-returned-a-fifth-time-a-convention-is-not-a-capability)
12.6 [The sixth correction: the words are the doctor's too](#126-the-sixth-correction-the-words-are-the-doctors-too)
12.7 [Slice 2 accepted](#127-slice-2-accepted)

---

## 1. How this was built

Four parallel read-only audits — database layer, backend API surface,
verification baseline, frontend consumers — followed by lead verification of
every claim this register repeats as fact. Findings that only one source
asserted, and that mattered, were re-checked by hand or proved against a running
database before being written down. Two agent claims did not survive that check
and are recorded in [§4](#4-what-slice-0-found-that-was-not-on-the-list).

Three files in this directory arrived with the assignment rather than from this
slice, and are cited here as sources rather than claimed as output:
`CLAUDE_BACKEND_IMPLEMENTATION_PROGRAMME.md` (the assignment itself),
`COMPETITIVE_LANDSCAPE_2026.md` (the research the programme is drawn from), and
the `docs/README.md` map entries for both. All three were untracked in the
working tree when Slice 0 began. Slice 0 wrote one file in this directory: this
one.

All database work ran against the guarded loopback scratch database described in
[`../operations/STAGING.md`](../operations/STAGING.md) §2. The clinic's live
backend was never contacted. `.env.local` on this machine resolves
`NEXT_PUBLIC_FUNCTIONS_URL` to the live Supabase project, which is exactly the
trap `docs/README.md` §3 describes; it was inspected without printing secrets
and then left alone.

## 2. The baseline

Counted from source on 14 September 2026, not from documentation.

| | |
|---|---|
| Migrations | 21, forward-only, `20260831000000` … `20260917000000` |
| Edge Functions | **12** — `bootstrap`, `command`, `csv`, `images`, `inventory`, `login`, `logout`, `record`, `register`, `reports`, `snapshot`, `staff` |
| Commands | **85 dispatch keys, 84 operations** (`save_consultation` and `sign_consultation` share a handler), routed `commands.ts` → `inventory.ts` → `counter.ts` → `images.ts` |
| Roles | `admin`, `doctor`, `nurse`, `pharmacy`; a staff member holds the union of theirs |
| Unit tests | 9, across 3 files |
| Database tests | **325** across 20 files (316 before this slice; 9 added by it) |
| Browser journeys | 56 across 7 files |

### Where authorization actually lives

`requireRole()` in `_shared/command-input.ts:57-59` is the single gate every
command passes, and `hasRole()` in `_shared/auth.ts:259-261` is the single
predicate under it. There is **no row-level security policy anywhere**: RLS is
enabled on every table and all grants to `anon`, `authenticated`, `service_role`
and `public` are revoked from the whole `jmc` schema
(`20260909125237_harden_active_clinic.sql:1-11`), so the schema is unreachable
except through the Edge Functions' own connection. That is a deliberate posture,
not an omission — but it means **every later slice's authorization is code, and
a missing `requireRole` is a hole with nothing behind it.**

The snapshot carries a *second*, independently hand-maintained role gate:
seven booleans at `_shared/snapshot.ts:722-740` (`staffAdmin`, `careRegister`,
`clinicalRecord`, `pharmacyCounter`, `shelf`, `supplyNetwork`, `cashDrawer`).
Nothing derives one from the other. A new capability has to be added to both,
and nothing fails if it is added to only one.

### Idempotency, as built

Implemented per command, three ways. There is no shared helper.

| Command | Protection | Evidence |
|---|---|---|
| `post_goods_receipt` | client key + unique index | `inventory.ts:790-810`; `goods_receipts.idempotency_key` |
| `dispense_rx` | client key + unique index | `counter.ts:504-514`; `dispenses.idempotency_key` |
| `otc_sale` | client key + partial unique index | `counter.ts:857-862`; `otc_sales_idempotency` |
| `take_payment` | client key + unique index | `counter.ts:1184-1190`; `payments.idempotency_key` |
| `refund_payment` | client key + unique index | `counter.ts:1378`; same index |
| `sign_consultation` | **none** — see W1 | `commands.ts:345` |
| `receive_order` | **none** — see W12 | `commands.ts:2406-2450` |
| `add_medicine` | **none** — see W13 | `commands.ts:2290-2308` |
| everything else | state-machine guards (`status` checks, one-open-at-a-time indexes) | — |

Where the caller omits a key the five protected commands fall back to
`` `${prefix}:${randomUUID()}` ``. That fallback is safe only because the
browser reuses one key across its own retries; a caller that regenerates per
attempt gets no protection at all.

### Two representations of time still coexist

The original schema stores every timestamp as `text` — 25 such columns in
`20260831000000_clinic_schema.sql` and 4 more in `20260831050000_stock_take.sql`
(`patients.created_at`, `appointments.scheduled_at`, `prescriptions.signed_at`,
`stock_movements.created_at`, …). Everything added from Slice 2 onwards uses
`timestamptz`. No legacy column was ever converted. `queue-order.test.mjs`
exists because that text ordering already called a patient in out of turn once.
No slice below proposes converting them, and no slice below may add another
`text` timestamp.

### Money and quantity

Money is `numeric(12,2)` everywhere since `20260912000000...:65-98`, which
converted every column that had been `real`. Stock is integer base units
throughout. The two remaining `real` columns — `vitals.temperature`,
`vitals.weight` — are instrument readings and are correct as they are.

The ledger has no database-level non-negativity constraint:
`stock_movements.quantity_delta` carries no check. Non-negative stock is held by
`batches.available_quantity >= 0` on the cache plus row-locking and recheck in
the command path. That is the documented design and the concurrency tests
exercise it, but it is worth knowing that the guarantee is in code.

## 3. The five suspected conditions, verified

The programme asked for five conditions to be verified rather than assumed. All
five hold. Four were proved by running the real commands against staging; the
evidence is now pinned by
`tests/characterization/unprotected-write-paths.test.mjs`.

| # | Suspected | Verdict | Evidence |
|---|---|---|---|
| 1 | `post_goods_receipt` is the canonical receiving engine | **Confirmed** | `inventory.ts:788-1057`. Requires a verified package version, converts package entries through the ladder, separates accepted/free/quarantined/rejected, refuses a past expiry, records tax and MRP/purchase basis, writes numbered GRN + lines, allocates against PO lines under `for update`, idempotent. |
| 2 | An older `receive_order` is still used by the Orders UI and bypasses GRN/package/invoice/idempotency/quarantine | **Confirmed** | Called at `components/pharmacy-workspace.tsx:1110`. Handler `commands.ts:2406-2450`. It records **no GRN**, no supplier invoice, no package version or snapshot, no tax, no free/quarantined/rejected split, **no idempotency key**, and **no expiry check** — a batch dated 2020-06-30 was accepted. |
| 3 | Medicine creation can establish opening stock without the same controls | **Confirmed** | `add_medicine` with `initialQuantity > 0` inserts a batch and an `opening_stock` movement directly (`commands.ts:2290-2308`): no package version, no snapshot, no GRN, no count, no expiry check. A batch dated 2020-01-01 was accepted. |
| 4 | PO lines carry structured package fields the workflow does not use | **Confirmed** | `order_level_name`, `order_level_count`, `package_version_id` added at `20260912000000...:717-719` and referenced **nowhere else in the repository**. A created order reads `('', null, null)`. What the supplier receives is `purchase_orders.message_draft`, free text built from the base-unit number. |
| 5 | Learning-reorder views are absent although a reference calls them shipped | **Confirmed** | `consumption_velocity`, `supplier_lead_time`, `stockout_history`, `supplier_price_history`, `reorder_suggestions` are created by no migration. They appear only in a 33-name array of the **retired application's `public` views** being set `security_invoker` (`20260909125237...:93-104`), and `scripts/staging/legacy-stubs.sql` replaces all 33 with empty stubs on any fresh database. No Edge Function reads any of them. Corrected in `INVENTORY.md` — see [§9](#9-documentation-corrected). |

## 4. What Slice 0 found that was not on the list

Four findings that no document predicted. The first two are the reason this
slice took longer than reading.

### `npm run staging:rehearse` had been dead since 20260915 was written

The rehearsal held a hard-coded list of seven filenames as "the migrations under
rehearsal" and treated *everything else* as the schema to build first. The three
migrations written after Slice 5 were never added to it, so they fell into the
"before" set — where `20260915_financial_edge_states.sql` builds a view over
`jmc.invoices`, a table Slice 4 creates and the rehearsal deliberately holds
back. The whole script died on `relation "jmc.invoices" does not exist`.

This matters more than a broken script. The rehearsal is the *only* thing that
answers "will this migration behave against two years of real rows", and
`docs/README.md` §6 listed it among the checks that run. Every migration from
`20260915` onwards had gone to the clinic's doorstep unrehearsed, and every
slice below adds migrations.

Fixed in `scripts/staging/migration-rehearsal.mjs`: the boundary is now a
position, not a list, so a new migration is rehearsed by default rather than by
somebody remembering. Re-application drops the three views the set redefines
(`invoice_balances`, `patient_balances`, `financial_review_queue`) and lets the
same migrations rebuild them, which is what "run the set twice" actually means
when a later file widens an earlier file's view; the superseded names are read
out of the migration files rather than listed. It now applies all ten rehearsed
migrations and passes its 15 named checks, including — for the first time —
Slice 4's bills backfill re-applied alongside the three newest migrations. Two
assertions were added to the second pass while fixing it: that the rebuilt
views came back with the grants the harden migration revokes, and that
`patient_balances` converged on 20260916's definition rather than stopping at
Slice 4's narrower one. Existence alone would have passed either way.

### A consultation signed without an appointment charges the patient twice

Proved against staging and pinned by
`unprotected-write-paths.test.mjs`. Signing the same sheet twice produces two
encounters, two invoices and two ₹300 consultation-fee lines. See W1.

### A purchase order cannot be placed unless WhatsApp is connected

`send_order` is the only transition from `pending` to `placed`
(`commands.ts:2369-2392`) and it refuses without the four `WHATSAPP_*`
variables. `receive_order` accepts only `placed` or `partially_delivered`
(`commands.ts:2414`). So a clinic that has not connected WhatsApp — which is
every clinic today, since none of those variables is set — cannot receive
against a purchase order at all. The competitive review noted that a telephoned
order cannot be marked placed; it did not notice that this closes receiving too.

### Two audit claims did not survive checking

Recorded because a register that only lists confirmations is not evidence of
checking.

- An audit reported `edgeFunction()` in `tests/support/backend.mjs:80` as dead
  code with zero call sites. It is the helper `edgeGet` and `edgeRequest` are
  both built on (`backend.mjs:98,113`). Not dead.
- An audit reported `jmc.prescription_lines_effective` and ten other views as
  "not confirmed" to be referenced by any Edge Function, having not run the
  greps. They are referenced; the view names appear throughout `snapshot.ts`,
  `counter.ts` and `inventory.ts`. No view in the migration set is orphaned.

## 5. The work register

Sixteen items, ordered by the slice that owns them. **Policy** cites
`OWNER_POLICY_REGISTER.md` item numbers where a decision already exists, or
names the decision register entry below where it does not.

The programme requires ten fields per item. Six of them are one word each and
live in the table below; the four that need explaining — present behaviour, the
gap, the proposed contract, and the test plan — are in the prose that follows.
Read a row and its entry together.

| # | Slice | Status | Migration | Compatibility risk | External dependency | Frontend handoff owed |
|---|---|---|---|---|---|---|
| W1 | 1 | **closed** — `20260918000000` | yes: `encounters` key + unique index | low — additive; the server still accepts a call with no key, and that exposure is pinned by a test | none | done — [`SLICE1_FRONTEND_CONTRACT.md`](SLICE1_FRONTEND_CONTRACT.md) §1 |
| W2 | 1 | **closed** — `workspace?view=patients` | indexes only (`20260919000000`) | none — additive endpoint | none | done — contract §3 |
| W3 | 1 | **closed** — `workspace` workload, list, progress, obligations | indexes only (`20260919000000`) | none | none | done — contract §5–§7 |
| W4 | 1 | **closed** — `workspace?view=outcome` | none | none — no existing union was widened; the answer is a new endpoint, not a new status member | none | done — contract §8 |
| W5 | 2 | **closed — accepted 17 September 2026 after six corrections** — `20260920000000` + `20260921000000` + `20260922000000` + `20260923000000` | yes: six tables, five columns on `appointments` and seven on `appointment_events`, three unique indexes, three composite FKs, two checks added, one index dropped and one constraint replaced | low — walk-in path untouched; one refusal code changed on a path the deployed client cannot reach | none | done — [`SLICE2_FRONTEND_CONTRACT.md`](SLICE2_FRONTEND_CONTRACT.md) |
| W6 | 3 | **ready, not started** — D8–D12c approved as owner items 76–83 | yes: template/consent/outbox tables | low | official-provider validation and credentials — **not** this programme's to provision | failure queue; consent suppression; delivery states |
| W7 | 4 | blocked on D13–D17 | yes: catalogue, orders, results | low | an external lab's report format, eventually | pending-review and overdue queues |
| W8 | 5 | blocked on D18–D22 | yes: grants, intake, uploads | low | none | grant issue/revoke; what a grant resolves to |
| W9 | 6 | open | none | none | **R2 credentials in CI — needs explicit approval** | none (operational) |
| W10 | 6 | open | yes: export jobs, integration events | low | none | export request/status/download |
| W11 | 7 | blocked on D23–D27 | yes: procurement profiles, supplier columns | **medium** — Orders UI must keep working | none | editable package-aware PO lines; `mark placed` |
| W12 | 8 | open (D28–D30c refine it) | yes: discrepancies, credit-note columns | **high** — two live callers, one legacy | real supplier invoices (owner evidence gate I.1) | receiving prefill from a PO; discrepancy resolution |
| W13 | 8 | open | yes: opening-stock guard | **medium** — the form still posts `initialQuantity` | none | where opening stock goes instead |
| W14 | 9 | blocked on D31–D34b | yes: suggestions, decisions | low | none | the explanation payload, in human language |
| W15 | 10 | blocked on D35–D36 | yes: scope membership, package entry | low | none | scope picker; count-due and exception queues |
| W16 | 11 | blocked on D37–D39 | yes, all flag-gated | none — disabled by default | **ABDM sandbox access and official specifications** | none until a pilot is chosen |

Status means: **open** — no decision blocks it, it can be built when its slice
comes up. **blocked** — the named decisions must be answered first. Nothing here
is in progress; Slice 0 built none of it.

### Read models and discovery — Slice 1

**W2 · Patient search is a client-side filter over an unbounded array**

- *Now:* `components/care-workspaces.tsx:280-285` filters `data.patients`
  in memory on every keystroke. The array is a top-level snapshot key with **no
  `LIMIT`** (`snapshot.ts:788`) and is re-sent in full on every snapshot-changing
  poll, clinic-wide. The only server-side lookup is `find_possible_duplicates`
  (`commands.ts:632-687`), capped at 5, and it exists for pre-registration
  duplicate warning, not for finding a patient.
- *Gap:* no indexed, bounded, role-minimized search endpoint. Growth is
  unbounded in both payload and per-keystroke scan.
- *Policy:* safe technical default. No owner decision needed to add a search.
- *Contract:* on-demand `GET search?q=` or a `find_patients` command returning
  id, name, masked phone, today's token and current stage only.
- *Migration:* normalized-name and last-10-digit phone indexes on `patients`.
- *Compatibility:* additive. The existing filter keeps working until the
  frontend programme repoints it.
- *Test:* role leakage, ambiguous and duplicate names, Tamil-script names, the
  49-character fixture name, phone formats, result cap, query plan on bulk rows.
- *Handoff:* search endpoint + the fields it may return.
- *Depends on:* nothing.

**W3 · Every actionable count and due list is computed in the browser**

- *Now:* `components/due-now.tsx:75-146` builds the nurse's entire worklist by
  joining snapshot arrays and ticking a 30-second clock client-side.
  `shared-panels.tsx:329,373,399,2547,2569-2586` re-reduce whole invoice and
  balance arrays for Overview totals that `patient_balances` already aggregates.
  `expiring-panel.tsx:135`, `day-book-panel.tsx:90`,
  `formulary-workspace.tsx:2001-2006` do the same shape of work.
- *Gap:* no server read model for workload counts, visit progress, safe-exit
  obligations, or `Needs attention`. Counts cannot be trusted to reconcile with
  a drill-down because nothing computes them together.
- *Policy:* safe technical default, with one caveat — a due list must show only
  tasks with an authoritative record behind them (item 64's principle).
- *Contract:* on-demand workload/exception queries; a derived visit-progress
  model naming stage, owner role, age and next safe action.
- *Migration:* indexes only. **No mutable status column may be added to make a
  screen easier to draw.**
- *Compatibility:* additive; existing client derivation untouched.
- *Test:* every count reconciles with its drill-down in one snapshot of data;
  clinic-day boundaries; partial and failed states.
- *Depends on:* nothing.

**W4 · There is no server notion of pending or outcome-unknown**

- *Now:* `CommandResponse` is `{ ok, message, data? }`
  (`_shared/types.ts:947-951`). A command either commits in one transaction or
  throws. "Outcome unknown" exists only in the browser, as `NoAnswer.mutating`
  (`lib/api.ts:78-87`), and `unconfirmed` is a field the client adds to itself
  (`components/clinic-context.tsx:9-21`).
- *Gap:* a tablet that lost the answer cannot ask the server what committed.
- *Policy:* safe technical default.
- *Contract:* an outcome-lookup by idempotency key. Additive fields on the
  envelope only.
- *Compatibility:* the frontend reads named fields, so new fields are free.
  **Widening an existing status union is not** — see [§8](#8-compatibility-map).
- *Depends on:* W1 (there must be a key to look up).

### Appointments — Slice 2

**W5 · Appointments are same-day arrivals, not a calendar** — **closed by
Slice 2, [§12](#12-slice-2-what-was-built).** The entry below is what was found
and proposed; what was built differs in one respect worth reading first: the
future did NOT become new columns and a new status on `jmc.appointments`. That
table is the live queue, and owner item 70 says a booking does not join the
live queue until check-in, so bookings are a table of their own and
`check_in_appointment` is the single door. The rest — the state machine, the
in-transaction conflict check, the idempotent commands, the bounded calendar
and the token index — is as proposed.

- *Now:* `appointments` carries a token, a `scheduled_at` **text** column, and
  four statuses `('waiting','in_consult','done','cancelled')`
  (`20260831000000_clinic_schema.sql:69-77`). The snapshot returns waiting and
  in-consult rows for today only (`snapshot.ts:800-802`). There is no
  availability, no future horizon, no reschedule or no-show history.
- *Gap:* everything future-dated.
- *Policy:* **approved** — owner items 65–74. Items 65–71 govern scheduling;
  items 72–74 govern consultation/visit reconciliation.
- *Contract:* appointment type/availability, an explicit state machine with
  actor/reason/timestamp, conflict check inside the write transaction,
  idempotent book/reschedule/cancel/check-in, bounded calendar query.
- *Migration:* new tables. `appointments.token` still has **no unique index**
  (`SCHEMA_AND_TYPES.md` §3.7) — fix it in this slice, not later.
- *Compatibility:* walk-in must keep working with no appointment; check-in must
  reuse the existing arrival so a retry cannot create two queue entries.
- *Test:* concurrent booking, concurrent check-in, clinic-day and timezone,
  preserved cancellation history, existing walk-in journeys unchanged.
- *Depends on:* W1's idempotency pattern.

### Communications — Slice 3

**W6 · Sending is gated but there is no delivery truth**

- *Now:* `whatsappStatus()` (`_shared/whatsapp.ts:10-19`) requires four
  variables and `sendWhatsAppText()` refuses without them. Two callers:
  `send_order`, and `send_patient_whatsapp` which additionally requires
  `patient.whatsapp_consent` (`commands.ts:2456-2457`). `whatsapp_messages`
  logs outbound sends. `verifyWebhookSignature` and `webhookVerifyToken` are
  exported and **called by nothing** — there is no inbound webhook function.
- *Gap:* no template versioning, no per-purpose consent, no schedule, no
  outbox/attempt model, no delivery state, no retry, no dead letter. A provider
  response is not delivery and nothing today records the difference.
- *Policy:* **approved** — owner items 76–83. `WHATSAPP.md` §10 rule 8
  already fixes the shape: *every send is a row before it is a send, with an
  idempotency key*. Owner policy item 22 forbids automated pay-later reminders;
  no reminder built here may carry a balance.
- *Contract:* template metadata, consent evidence by channel and purpose,
  schedules, outbox with attempts and terminal state, authenticated deduplicated
  webhook, staff-owned failure queue.
- *Compatibility:* extend the existing WhatsApp model; do not start a second one.
- *Test:* consent withdrawal, quiet hours, duplicate worker, out-of-order and
  duplicate webhooks, retry exhaustion, role visibility. **No live send.**
- *Depends on:* W5 (a reminder needs something to remind about).

### Diagnostics — Slice 4

**W7 · No investigation or referral loop exists**

- *Now:* nothing. No table, column, command or type mentions an investigation,
  lab order or referral. Result documents can only ride in as clinical images,
  which pharmacy cannot see and which carry consent semantics meant for
  photographs.
- *Gap:* the whole order → result → review → notify loop.
- *Policy:* **owner decision required** — D13–D17.
- *Contract:* catalogue, order tied to patient and encounter, explicit state
  machine, private result documents with provenance and supersession, an
  abnormal flag whose source is explicit, review acknowledgment, notification
  evidence, overdue read model.
- *Test:* wrong-patient attachment, corrected reports, review-before-release,
  duplicate upload, notification failure, full audit.
- *Depends on:* W6 (notification), W9 (secure document access).

### Patient-facing — Slice 5

**W8 · No patient share layer, no intake, no upload**

- *Now:* nothing. No share link, token, grant or intake table. The only
  token-like mechanism is the 60-second HMAC image ticket (`_shared/storage.ts`).
- *Policy:* **owner decision required** — D18–D22. Owner item 28 already says a
  patient may receive images through controlled download or print and **never
  automatically through WhatsApp**; a share link must not become that.
- *Contract:* purpose-specific opaque grants storing only a token hash, with
  issue/expiry/revoke/last-access; minimum-necessary resolution; versioned
  intake forms; uploads into quarantine pending staff review.
- *Test:* hashing, rate limiting, expiry, revocation, patient isolation,
  superseded documents, unauthorized clinical merge.
- *Depends on:* W4.

### Portability and recovery — Slice 6

**W9 · The R2 archive has still never been restored from**

- *Now:* `.github/workflows/backup.yml` dumps, encrypts with `age` and uploads
  to R2. The nightly `restore-drill` takes a **fresh dump** from the live
  database and restores that (`scripts/db-restore-drill.sh`). It never downloads
  the uploaded object, never decrypts it. `docs/README.md` §6 describes this
  accurately and calls it the gap worth closing first. It still is.
- *Gap:* the archive's readability is unproven.
- *Policy:* safe technical default; the credential step needs approval.
- *Contract:* a drill that fetches the actual stored object, checks integrity,
  decrypts and restores into a disposable scratch target.
- *Blocker:* needs R2 credentials in CI. **Do not provision them without a new
  instruction.** Implement the local/CI logic and report the external step.

**W10 · Exports are narrow and there is no integration-event contract**

- *Now:* `csv` exports the drug master only. `reports` returns JSON for 15
  named reports, no download. `register` produces the H1 register. Image export
  is consent-checked.
- *Gap:* no patient, encounter, dispensing, bill/payment, ledger, purchasing or
  audit export; no outbox for downstream events.
- *Policy:* safe technical default within existing role rules.
- *Test:* export authorization and isolation, artifact expiry, event dedupe.

### Purchasing — Slice 7

**W11 · The purchase order is a base-unit number and a free-text message**

- *Now:* `create_order` writes `(id, order_id, medicine_id, ordered_quantity,
  received_quantity)` and nothing else (`commands.ts:2331-2368`). The three
  structured columns read `('', null, null)`. What the supplier gets is
  `message_draft`, editable text; editing it does not change what the system
  believes was ordered. Open POs are not subtracted from the reorder
  calculation, so the same shortage drafts repeatedly. `supplier_medicines` is a
  yes/no link with no SKU, pack, MOQ, price or lead time. `returnWindowDays` is
  accepted by the backend but not exposed, so suppliers default to zero days and
  all their expiring stock reads as non-returnable. There is no supplier edit or
  deactivate. **And an order cannot leave `pending` without WhatsApp** — §4.
- *Policy:* **owner decision required** — D23–D27.
- *Contract:* package-aware editable PO lines using the three existing columns;
  a supplier procurement profile; an explicit state machine; `mark placed`
  with channel and reference; expected arrival and acknowledgement; message
  generated *from* the saved lines; open quantity derived from lines and
  receipts; duplicate-draft guard.
- *Compatibility:* `create_order`, `update_order_draft`, `send_order` and the
  Orders snapshot shape must keep answering until the frontend cutover.
- *Test:* package conversion, MOQ and order multiple, profile version change,
  partial receipt, cancel and short close, duplicate draft, manual place,
  permissions, historical rendering.

### Receiving — Slice 8

**W12 · Two receiving paths produce two grades of stock evidence**

- *Now:* verified condition 2. `receive_order` creates a batch with no GRN, no
  package version or snapshot, no invoice, no tax, no free/quarantine/rejected
  split, no idempotency key and no expiry check. A duplicate submit is stopped
  only by the unique index on `(medicine_id, batch_number)` — and the pharmacist
  is shown the constraint's own words, not a clinic sentence. **Retyping the
  batch number defeats it entirely: forty tablets delivered, eighty on the
  shelf, the order believing eighty arrived.** All pinned by
  `unprotected-write-paths.test.mjs`.
- *Policy:* owner items 10, 11, 14 already govern receiving; **D28–D30** cover
  duplicate invoices, discrepancy tolerance and credit-note settlement.
- *Contract:* `post_goods_receipt` becomes the one engine. `receive_order`
  routes through it when its inputs suffice, or is retained with
  characterization, telemetry and a stated deprecation. Add a
  receiving-prefill query from the saved PO. Model discrepancies explicitly.
  Extend returns with the real credit-note reference, date, amount and
  application.
- *Compatibility:* the Orders modal must keep working until it is migrated.
  Do not silently reinterpret its ambiguous quantities.
- *Test:* duplicate retry, same key different data, simultaneous receipts,
  over-receipt, paid and free quantity, package conversion, partial receipt,
  batch and expiry validation, quarantine, duplicate invoice, ledger
  reconciliation, partial credit, legacy compatibility.

**W13 · Medicine creation is a stock-entry back door**

- *Now:* verified condition 3, pinned by the same test file. It also accepts a
  batch that expired in 2020, which `post_goods_receipt` refuses at
  `inventory.ts:911-914`. Expired stock is correctly excluded from `pickable`,
  so it cannot be dispensed — but it is counted, valued, and has to be noticed
  by somebody before it can be written off.
- *Policy:* owner item 14 — opening stock is a blind physical count reviewed by
  admin. This path is neither blind nor counted nor reviewed.
- *Contract:* opening stock leaves ordinary medicine creation and enters through
  the opening count or a GRN. Add the safest server guard permitted while the
  existing form still posts `initialQuantity`.
- *Compatibility:* `components/pharmacy-workspace.tsx:301-326` still sends the
  field. Guard, do not break.

### Reordering — Slice 9

**W14 · Reorder is min/max over shelf quantity and calls nothing by its name**

- *Now:* a medicine is low when pickable on-hand is at or below a manual
  `reorder_level`; a draft asks for `target_stock − on_hand`, minimum one base
  unit (`commands.ts:2343`). Open POs are not subtracted. No consumption, no
  measured lead time, no stockout history, no price history, no explanation.
- *Policy:* **owner decision required** — D31–D34. Owner item 19 forbids
  reservation: prescribing must not be subtracted as demand.
- *Contract:* the programme's stated formula, an explanation payload carrying
  every input and a formula version, decision history (accepted, adjusted,
  dismissed, snoozed) with actor and reason, and reconciliation against open PO
  lines. **Do not call it AI and do not let it place an order.**
- *Test:* fixed fixtures for zero stock, open PO, partial receipt, returns,
  corrections, free quantity, inactivity, sparse history, stockout days,
  supplier and package change, MOQ, order multiple, clinic-day boundary. Assert
  the explanation, not only the quantity.
- *Note:* the current 18-medicine fixture set cannot support a performance
  assertion. A bulk generator is needed before the query-plan check.

### Counting — Slice 10

**W15 · A full count is not proven full and scope is a free-text note**

- *Now:* two blind count systems — `opening_counts` (package-aware, per-line
  admin review) and `stock_takes` (recurring, one raw base-unit input per
  batch). Both correctly hide the expected figure and post a delta rather than
  overwriting. But the recurring count accepts a submission containing only the
  batches somebody typed into, the server requires at least one line rather than
  every in-scope batch, and "part of the shelf" is a note. There is no scan-led
  count although the barcode model exists.
- *Policy:* owner item 14 covers opening count. **D35–D36** cover cadence and
  scope after rollout.
- *Contract:* freeze explicit scope membership at session start; record expected
  scope size without exposing expected quantity; package-aware entry converted
  to base units with the entered evidence retained; completeness or explicit
  authorized omission; count-due and count-exception read models; a modelled
  transition out of opening count.
- *Test:* frozen scope, a medicine added mid-count, zero counts, omissions,
  package conversion, duplicate entry, concurrent sale and receipt, blind
  reveal, approval permissions, retry, reversal, ledger reconciliation.

### National infrastructure — Slice 11

**W16 · No ABDM/ABHA groundwork**

- *Now:* nothing.
- *Policy:* **owner decision required** — D37–D39, and the research step is
  mandatory before any schema is proposed.
- *Boundary:* no production credentials, no live calls, no compliance claim, no
  bulk upload of existing patients.

### And one that belongs to no slice

**W1 · Signing a consultation is the only listed operation with no
idempotency, and it double-charges**

This is the single most consequential finding of Slice 0, so it is listed last
where it can be read whole.

- *Now:* `completeConsultation` mints `const encounterId = randomUUID()` at
  `commands.ts:345`. The consultation-fee line is keyed
  `` `consultation:${encounterId}` `` and `invoice_lines.source_key` is uniquely
  indexed — but because the encounter id is new on every call, two calls can
  never collide. The only real protection is `requireActiveAppointment`
  (`commands.ts:334-342`), which **returns without checking anything when no
  `appointmentId` is supplied.** Consult sends `appointment?.id`
  (`consultation-workspace.tsx:809`), resolved from the patient's first row that
  is neither `done` nor `cancelled`; a patient opened from the Patients register
  with no visit created today has no such row.
- *Proved:* signing the same sheet twice with no appointment produces **two
  encounters, two invoices and two ₹300 fee lines** — a ₹600 bill for one
  visit. With an appointment the retry is correctly refused.
- *The comment is wrong too.* `commands.ts:427-429` says "a retry cannot produce
  a second one even on a second invoice". The index guarantees one fee per
  *encounter*, which is a different promise. A later reader trusting that
  sentence would not look.
- *Contradicts:* `AGENT_IMPLEMENTATION_BRIEF.md` §4 Slice 4 — "Enforce
  uniqueness by source/encounter so retries cannot double-charge" — and §7,
  which lists encounter completion among the five operations requiring an
  idempotency key.
- *Policy:* already decided. No owner question. Owner item 15 requires the fee
  snapshot; item 24 requires numbers never to be reused; nothing authorizes
  charging twice.
- *Contract:* `sign_consultation` takes a client idempotency key, stored with
  enough request and result identity to return the original outcome. The same
  key with materially different input is rejected.
- *Migration:* an idempotency key column on `encounters` with a unique index.
- *Compatibility:* additive — the server must accept a call without a key for
  as long as the current build is deployed, so the guard has to be the
  appointment check *plus* the key, not the key alone.
- *Test:* pinned today by `unprotected-write-paths.test.mjs`; those assertions
  invert when this is fixed, which is the point of writing them down.
- *Recommended:* the first item of the next slice, ahead of its read models.

## 6. The decision register

This began as the questions **nobody had answered**. Later owner decisions are
kept in place and reclassified as **A**, with their authoritative
`OWNER_POLICY_REGISTER.md` item cited rather than the question being deleted.
Almost everything still marked **O** below is new ground this programme opens.

Every bullet in the programme's own "Policy questions to classify" list has an
entry here, including the ones whose answer looks obvious. An obvious-looking
answer invented by an implementer is still an invented clinic policy.

Classification: **A** = already decided, **T** = safe technical default the lead
may choose and record, **O** = owner decision required before the slice.

### Appointments (Slice 2)

| # | Question | Class |
|---|---|---|
| D1 | Appointment duration, and whether it varies by reason | **A** — owner item 65: 15 minutes by default, configurable by appointment type |
| D2 | How far ahead booking is allowed | **A** — owner item 66: 90 clinic-local calendar days |
| D3 | Is overbooking permitted, and who may do it | **A** — owner item 67: off by default; doctor/admin explicit override with reason |
| D4 | Cancellation and rescheduling rules, and any notice period | **A** — owner item 68: no minimum notice; nurse/doctor/admin before check-in; doctor/admin with reason after check-in |
| D5 | What a no-show is, when it is marked, and by whom | **A** — owner item 69: eligible after 30 minutes; never automatic; nurse/doctor/admin confirms |
| D6 | Where a walk-in sits against a booked slot | **A** — owner item 70: one queue ordered by actual arrival; doctor urgency override with reason |
| D7 | Who may edit availability | **A** — owner item 71: doctor/admin; nurse books within it |
| — | Booked and walk-in converge into one arrival at check-in | **A** — competitive decision 6; also the programme's own acceptance criterion |

### Reminders and recalls (Slice 3)

| # | Question | Class |
|---|---|---|
| D8 | Channel — WhatsApp Cloud API, deep link, or both | **A** — owner item 76: both, with official Cloud API as the only automated channel and deep links limited to patient initiation or staff-confirmed fallback |
| D9 | Reminder timing, and quiet hours | **A** — owner item 77: 08:00–20:00 clinic-local; one appointment reminder at 18:00 on the previous day and one clinician-selected recall at 09:00 on its due date |
| D10 | Is registration consent enough per purpose, or is per-purpose consent required | **A** — owner item 78: channel-and-purpose-specific, versioned consent evidence; registration counts only for purposes named explicitly |
| D11 | Who owns a failed delivery, and for how long before it escalates | **A** — owner item 79: admin-owned from first failure; three attempts/two hours maximum; terminal or exhausted failures immediately, and every unresolved failure after four clinic hours, reach the escalation queue |
| D12 | What a recall cohort may be, and who releases one | **A** — owner item 80: frozen set of individual doctor-authored recall instructions; authorized-doctor release only |
| D12a | Who approves a message template, and what a new version of one requires | **A** — owner item 81: owner-doctor/authorized-doctor approval; any wording, purpose, variable, locale, destination or category change creates a new immutable version |
| D12b | How a patient opts out, and whether opting out of one purpose opts them out of all | **A** — owner item 82: purpose-specific when named; an unqualified stop withdraws all clinic-initiated WhatsApp; no staff override |
| D12c | What makes a patient eligible for a recall, and which clinician action schedules it | **A** — owner item 83: an explicit doctor-authored purpose, due date and responsible doctor; never a query result |
| — | No automated pay-later or debt reminders | **A** — owner item 22 |
| — | Every send is a row with an idempotency key before it is a send | **A** — `WHATSAPP.md` §10 rule 8 |
| — | Delivery state comes from provider evidence, never from a send call returning 200 | **T** |

### Investigations and results (Slice 4)

| # | Question | Class |
|---|---|---|
| D13 | Who owns the investigation catalogue | **O** |
| D14 | Where an abnormal flag may come from | **O** — external report, imported structured flag, or authorized manual flag only; never inferred |
| D15 | Who must review a result before the patient may be told | **O** |
| D16 | How long before an unreviewed result escalates, and to whom | **O** |
| D17 | May a notification contain clinical detail, or only "your result is ready" | **O**; `WHATSAPP.md` §5 argues strongly for the latter |

### Patient links, intake, uploads (Slice 5)

| # | Question | Class |
|---|---|---|
| D18 | What identity check a link requires, if any | **O** |
| D19 | Link expiry, use limit, and revocation triggers | **O** |
| D20 | Proxy and family access — a parent opening a child's summary | **O** |
| D20a | Which purposes exist at all — visit summary, prescription, invoice, result, follow-up, appointment action | **O**; build only the purposes whose policy is decided |
| D20b | May a link permit download, or only viewing | **O** |
| D20c | May a patient reschedule or cancel through a link, and how many times | **O** |
| D21 | Intake fields, consent wording and its versioning | **O** |
| D22 | Upload types, size limits, retention, and who reviews | **O** |
| — | A patient may receive documents by controlled download or print, never automatically by WhatsApp | **A** — owner item 28 |
| — | Uploaded material never silently becomes an authoritative clinical fact | **A** — programme §5 |

### Purchasing (Slice 7)

| # | Question | Class |
|---|---|---|
| D23 | Does a purchase order need approval above a value, and whose | **O** |
| D24 | How a preferred supplier is chosen when several carry an item | **O** |
| D25 | What a manual `mark placed` must record — channel, reference, date | **T** unless the owner wants more |
| D26 | Short-close and cancel reasons | **O** |
| D27 | What supplier lead time defaults to before any receipt history exists | **O** |
| — | Suppliers, return windows and procurement profiles are pharmacist/admin work | **A** — owner item 12 |

### Receiving and credits (Slice 8)

| # | Question | Class |
|---|---|---|
| D28 | What makes a supplier invoice a duplicate — number alone, or number plus supplier plus date | **O**; until decided, surface a reviewable conflict rather than blocking or accepting |
| D29 | Discrepancy tolerance before a receipt needs approval | **O** |
| D30 | How a partial supplier credit is settled and when it is written off | **O**; adjacent to owner item 56's unresolved accountant workflow |
| D30a | How damaged and short-delivered quantities are treated — quarantine, reject, or claim | **O**; owner item 10 requires free quantity be recorded but says nothing about damage |
| D30b | Whether a supplier invoice scan is retained, and for how long | **O** |
| D30c | Who may approve a receipt that is outside the D29 tolerance | **O** |
| — | Batch, expiry, package quantity, free quantity, purchase price and basis, MRP and basis, tax | **A** — owner item 10, pending real invoices (evidence gate I.1) |
| — | An expiry already past is refused at the door | **A** — `INVENTORY.md` §3; currently true of `post_goods_receipt` only, see W12/W13 |

### Reordering (Slice 9)

| # | Question | Class |
|---|---|---|
| D31 | Review interval — how often purchasing is actually done | **O** |
| D32 | Safety buffer — days, or a percentage, and per what | **O** |
| D33 | Demand window, and what to do when history is too thin | **T** for the fallbacks; **O** for the window |
| D34 | Who may accept, adjust or dismiss a suggestion | **O** |
| D34a | Is there a seasonality override, and who sets it | **O**; the honest default is none — say the data is thin rather than model a season from one year |
| D34b | Do two products that substitute for each other share demand for this calculation | **O**; note owner item 21 permits no pharmacist substitution, so a shared-demand model would not match how they are actually supplied |
| — | No automatic ordering, ever | **A** — owner item 19, `INVENTORY.md` §8, programme §20 |
| — | Prescribing is not demand and is never subtracted | **A** — owner item 19 |

### Counting (Slice 10)

| # | Question | Class |
|---|---|---|
| D35 | Cycle-count cadence and scope rule after the opening count | **O** |
| D36 | When Opening count disappears from routine navigation | **O** |
| — | Blind until the approved reveal; admin reviews discrepancies | **A** — owner item 14 |

### ABDM (Slice 11)

| # | Question | Class |
|---|---|---|
| D37 | Which pilot workflow — ABHA linking, Scan & Share, or record exchange | **O** |
| D38 | Whether existing patients are ever linked in bulk | **O**; default is no |
| D39 | Who holds facility and professional registry identity | **O** |

### Slice 12 — not started, and each part needs its own decision

Payments (D40 provider, expiry, fees, refunds, reconciliation ownership),
teleconsultation (D41 provider, identity, consent, recording prohibition),
accounting export (D42 target product and mapping — and note owner items 56 and
57 are still open with the clinic's accountant), assistive drafting (D43 data
handling, permitted content, reviewer, provenance). **O** throughout. None may
begin without an explicit instruction.

### Blocking before the next slice

**Nothing blocked Slice 2, and Slice 2 is now built.** D1–D7 and the three
consultation/visit reconciliation questions were approved on 15 September 2026
as owner-policy items 65–74, and [§12](#12-slice-2-what-was-built) records
what each of them became. W1 and W5 are both closed.

**Slice 3 is ready and has not started.** D8 to D12c were approved on
17 September 2026 as owner-policy items 76–83: channel, timing and quiet hours,
per-purpose consent, delivery-failure ownership and escalation, recall cohorts,
template approval/versioning, opt-out, and clinician-created eligibility. Slice
2 left the durable hook (`appointment_events`) and sent nothing. Production
still requires current provider-policy validation, approved templates,
credentials and the clinic privacy notice; those are release dependencies, not
permission to invent a second provider path or to weaken the approved policy.

| Question | Approved policy, 15 September 2026 | Status |
|---|---|---|
| What happens to a visit left `waiting` when the consultation was signed before it existed | Never automatically edit the signed encounter or cancel the visit. **Same attendance** records an append-only audited reconciliation link and closes the visit; **New attendance** keeps the visit for a fresh consultation. | Approved as owner item 72. **Built in Slice 2** — `resolve_consultation_attempt`, same/new attendance, append-only and doctor-only. |
| How an attempt is released after a non-rotating refusal | Release only after the server establishes the previous outcome and the doctor explicitly resolves same attendance, new attendance, or an abandoned inactive-visit attempt. Never release automatically; fail closed if the outcome remains unknown. | Approved as owner item 73. **Built in Slice 2**, including the advisory lock that makes "the outcome cannot be established" a real state rather than a guess. |
| What happens when an unresolved attempt opened on visit A meets a different live visit B | Do not automatically mint. Resolve the old key first. The doctor explicitly selects **Same attendance** or **New attendance**; reception creating B is not proof of a second consultation. | Approved as owner item 74. **Built in Slice 2** — `ATTEMPT_NEEDS_RECONCILIATION` no longer invites a rotation. The current tablet can still auto-mint; that is the frontend cutover and is stated as an open exposure in §12. |

All three decisions form one reconciliation policy and preserve the
properties this slice was built to hold — no
silent edit of a signed record, and no release that a single unread message and
one press can turn into a second ₹300 fee. **Slice 2 added the append-only,
audited backend transitions and the contract**; the later frontend programme
still owns the doctor-facing control, and until it ships the deployed tablet
cannot reach the new refusal. See [§12](#12-slice-2-what-was-built).

## 7. Contract and migration sequence

Smallest additive order. Table and command names follow existing conventions —
`snake_case` tables in `jmc`, `snake_case` command names, `numeric(12,2)` money,
integer base units, `timestamptz`, append-only history, and a unique index
behind every idempotency key.

| Slice | Migrations | Commands | On-demand queries | Breaks the frontend? |
|---|---|---|---|---|
| **1** | `encounters.idempotency_key` + unique index (W1); `patients` search indexes; read-model indexes | `sign_consultation` gains an optional key | patient search; workload counts; visit progress; safe-exit obligations; outcome lookup; eligible-equivalent lookup | No — all additive |
| **2** — **built**, and in one respect differently from this proposal: the future is `appointment_bookings`, a table of its own, because `jmc.appointments` IS the live queue (owner item 70) | `appointment_types`, `provider_availability`, `appointment_bookings`, `appointment_events`, `consultation_attempt_resolutions`; **`appointments.token` unique index, partial on the open rows**; five appointment columns; `appointments_token_idx` dropped | `create_appointment_type`, `update_appointment_type`, `publish_availability`, `retire_availability`, `book_appointment`, `reschedule_appointment`, `cancel_appointment`, `mark_no_show`, `check_in_appointment`, `set_queue_priority`, `resolve_consultation_attempt` | day/range calendar; patient appointment history; attempt reconciliation; two work lists | No — walk-in path untouched |
| **3** | `message_templates`, `communication_consents`, `communication_schedules`, `message_outbox`, `message_attempts` | `schedule_reminder`, `cancel_reminder`, `resend_message` | due reminders; failed deliveries; consent suppression | No |
| **4** | `investigation_catalogue`, `investigation_orders`, `investigation_order_items`, `investigation_results`, `result_documents`, `result_reviews` | `order_investigation`, `record_result`, `review_result`, `authorize_result_notification` | pending review; overdue results | No |
| **5** | `share_grants`, `intake_forms`, `intake_submissions`, `patient_uploads` | `issue_share_grant`, `revoke_share_grant`, `accept_patient_upload`, `reject_patient_upload` | grant resolution (unauthenticated, rate-limited, minimum-necessary) | No |
| **6** | `export_jobs`, `integration_events` | `request_export` | export status/download; degraded-state health | No |
| **7** | `supplier_procurement_profiles`; supplier edit/deactivate columns; **populate the three existing PO-line columns** | `update_supplier`, `deactivate_supplier`, `save_procurement_profile`, `update_order_lines`, `mark_order_placed`, `record_order_acknowledgement`, `close_order_short` | open quantity on order; supplier performance | No — `create_order`/`send_order`/`update_order_draft` keep answering |
| **8** | `goods_receipt_discrepancies`; supplier credit-note columns on `supplier_returns`; opening-stock guard | `post_goods_receipt` extended; `receive_order` routed or deprecated; `resolve_receipt_discrepancy`, `settle_supplier_credit` | receiving prefill from a PO | No — the Orders modal keeps working |
| **9** | `reorder_suggestions` (in `jmc`, **not** the retired `public` view), `reorder_decisions` | `accept_reorder_suggestion`, `adjust_reorder_suggestion`, `dismiss_reorder_suggestion` | reorder candidates with explanation; usage and position views | No |
| **10** | `count_sessions`, `count_scope_members`; package-aware count entry columns | `start_count`, `record_count_entry`, `submit_count`, `approve_count` | count due; count exceptions | No |
| **11** | `abha_links`, `abdm_consents`, `abdm_outbox` — all behind a per-environment flag, disabled by default | gated; none enabled | none enabled | No |

Three rules this sequence must not break:

1. **Nothing joins the snapshot.** Every read model above is on-demand. The
   snapshot already carries five unbounded collections (`patients`, `medicines`,
   `batches`, `suppliers`, `orders`); no slice may add a sixth.
2. **No mutable duplicate status column** is added to make a proposed screen
   easier to draw. Derive from the authoritative facts.
3. **No new `text` timestamp**, and no new `real` money column.

## 8. Compatibility map

What a backend change may and may not do to the current build. The frontend
talks to the backend through `lib/api.ts` only — four exports, one generic
`command` POST built in `components/ClinicApp.tsx:217-220`.

**Free.** A new field on any response or snapshot view. Almost every read site
accesses a named field; the only key-iteration over backend data in the whole
frontend is `reports-workspace.tsx:513-527`, which derives report table columns
from `Object.keys(row)` and therefore picks a new column up automatically.

**Breaks the build, loudly.** Widening an existing closed string-literal union.
`InvoiceView['paymentState']` is indexed through an exhaustive
`Record<>` at `shared-panels.tsx:2009,2050`; `AppointmentView['status']`,
`BedView['status']` and `PurchaseOrderView['status']` are indexed through
inferred `as const` lookup objects (`care-workspaces.tsx:46-51`,
`shared-panels.tsx:90-102`, `pharmacy-workspace.tsx:48`). A new union member
fails `tsc --noEmit` rather than crashing a tablet — a safe failure, but it is
a change to the frontend, so a slice that adds a status must add the lookup
entry in the same change.

**Breaks silently.** Making a currently-required field optional.
`InvoiceView.total/paid/due/paymentState`, `MedicineView.totalAvailable/
baseUnit/packageSummary`, `BatchView.pickable/expired` and `BedView.status` are
read as plain values.

**Must keep answering until the frontend cutover.** Every command string the
build sends today, listed in the audit and grepped from `components/`. The ones
this programme touches: `receive_order` (`pharmacy-workspace.tsx:1110`),
`add_medicine` (`:165`), `create_order` (`:896`), `send_order` (`:1056`),
`update_order_draft` (`:1037`), `sign_consultation`
(`consultation-workspace.tsx:961`).

**Already dead.** `ClinicSnapshot.otcSales` and `OtcSaleView` have zero
references in `components/` or `lib/`; OTC history reaches the screen through
`invoices` rows with `source: 'otc'`. Changing or removing it costs the runtime
nothing — but check the type import before deleting the type.

**The one place a new field is not free.** `snapshot?since=` returns
`{ unchanged: true }` when nothing changed, and the client patches only
`doctorPresent` in place (`ClinicApp.tsx:167-174`). Anything that must reach a
tablet between full snapshots has to go through a full snapshot, or through the
command response that caused it.

## 9. Documentation corrected

Corrections supported by source or by a test run, per programme §6.8. Historical
rationale was preserved; only claims contradicted by the current code changed.

| Document | Was | Now |
|---|---|---|
| `README.md` §1 | "Nine Edge Functions", and a nine-row endpoint table | 12, with `images`, `inventory` and `reports` added to the table |
| `README.md` §2 | "`tests/` two files. This is the entire automated suite" | the real tree, including `characterization/` and `browser/` |
| `README.md` §3 | "there is no local backend … no offline stack of any kind" | true of `npm run dev` only; the guarded staging stack is named |
| `README.md` §6 | "Four unit tests" · "288 tests over seventeen files" · "37 journeys" | 9 · 325 over 20 files · 56 |
| `README.md` §6 | `staging:rehearse` listed among the checks that run | it did not run at all — §4; now fixed and described accurately |
| `STAGING.md` §1 | "Four commands", above a five-command block | five |
| `STAGING.md` §5 | "thirty-seven journeys", "twenty-two more" | 56, counted |
| `INVENTORY.md` §10 | reorder intelligence "shipped in M3", "the code exists" | corrected: those five view names belong to the **retired** application; nothing in `jmc` implements them |
| `ci.yml` header | "There is no database test suite in this repository and no end-to-end test" | corrected; the same file defines both jobs |
| `browser-gate.mjs`, `functions-server.mjs`, `tests/browser/support/harness.mjs`, `STAGING.md` §4 | "the nine Edge Functions" / "the nine of them" in comments | 12 |
| `STAGING.md` §1, §5a | the rehearsal described as covering "the two Slice 2 migrations" | every migration from Slice 2 on, with why it had been dead |
| `README.md` inventory | 49 Markdown documents; `archive/README.md` absent although tracked and linked at `README.md`:176 | 50, with it listed |
| `CLAUDE.md` | `test:db` (316 tests) | 325 — this slice’s own new file is what moved it |

`CLAUDE.md`'s database-test count moved 316 → 325, because this slice's own
new test file is what made the old number stale. Its other numbers were already
right and were left alone.

Two corrections above were found by the independent review rather than by the
pass that made them, and both were in files this slice was already editing: the
rehearsal's own description in `STAGING.md`, which still said it covered two
Slice 2 migrations, and two more "nine Edge Functions" comments of exactly the
kind the pass had already fixed twice elsewhere. A corrections sweep that fixes
a sentence in one file and leaves its twin in the next is not a sweep.

## 10. What Slice 0 did not do

- **No feature was implemented.** No new table, no new command, no new response
  field, no migration, no schema change of any kind. Nothing under
  `supabase/`, `components/`, `lib/` or `app/` was touched. What this slice
  changed is five documents, a stale CI header, three comments, the migration
  rehearsal, and one new test file.
- **W1 was not fixed.** A consultation can still be signed twice. Fixing it is
  a contract change — an idempotency key on `sign_consultation` and a migration
  behind it — and the programme reserves that for the slice that owns the
  contract. It is recommended as the first item of the next one.
- **Nothing was deployed, pushed, or run against the clinic.**
- **No policy was invented.** Every question without an answer is in §6 marked
  **O**, including the ones with an obvious-looking answer.
- **The R2 archive was not restored from** (W9). It needs credentials that
  nobody has authorized this session to use.
- **No performance assertion was made.** The fixture set is 18 medicines and 20
  batches — right for shape, useless for a query plan. Slices 1 and 9 both need
  a bulk generator before their performance gates mean anything.

---

## 11. Slice 1: what was built

Completed 14 September 2026, against the guarded loopback scratch database. The
clinic's live backend was never contacted. W1 was fixed first, ahead of the read
models, as §5 recommended.

### The migrations

| | |
|---|---|
| `20260918000000_consultation_idempotency.sql` | `encounters.idempotency_key` and `encounters.request_fingerprint`, a unique index on the key, and a check that the pair travels together. |
| `20260919000000_slice1_read_model_indexes.sql` | Six indexes and no columns: normalized name and phone-digits on `patients`, a partial index on the open queue, a token lookup, patient-recent indexes on `encounters` and `vitals`, and a partial index on open follow-ups. |

Nothing was added to the clinic snapshot, no mutable workflow-status column was
created, no new `text` timestamp and no new `real` money column. Both migrations
pass `npm run staging:rehearse`, applied to a database that already has history
and then applied a second time.

### W1, closed

`sign_consultation` takes an optional `idempotencyKey`. The encounter carries it
with a unique index, and carries a SHA-256 fingerprint of the material request
beside it. A retry with the same key and the same sheet returns the **original**
encounter, prescription number and signing time with `duplicate: true`. A retry
with the same key and a materially different sheet is refused rather than
answered with the earlier patient's record. Two tablets submitting one key at
the same moment produce exactly one consultation: the loser meets the unique
index, its whole transaction rolls back, and it is handed the winner's outcome
instead of a constraint name.

The fingerprint deliberately excludes the medicine name and strength snapshots
copied from the formulary at signing, and the clinic's default fee. Both can
change between a lost reply and its retry without the doctor having changed
anything, and a false rejection would strand them.

`requireActiveAppointment` still refuses a second signature on a visit that came
from the queue. The key is the guard for the case that check could never see —
a patient opened from the register with no visit row open — which is precisely
the case that was charging twice.

Its row lock turned out to be a second serialization point with a recovery of
its own. Two tablets signing one **queued** patient under one key never reach
the unique index: the loser waits on the appointment lock, wakes to a visit the
winner has just closed, and has written nothing for the index to refuse. It was
told the visit was "already finished or does not belong to this patient" —
false in both halves, with its own consultation a millisecond old. Every
refusal on that path now re-reads the key first, and a caller that finds its own
consultation is answered through the same replay the index race uses.

**The comment that was wrong is corrected in place.** `commands.ts` claimed the
`invoice_lines.source_key` index meant "a retry cannot produce a second one even
on a second invoice". It guarantees one fee per *encounter*, which is a
different promise, and the gap between the two was the whole of W1.

### The read models, closed

One new Edge Function, `workspace`, with eight views: patient search, patient
context, workload counts, the drill-down behind each count, visit progress,
safe-exit obligations, idempotency-outcome lookup, and eligible-equivalent
lookup. Everything is on demand. The full contract is
[`SLICE1_FRONTEND_CONTRACT.md`](SLICE1_FRONTEND_CONTRACT.md).

Two properties are worth recording here because they are structural rather than
merely tested for:

**A count and its drill-down are one SELECT.** The count is `count(*)` over the
same statement the rows come from, so they cannot disagree. Every count in one
workload response is read in a single statement, so the badges describe the
clinic at an instant rather than over a few seconds.

**A count carries only what somebody can act on.** A prescription past its
validity is not on the counter's list, because the pharmacist cannot supply the
remainder (item 18) — it is a `blocked` obligation owned by the doctor. A bill
that is over-refunded, or cancelled and off zero, is not on the money list,
because item 55 says filing it with ordinary unpaid bills is how it comes to be
ignored.

### The eligible-equivalent lookup was justified, not assumed

The programme allows it "if the existing server contract is incomplete". It was:
no command, no `inventory` view and no report took a prescription line and
returned the eligible candidates. The only server-side answer was to attempt
`dispense_rx` and be refused. The counter's existing substitute list is computed
in `components/counter-math.ts` from the polled snapshot — a copy of the
server's rule, over data up to fifteen seconds old, which can disagree with the
fresh in-transaction read when an admin deactivates a product or relinks its
clinical drug. The new lookup returns candidates and constraints and chooses
nothing.

### Authorization: one table, and the drift that was left alone

`supabase/functions/_shared/capabilities.ts` declares every capability this
slice adds, with the roles it admits and — on every entry — the existing gate
that list was copied from.
`tests/characterization/workspace-authorization.test.mjs` walks that table
rather than repeating it, tries all four roles against every entry, and fails if
a capability is added without a route or a route without a capability.

**No role was given anything it could not already obtain.** Each list was copied
from `snapshot.ts`'s seven booleans, the `record` endpoint's doctor-only gate,
the `REPORTS` matrix, or item 17's counter table. Two consequences worth naming:
a nurse is not shown allergy alerts, because only the doctor reads the clinical
record today; and a doctor is not shown the bill, because the doctor's snapshot
has never carried one. Both are existing boundaries reproduced, not decisions
taken here. Whether a nurse taking vitals should see recorded allergies is an
owner question and is not answered by this slice.

The wider drift stands: `requireRole`, the seven snapshot booleans, the
`REPORTS` matrix and the per-endpoint `hasRole` checks are still four
independent mechanisms with no database policy behind any of them, and a
capability added to one and forgotten in another still fails silently. The
programme says in as many words not to refactor eighty-five working operations
for neatness, and a half-migrated authorization layer is worse than a consistent
old one. **This remains an open hardening decision for somebody to take
deliberately**, and the new table is a demonstration of the shape rather than a
migration to it.

### The independent review, and what it caught

An agent that did not implement the slice reviewed it against the programme's
Slice 1 requirements before the handoff, as §4 of the programme asks. It found
eight defects the implementation's own tests did not, and all eight are fixed.
They are recorded because a slice that only lists what it got right is not
evidence of having been checked.

**The critical one was in the fix itself.** `consultationFingerprint` included
`appointmentId`. Consult resolves that field live from the snapshot as the
patient's first row that is neither done nor cancelled — and signing sets the
row to `done`. So on the one retry the whole mechanism exists for (signed, reply
lost, poll landed) the tablet sends no appointment, the fingerprint differs, and
the retry was refused with *"this reference belongs to a different
consultation"*: false, and unrecoverable, because the key is scoped to the
patient and every attempt afterwards was refused too. It failed intermittently —
a doctor who retried before the fifteen-second poll saw it work — which is worse
than failing consistently. The appointment is out of the fingerprint now, and
`consultation-idempotency.test.mjs` pins the retry-after-done case.

**Two more were in the client's rotation rule**, which is the half the programme
says must actually hold end to end. Discarding a draft released the key, so the
sequence Finish → reply lost → Save draft → Discard → Finish minted a fresh key
and wrote the second encounter and the second ₹300 fee — the exact bill W1
exists to prevent. And the release on success lived inside `useTask`'s
`confirmed` callback, which does not run when the panel unmounted mid-request —
which is precisely the case `lib/attempt-key.ts` was written to survive, so a
confirmed consultation could leave its key behind and refuse the patient's next
genuine visit. Discard no longer releases; success releases on the response.

**One was a permission widening**, the thing this slice's own rule forbids. The
consult stage was gated on `arrival` rather than on the clinical record, so a
nurse and an administrator were told that a consultation draft existed for a
patient and that a consultation had been signed — two facts `encounters` and the
doctor-only `record` endpoint give them no route to. It leaked back through the
obligations derived from the same stages, too.

**And one was a comparison that could never be true.** `follow_ups.due_date` is
a `date`, the driver returns a JavaScript `Date`, and comparing its string form
against `YYYY-MM-DD` compares a weekday initial against a century digit — so
every overdue follow-up read as not started and never became an obligation. It
is compared in SQL now, against the clinic's day rather than the server's.

The rest: the name index the migration claimed was used was not used, because
one unindexable branch in an `OR` makes Postgres scan for all of them — the
search is two statements now and the plans are measured; the outcome lookup used
the caller's key as an unescaped `LIKE` pattern, so `key=%` returned a split
payment's receipt without knowing any key; a caller gated out of the lookup was
told *"nothing carries this reference, send it again"*, which is the one thing a
refusal must not say; a batch with no supplier read as returnable; and two
lookup tables accepted `constructor` and `__proto__` as view names.

The review also confirmed, field by field, that no material field is missing
from the fingerprint, that the transaction's lock order is unchanged, that the
pool cannot deadlock on the added pre-check, that both migrations are
re-runnable, and that the client change is strictly non-visual.

**What it raised that was not fixed**, with the reason:

- The concurrency test does not deterministically prove the unique-index branch
  rather than the pre-check branch answered the loser. Both are correct and the
  test cannot tell them apart. The branch was verified by instrumenting it
  during development — exactly one hit per run — and the index itself is proved
  separately against the table. A deterministic version needs a barrier the test
  harness does not have.
- Nothing proves the client rotates the key correctly, because there is no
  component or browser test for it. Two of the three defects above were of that
  kind. It belongs in the browser suite and is named in the frontend contract.
- `encounters_patient_recent` and `vitals_patient_recent` supersede two existing
  single-column indexes, which now cost a write each for nothing. Dropping
  another slice's indexes to save that is not this slice's call and the saving
  is small; it is recorded here instead.

#### What the independent review of the correction found

Seven more, all fixed. The first is the one that mattered.

1. **The staleness rule minted where it had to reuse.** `beginAttempt` treated
   any live visit id differing from the stored one as a second consultation,
   and that is false in the direction nobody had walked: a walk-in opened from
   the register stores no visit, and a doctor who creates today's visit row
   between a lost reply and the retry — which policy item 3 explicitly allows
   and which is the tidy thing to do — made the ids differ. The tablet minted a
   fresh key and wrote a second encounter and a second ₹300 fee for one
   consultation. Only a different visit where the attempt already HAD one is
   evidence of a second arrival; a visit appearing where there was none is the
   same consultation, and now reuses. Three unit tests hold the shape.
2. **The server promised a rotation the tablet did not perform** —
   `ATTEMPT_NAMES_ANOTHER_CONSULTATION` says "the tablet will use a fresh
   reference" and nothing did, so the stale reference refused every press
   afterwards. `settleConsultationAttempt` now releases on that code and on no
   other, and four database tests assert the codes arrive on the HTTP body
   rather than only in process.
3. **The browser test protecting the discard rule was vacuous.** It never saved
   a draft, so `Discard draft` was never rendered, the click returned `none`,
   and the assertion passed because nothing had happened — reverting the line
   it exists to protect would not have failed it. It saves a draft first now
   and asserts the press.
4. **Nothing tested release-after-unmount.** The other review defect — a
   release inside a callback `useTask` does not run once the panel has gone —
   was caught only by reading. A browser journey now signs through a
   deliberately slow connection, walks to another station while the request is
   open, and asserts the attempt was released and the consultation committed
   once.
5. **The performance test EXPLAINed paraphrases, against empty tables.** The
   per-patient statements were restated in the test and had already drifted
   from production, and `vitals`, `encounters` and `consultation_drafts` had no
   rows, so every "does not scan" assertion was true of nothing. The statements
   are exported as `PATIENT_READS` and the generator seeds arrivals, readings,
   encounters and drafts.
6. **`appointments_token_idx` was dead.** The branch compared
   `upper(token) = upper($1)`, which a btree on the bare column cannot serve,
   so the index was maintained on every arrival and used by nothing — while a
   comment and the schema document both said it was used. Tokens are generated
   uppercase, so only the caller's input needs folding. The plan assertion now
   names the index instead of asserting that some other table was not scanned.
7. **A phone typed with its country code found nobody.** The index compares the
   last ten digits and the query compared all of them, so the form printed on
   every card — +91 98765 43210 — fell through to a name scan. The contract
   claimed "any formatting"; four forms are now tested.

Two more surfaced only when the browser gate was actually run to completion,
and both were in the test file written to protect the client:

8. **`Call in` clicked whoever was first in the queue.** The helper walked up
   from each button until it found an ancestor whose text contained the
   patient's name — and every button has one, because the queue is a single
   container holding every waiting patient. So it pressed the first Call in on
   the screen whatever name it was asked for. Three of the four journeys never
   noticed, because none of them checks which patient it ended up working on;
   the fourth did, only because it counts that patient's encounters. The
   matcher now climbs to the smallest element holding exactly one Call in, and
   every journey asserts the patient it asked for is the one on the screen.
9. **The file's own cleanup had never run.** `invoice_lines` is append-only by
   trigger, and the teardown deleted from it — so as soon as any journey signed
   a consultation, teardown raised and the file failed after its tests had
   passed. The trigger is suspended for exactly that delete and restored
   immediately, on a database `guard.mjs` refuses to let be anything but a
   loopback scratch.

Smaller: `maySee` gained the prototype guard `mayUse` already had; an empty
patient id can no longer open a shared attempt scope; a comment claiming
Postgres's LIKE escape default is a server setting was corrected; the schema
document had two sections numbered 13.4; and the contract named **Next
patient** as the recovery from `CONSULTATION_ALREADY_SIGNED` when that control
is only rendered after a confirmed signing. The real exit — restore the sheet
to what was signed, press again, take the replay, which is a success and
therefore releases the attempt — is now documented and tested end to end.

### The second acceptance correction, 15 September 2026

Two defects, both recorded at the top of the programme after the second
acceptance review, and both reproduced against staging before anything was
changed.

**1. A direct consultation that acquired a visit left the visit behind.**

An attempt opened with no visit row kept sending "no visit" for the rest of its
life. So a doctor who opened a walk-in from the register, pressed Finish, lost
the reply, then created today's visit — which policy item 3 explicitly allows,
and which is the tidy thing to do — and pressed again, got a consultation that
succeeded while the visit sat in the queue as `waiting`, attached to nothing.
Reproduced in both directions:

| | Before | After |
|---|---|---|
| The first request never committed | A second press wrote the encounter with `appointment_id = null`; the visit stayed `waiting`. | The encounter is written **against the visit**, and the visit goes `done`. |
| The first request did commit | The replay was correct and silent; the visit stayed `waiting`. | Refused with `CONSULTATION_SIGNED_WITHOUT_THIS_VISIT`, which names the consultation AND says the visit is still open, and the leftover visit is carried as an `unlinked_consultation` obligation. |

The tablet sends the visit it has on screen rather than the one the attempt was
opened against, and the server compares the two as a case analysis instead of
an equality test. (**Superseded by the third correction below**, which kept the
case analysis and restored the opened-against value beside the live one: this
pass fixed one half and lost the other.) That distinction is the whole fix: a request naming **no**
visit is compatible with a stored one (the ordinary retry — signing is what
takes the visit out of the snapshot), a request naming a **different** visit is
another consultation, and a request naming a visit where the encounter has
**none** is its own answer.

That third case had to stop being `ATTEMPT_NAMES_ANOTHER_CONSULTATION`, because
the tablet rotates on that code — so the old behaviour, had the client simply
started sending the live visit, would have been a fresh reference and a second
₹300 fee. It was verified on staging that it did exactly that before the server
changed.

**2. The clinic day no longer mints.**

An unresolved attempt is retained across midnight. Elapsed time is not evidence
about what committed, and minting on a date change meant a reply lost at 23:59
and retried at 00:01 wrote a second encounter and a second fee — W1, by the
clock, and a known road back to it is not a completed idempotency fix. The
earlier outcome is reconciled instead: the same sheet replays, a different one
is refused, and starting a genuinely new consultation is an explicit act
(a confirmed signing, or **Next patient**) rather than a date changing.

The trade is now the other way round and is stated in the frontend contract: a
patient with no visit row, consulted again the next day under a sheet that
differs, meets `CONSULTATION_ALREADY_SIGNED` until the operator makes that
transition. A refusal that says why is the right side of that trade.

**3. The contract contradicted itself** about whether a visit appearing after
`visitId = null` reuses or mints. It reuses. The normative rule, the lifetime
table and the recovery section now say the same thing, and the rule is split
into the two questions it was conflating: which attempt to use, and which visit
to send.

#### What this correction deliberately did NOT decide

A consultation signed before the visit existed leaves a `waiting` visit
attached to nothing. The clinic now refuses to sign it twice, says so in the
doctor's own words, and carries the leftover visit as a `blocked` obligation on
that patient. **At the time of this correction, what happened to that visit was
not decided**, because every way of deciding it was clinic policy. Owner item 72
has since approved an explicit append-only reconciliation; Slice 1 still does
not implement it:

| Option | What it costs |
|---|---|
| **Link** the signed encounter to the visit and close it | Edits a signed record. `encounters.appointment_id` is administrative rather than clinical, but the programme's invariant is that clinical history is append-only, and "only a little bit of the signed row" is not a line this slice should draw on its own. It is also wrong whenever the visit is genuinely a later, separate arrival. |
| **Cancel** the visit | Decides that a visit a doctor deliberately created did not happen, and does it automatically, on the strength of a timing coincidence. |
| **Leave it and report it** (what is implemented) | Correct and safe, and leaves a real queue row for a person to close. The queue is momentarily wrong until they do. |

There is a fourth option — ask the doctor at the moment it happens and act on
the answer — which is a screen, and screens belong to the later frontend
programme. The obligation is the durable half of it.

#### And a second question, found by the review of this correction

After either non-rotating refusal — `CONSULTATION_ALREADY_SIGNED` or
`CONSULTATION_SIGNED_WITHOUT_THIS_VISIT` — the tablet holds an attempt it
cannot let go of, and neither exit is a control the doctor has in front of
them at the moment they read the refusal.

The two do not end the same way, and the first version of this section said
they did. Inside the replay the **binding is judged before the fingerprint**,
so only a request that agrees about the visit ever has its sheet compared:

- `CONSULTATION_ALREADY_SIGNED` is about the sheet, and restoring it
  byte-for-byte to what was signed replays and releases the attempt. If the
  doctor has edited it, undoing every edit by hand is the documented route.
- `CONSULTATION_SIGNED_WITHOUT_THIS_VISIT` is about the visit, and **restoring
  the sheet does nothing at all** — a byte-perfect sheet is refused with the
  same code, because `compareBinding` has already refused it and the
  fingerprint is never reached. What ends it is closing or cancelling the queue
  row, which takes the live visit out of the snapshot; the attempt's own
  identity then answers, the fingerprint is compared, and the consultation
  replays. That is the same act the `unlinked_consultation` obligation asks
  for, so the obligation and the exit coincide — which is the only reason this
  state is survivable. Pinned by `(e3)` in
  `tests/characterization/consultation-visit-identity.test.mjs`.

Closing the tab works for both and is not a workflow. A doctor who cannot sign
is a clinical blocker, so "hold forever" is not a finished answer either.

| Option | What it costs |
|---|---|
| **Release the attempt on those two codes.** The refusal proves the outcome is known, so the attempt's protective job is discharged. | The next press writes a second encounter and a second ₹300 fee. It takes one unread message and one deliberate press — which is a real thing to happen at a counter — and it is W1 by a shorter road than the one just closed. |
| **Give the screen a control that abandons the attempt** — the explicit, reviewable transition the programme asks for. | It is a screen, and screens belong to the later frontend programme. It is also the only option that makes the transition genuinely explicit rather than merely one more press. |
| **Leave it as it is** (what is implemented) | Safe, honest, and occasionally requires a doctor to retype a sheet, or to get somebody to close a queue row, or to close a tab. |

This is not the same question as the leftover visit above, and answering one
does not answer the other. Both block a confident "Slice 1 accepted", and the
second one is the more likely to be met on an ordinary day.

**Evidence for the owner.** Both branches, the refusal code, the untouched
billing and the surviving queue row are pinned by
`tests/characterization/consultation-idempotency.test.mjs` ("a direct
consultation that acquires a visit before the retry", five tests) and driven
through the real screen by `tests/browser/consultation-attempt.test.mjs`
("a direct consultation that acquires a visit", three journeys including the
midnight retry).

### The third acceptance correction, 15 September 2026

Five findings from the third acceptance review, and a sixth that the proof
demanded by the third finding uncovered on its first run. Every one was
reproduced against staging before anything was changed.

**1. One visit identity was carrying two jobs, and dropping one of them.**

The second correction made the tablet send the visit it has **on screen**,
which fixed a visit created mid-attempt being left unlinked. It also threw away
what the attempt was **opened against** — and that is not the same fact.

An attempt opened on a queued visit, whose first request never committed, whose
visit was then cancelled: the poll takes the visit out of the snapshot, the
tablet has nothing live to send, and the server saw a request naming no visit
at all. It wrote a **direct consultation**. The cancellation was stepped
around, the encounter was attached to nothing, and ₹300 was charged for an
attendance somebody had said did not happen. The same held for a visit somebody
else had marked `done`.

The request now carries both, additively:

| Field | What it is | Who it protects |
|---|---|---|
| `appointmentId` | the visit on screen **now** | a visit created mid-attempt, which would otherwise stay `waiting` and unlinked |
| `openedVisitId` | the visit the attempt **began against**, immutable | a visit cancelled or closed under the attempt, which would otherwise be bypassed |

A caller that sends neither behaves exactly as it did before this slice, which
is what keeps the build already on the clinic's tablets working, and that
compatibility is asserted rather than asserted-about.

A first signing now resolves the visit **inside the transaction**: the live one
wins when there is one; otherwise the opened one is read `for update` and
signed against while it is still `waiting` or `in_consult`. Cancelled, closed
or gone, the signing is refused with `ATTEMPT_VISIT_NO_LONGER_ACTIVE` — a code
the tablet does **not** rotate on, because a fresh reference there writes
exactly the unlinked consultation the refusal exists to prevent. The way
forward is a clinic act: create today's visit, which mints a new attempt
through the ordinary rule and signs against it.

**2. The whole state matrix is now pinned, side effects and all.**

`tests/characterization/consultation-visit-identity.test.mjs` walks every way
the two identities can part, and each branch asserts the complete set —
encounter linkage, appointment status, invoices, consultation-fee lines, the
amount charged, prescriptions, follow-ups, the `encounter.completed` audit row,
and the key and fingerprint the encounter was written under — rather than the
one field its name is about. A consultation that links correctly and charges
twice is not a pass.

The attempt's own release is **not** asserted there and cannot be: that file
calls the command layer directly, and an attempt lives in a tab's
`sessionStorage`. It is held by `tests/attempt-key.test.ts` for the rules and
by `tests/browser/consultation-attempt.test.mjs` for the panel that calls them.
The first draft of this section claimed otherwise, and the independent review
caught it.

**3. Two tablets, one key, one QUEUED patient — and the sixth defect.**

The existing concurrency proof used a patient with **no visit at all**, so
`requireActiveAppointment ... for update` never ran. Writing the queued case
failed immediately, and the failure was worth having:

- the loser waits on the appointment's row lock;
- the winner commits, setting the visit to `done`;
- the loser wakes, re-evaluates its `for update` against the updated row, finds
  nothing active — and has written nothing, so the unique index never speaks
  and the replay path never runs;
- it was told **"That visit is already finished or does not belong to this
  patient."** False in both halves, with its own consultation sitting in the
  clinic a millisecond old, and indistinguishable to the doctor from a real
  conflict.

Every refusal on that path now re-reads the key first. A caller that finds its
own consultation is carried out of the transaction and answered through the
same recovery the index race uses, so both callers get the same encounter, the
same `signedAt`, exactly one `duplicate: true` between them, one closed
appointment and one complete side-effect set — with and without a prescription
and a follow-up riding along.

**4. `unlinkedConsultationWithOpenVisit` read the wrong day column.**

It filtered the appointment on `created_at` — when somebody typed it in —
instead of `scheduled_at`, the day the patient is expected. Wrong in both
directions at once: an appointment booked this morning for tomorrow was
reported as today's orphaned queue visit, and today's appointment booked last
week was missed. The obligation's words are *"is still waiting in the queue"*,
so naming tomorrow's visit sends a doctor to look for somebody who is not in
the building. Three characterization tests cover both directions plus the stale
row from last week, and all three fail against the old column.

**5. The recovery documentation overstated what restoring a sheet can do.**

The contract said the way out of a non-rotating refusal is to re-send the sheet
exactly as signed. That is true of `CONSULTATION_ALREADY_SIGNED` and false of
`CONSULTATION_SIGNED_WITHOUT_THIS_VISIT`, because `compareBinding` is judged
**before** the fingerprint: a request naming a live visit the encounter does
not have is refused on the binding, and a byte-perfect sheet is never read.
What ends that state is closing or cancelling the queue row — the same act the
`unlinked_consultation` obligation asks for, which is the only reason the state
is survivable. The contract, this register and `SCHEMA_AND_TYPES.md` §13 now
say so, and `(e3)` in the visit-identity file pins it.

**At this correction handoff, the two then-known owner questions remained open
and unimplemented.** The third was found immediately afterwards. All three were
approved on 15 September 2026 as owner items 72–74. Nothing in Slice 1 implements
them; the approved append-only backend transitions and contract belong to
Slice 2, and the doctor-facing control belongs to the later frontend programme.

### What Slice 1 did not close

- **A consultation signed before its visit existed leaves that visit open.**
  The clinic refuses to sign it twice, names the consultation, says the visit is
  still waiting, and carries it as an `unlinked_consultation` obligation — but
  a person has to close the queue row. Owner item 72 now defines the explicit
  reconciliation, but its backend transition is not built until Slice 2.
- **A pre-W1 client can still sign twice.** The server accepts a call with no
  key because the deployed build sends none, and refusing it would lock the
  clinic out of signing. Pinned by `consultation-idempotency.test.mjs` — "a
  caller that sends no key is still unprotected" — so that the test fails and
  says so when the window closes. Closing it means requiring the key, after the
  frontend cutover.
- **Vitals still cannot be tied to a visit.** `jmc.vitals` has no appointment or
  encounter reference, so the vitals stage reports "was anything recorded for
  this patient today", which is not the same question for a patient who attends
  twice in one day. Inventing the link would mean a column that guesses. The
  honest fix is a foreign key, and it belongs to a slice that may change that
  table.
- **A surname typed on its own is still a scan.** Phone, token, id and
  name-prefix are index lookups; the middle-of-a-name fallback cannot be,
  because `pg_trgm` is not installed and installing an extension is a
  deployment decision. It runs only when the indexed pass finds nothing, and
  the plan test asserts that it stays the fallback rather than quietly becoming
  the normal path.
- **Performance is asserted for search and for the per-patient reads, and not
  for everything.** `workspace-performance.test.mjs` builds 20,000 patients
  from a deterministic generator, `EXPLAIN`s the same statements the endpoint
  runs, and removes them again. What it holds is structural — index use, no
  sequential scan where one would be wrong, every answer bounded — rather than
  milliseconds, because a threshold in milliseconds passes on a fast laptop and
  gets raised until it asserts nothing. The one timing assertion is a ratio
  between two plans measured in the same run. What it does not cover is every
  work list's own plan; the counts are asserted bounded rather than indexed.
- **Two arrivals for one attendance, found by the independent review of the
  third correction.** The mint rule is *the attempt holds visit A and a
  different visit B is live*, and that is meant to read "the patient arrived
  again". It cannot tell that apart from "the row vanished because the first
  signing committed, and reception re-queued the patient who was still
  standing there". The sequence: a signing on queued visit A commits, the reply
  is lost, the screen says **Outcome not confirmed**; A is now `done` so the
  snapshot drops it; reception arrives the patient again as visit B; the doctor
  presses Finish on the unchanged sheet. The tablet mints a fresh key, the
  server has never seen it, and it signs against B — **a second encounter and a
  second ₹300 fee for one attendance.**

  Nothing downstream catches it. The fingerprint is only ever compared within
  one key; `invoice_lines.source_key` is `consultation:<encounterId>` and so is
  unique by construction; and the `unlinked_consultation` obligation does not
  fire, because both encounters are properly linked to real visits. It is W1's
  harm reached by minting rather than by rotating, and the server cannot see it
  at all — two signings under two keys against two genuine visits are exactly
  what a patient seen twice in one day looks like.

  Not fixed in Slice 1, because every fix was a policy choice that slice could
  not make: refusing a second consultation for one patient on one day would
  refuse a real second attendance; asking the doctor is a screen; and making
  the attempt survive its visit disappearing would undo the second correction.
  Owner item 74 now chooses an explicit doctor resolution after an authoritative
  outcome check; Slice 2 owns the backend transition and contract. The
  characterization is in `tests/attempt-key.test.ts` — "a patient re-queued
  after a lost reply looks exactly like a second arrival" — which pins what the
  rule does today and names what it costs. It belongs with the two owner
  questions above rather than with the closed work.
- **`receive_order` and `add_medicine` are untouched.** They are W12 and W13,
  Slice 8, and `unprotected-write-paths.test.mjs` still pins what they do.
- **Two direct consultations for one patient, on one clinic day, in one tab,
  where the first ended outcome-unknown.** The clinic has no appointment to
  tell them apart, so the second is treated as possibly the same consultation
  until something resolves it. Exactly one thing does: re-sending the sheet
  exactly as it was signed, which replays, and a replay is a success and
  therefore releases the attempt. Creating a visit row does NOT — the mint rule
  requires the attempt to already hold a *different* visit id — and neither
  does the next clinic day, since elapsed time no longer mints at all.
  **Next patient** releases one but is rendered only after a confirmed signing,
  which in this state is precisely what has not happened. Refusing is the safe
  direction — accepting writes a second fee for one visit — but the way back
  out is one sheet restored by hand. Owner item 73 now authorizes an explicit,
  audited resolution after the server establishes the prior outcome, but that
  transition is not part of Slice 1. It is the only case in the current attempt lifecycle without an automatic
  exit, and it is in the frontend contract's lifetime table rather than left to
  be discovered.

### What the acceptance-correction pass changed, 14 September 2026

Six defects found reviewing Slice 1 against its own acceptance criteria, and
seven more found by the independent review of that correction. The second set
is listed after the first, because a correction pass that only records what it
set out to fix is the same kind of evidence as a slice that only lists what it
got right.

1. **The attempt was scoped to the patient and excluded the visit**, so an
   unresolved attempt on one visit was spent on the next: an identical sheet
   replayed the earlier encounter, and a different one was refused with no way
   back. The visit is now captured when the attempt is opened, re-sent
   unchanged on every retry, and checked by the server as a binding separate
   from the sheet — with its own refusal code, because a stale reference and an
   edited sheet need different answers. The frontend contract had said the
   appointment was material while the implementation excluded it; they now
   agree.
2. **No test covered the client lifecycle.** The rules moved into
   `lib/consultation-attempt.ts`, unit tests cover them (seventeen when this
   was written; twenty-six now, after two further corrections), and a browser
   journey drives the real Consult screen through a dropped connection, an
   unmount, a station change and a full reload.
3. **Patient search did not escape LIKE metacharacters** and did not
   de-duplicate its UNION. `%` paged through the register, `_` widened an
   exact-looking prefix, a trailing `\` raised, and a patient matching two
   branches appeared twice.
4. **`visitProgress` and safe-exit used the allergy capability** to decide
   whether consultation facts were visible. `consultation_progress` is now its
   own capability holding the same roles, and a test performs the widening to
   prove the two no longer move together.
5. **Performance evidence was a hand-bulked database and a set of
   milliseconds.** It is now a deterministic fixture that cleans up after
   itself and asserts plans and bounds.
6. **The server promised a rotation the tablet did not perform.**
   `ATTEMPT_NAMES_ANOTHER_CONSULTATION` tells the doctor in so many words that
   "the tablet will use a fresh reference", and the client released an attempt
   on a confirmed signing and on nothing else — so the stale reference was kept
   and the next press was refused again, and the press after that, for a
   patient who had done nothing wrong. A promise the tablet does not keep is
   worse than one it never made. `settleConsultationAttempt` now releases on
   that one code and on no other: its sibling `CONSULTATION_ALREADY_SIGNED`
   must not rotate, because a fresh key there writes a second encounter and a
   second fee for one visit, which is W1 arriving by another road. Four unit
   tests hold the two apart, and four database tests assert the codes arrive on
   the HTTP body — everything else asserted them in process, which proves the
   command raises the right refusal and proves nothing about what a tablet
   receives.

## 12. Slice 2: what was built

> **Read §12.1 first.** This section is the implementer's account as written on
> 15 September 2026, and an acceptance review then reproduced failures it did
> not know about — including one that wrote an encounter and a ₹300 fee against
> the wrong visit. Where this section and §12.1 disagree, §12.1 is later and is
> what the code does. It is kept rather than rewritten because a slice that
> edits away what it got wrong is not a record.

Built 15 September 2026, against the guarded loopback scratch database. The
clinic's live backend was never contacted. Owner policy items 65–74, approved
the same day, are the whole authority for everything below; nothing here
answers a question the owner had not.

### What ran, and what it said

| | |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | 38 unit tests, all passing (36 before this slice; two added to the attempt lifecycle) |
| `deno check --node-modules-dir=none supabase/functions/**/*.ts` | clean, all 13 Edge Functions |
| static export, built against `http://127.0.0.1:54321/functions/v1` | succeeds |
| `npm run test:db` | **632 tests over 27 files, all passing.** 526 over 25 before this slice; 86 in the two new files, and 20 more because `workspace-authorization.test.mjs` walks the capability table rather than a list somebody typed out, so three new views and two new work lists became twenty role assertions on their own |
| `npm run staging:rehearse` | 18 named checks, all passing, including three new ones over five legacy arrivals |
| `npm run test:browser` | **64 journeys, all passing** — unchanged, which is the point: this slice adds no screen |
| `git diff --check` | clean |

The database suite was run twice against a database rebuilt from scratch: once
before the independent review and once after its findings were fixed. The
second run is the one above.

**And all of it was green while six reproducible faults were in the code.** The
counts in this table are superseded by §12.1's; they are kept because "the gate
passed" turning out not to mean "the slice is right" is the most useful thing
in this document.

### The migration

`20260920000000_slice2_appointments_and_reconciliation.sql`. Five tables, five
columns on `jmc.appointments`, two unique indexes, one index dropped, and the
schema's standing posture — row security on, forced off, every grant revoked —
applied to all five new tables. The full shape is `SCHEMA_AND_TYPES.md` §14.

**The one decision the rest of it rests on: `jmc.appointments` is not the
appointment table, it is the ARRIVAL table.** Every row in it is somebody
standing in the clinic with a token; `scheduled_at` is when they turned up;
and the snapshot sends all of it, four statuses deep, to every tablet in the
building with no role boolean in front of it. Owner item 70 says a future
booking "does not enter the live queue until check-in", and a row in
`appointments` IS the live queue — so a booking is a row in a new table,
`appointment_bookings`, and `check_in_appointment` is the only door between
them.

The alternative — a fifth status on the existing table — was costed before it
was rejected. Two files in `components/` hold exhaustive `Record<status, tone>`
maps that would have failed to compile, which is the good half; eight more
places compare `!== 'done' && !== 'cancelled'` and would have silently treated
a booked patient as somebody waiting in the corridor, which is the half that
does not fail loudly.

### Owner items 65–71, as built

| Item | What the clinic now does |
|---|---|
| 65 | Fifteen minutes by default. A type may say otherwise, and the number is **copied onto the booking** rather than joined, so a later change to the type cannot reach a booking already made — the same reasoning that snapshots the consultation fee onto the encounter. |
| 66 | Ninety clinic-local days, for booking and rescheduling alike. The far end is policy; the near end — not before today, judged at the DAY — is a safe technical default, because a patient booked for 10:00 and written in at 10:05 is an ordinary morning. |
| 67 | Overbooking off by default. A nurse meets `SLOT_ALREADY_TAKEN` naming who has the slot and has no override. A doctor or admin with no reason meets `OVERRIDE_REASON_REQUIRED`; with one, the booking carries `overbooked`, the reason, and the actor. |
| 68 | No minimum notice. Before check-in: nurse, doctor, admin. After: doctor and admin only, and the queue row the patient is standing in is cancelled with them. A reason is required for every cancellation and every reschedule, and every transition is an `appointment_events` row. |
| 69 | Eligible thirty minutes after the start, never automatic, confirmed by a person. A patient who checked in cannot be a no-show and is told so in those words. |
| 70 | Check-in stamps `scheduled_at` **now**, not the booked time, so a patient booked for 09:00 who arrives at 11:20 goes behind the walk-in who came at 11:00. A doctor — and only a doctor — may move somebody up, with a required reason. |
| 71 | Doctor and admin publish and retire availability; a nurse books inside it. Windows are recurring or dated, and `blocked` subtracts from `open`. |

Two things about item 71 were named here as judgements. **The first was wrong
and is corrected in §12.1** — it is kept below as written, because a record
that edits away its own mistakes is not a record.

**~~A clinic that has published nothing constrains nobody.~~** — **WRONG.**
Item 71 says a nurse books "within published availability" and admits no
exception; this read one in, and the acceptance review reproduced a nurse
booking a patient for three in the morning. A day with no open window is a day
a nurse cannot book. The clinic is not locked out on its first morning, because
a doctor or an admin books it with the override below — which was the answer
all along, and this paragraph talked itself past it. The original reasoning
follows:

> Item 71 says a nurse books "within published availability", and on the first
> morning there is none — so the rule as written would refuse a nurse every
> hour of every day until a doctor sat down and drew a timetable. The
> constraint applies only once an open window exists for that doctor. That is a
> safe technical default, recorded as one, and it is the kind of thing that
> would otherwise be discovered on a Tuesday morning by a nurse who cannot book
> anybody.

**A doctor booking outside published hours is allowed and recorded.** Item 71
constrains the nurse and says nothing about the doctor, who owns the hours; the
booking carries `outside_availability` and the reason, through the same
explicit-override mechanism item 67 defines for a conflict. Treating it as
silently permitted, or as forbidden, would both have been inventions.

### Owner items 72–74, as built

One command, `resolve_consultation_attempt`, doctor-only, and one read behind
the control the frontend programme will build.

A doctor presses Finish, the consultation commits in Chennai, and the reply is
lost. Within a minute the clinic may also hold a second queue row for the same
patient, because signing set the first to `done`, the poll dropped it, and
reception — seeing the patient still standing there — arrived them again.
Nothing the software can read tells "one attendance recorded once" apart from
"two attendances, one unrecorded". Slice 1 made every ending of that honest and
none of them finishable. This is the other half.

| Resolution | Requires | Does |
|---|---|---|
| **Same attendance** | the attempt committed | Records an append-only link between the encounter and the visit, closes the visit, charges nothing. `encounters.appointment_id` is **not** touched. |
| **New attendance** | either outcome | Settles the reference, leaves the visit open to be consulted normally, charges nothing. |
| **Abandoned attempt** | nothing committed, and the opened visit cancelled, closed or gone | Settles the reference; nothing else changes. |

Four properties hold across all three, and each is asserted on every branch by
`slice2-reconciliation.test.mjs` rather than argued for here:

- **No signed encounter is edited.** Same attendance records the link in
  `consultation_attempt_resolutions`; the encounter stays exactly as signed.
  Owner item 72's first clause, and the reason the link is a row rather than an
  update.
- **No second encounter, invoice, fee line, prescription or follow-up.** The
  side-effect set is compared in full, so a reconciliation that closes the
  right visit and charges ₹300 again would fail.
- **Nothing is released while the outcome is unknown.** See below.
- **Only a doctor.** Reception, nurse, pharmacy, and an administrator who is
  not also a doctor are refused. Whether a patient was treated once or twice is
  not an administrative fact.

### The lock, which is the part that is not obvious

`ATTEMPT_LOCK_NAMESPACE`, taken on the attempt's key as the first statement of
the signing transaction and as a **try**-lock in the resolution.

The unique index on `encounters.idempotency_key` serializes two signings. It
cannot serialize a signing against a resolution, because the two write
different tables and neither collides with the other — and that is exactly the
pair owner item 73 fails closed on. Without it: a doctor resolves, reads "no
encounter carries this key", concludes nothing committed, records **New
attendance**, releases the reference — and the signing that was in flight the
whole time commits a moment later, leaving the next press free to write a
second encounter and a second ₹300 fee. W1, by a road nobody had walked.

So a signing waits for a resolution, briefly. A resolution never waits for a
signing: "somebody is signing under this reference right now" is the definition
of an outcome that cannot be established, and it refuses with
`ATTEMPT_OUTCOME_NOT_ESTABLISHED`. The read reports `priorOutcome: "unknown"`
for the same reason rather than a confident `not_committed` that is about to
stop being true.

It also made the concurrent-signing case deterministic, which the Slice 1
review had recorded as unprovable: the loser now re-reads the key under the
lock and is answered through the replay, rather than racing two correct
branches that a test cannot tell apart.

**There are two namespaces, and the second one was not in the first design.**
One lock answering both "is a signing in flight" and "is another doctor
resolving" made the losing doctor's TRY fail, and it was told the outcome could
not be established — when what had actually happened was that the other doctor
had just established it, and the truthful answer was the determination they had
recorded. A resolution now takes a resolution-only lock first and blocking,
which serializes doctors against each other and lets the loser read what was
recorded, and then tries the attempt lock, which fails closed only against a
signing. A signing never takes the resolution lock, so the two orders cannot
form a cycle.

### One refusal split in two, and what that costs until the frontend cutover

`ATTEMPT_NAMES_ANOTHER_CONSULTATION` used to cover both "the key names a
different patient or doctor" and "the key names a different visit". The client
ROTATES on it — the server's own message promises it will — and owner item 74
says that is wrong for the second: *"Reception creating B is not, by itself,
proof of a second consultation."*

A different visit is now `ATTEMPT_NEEDS_RECONCILIATION`, which does not rotate.
A different patient or doctor keeps the old code and keeps rotating, because
there the key provably belongs to something else and holding it would refuse a
patient who has done nothing wrong, for ever.

**The deployed client never reaches the new code**, because `beginAttempt`
mints a fresh reference the moment a different visit goes live — so it sends a
key the server has never seen and signs against the second visit. That is the
*Two arrivals for one attendance* defect from Slice 1's own list, and **it is
still open in the client**. The backend now has the exit it was missing; the
cutover is two frontend changes that must land together (stop minting there,
and put the resolution in front of the doctor), because either alone is worse
than neither: minting without the control keeps the duplicate charge, and
refusing without the control leaves a doctor unable to sign.

It is written into `tests/attempt-key.test.ts` in the test's own name, and into
`SLICE2_FRONTEND_CONTRACT.md` §1.1, so it is a stated exposure rather than a
discovery.

### The token index, and one that was being maintained for nothing

`appointments.token` now has a unique index over the OPEN rows —
`where status in ('waiting','in_consult')`. `20260909125224` declined to
constrain the column on the ground that "a migration that fails on the damage
it exists to stop helps nobody", which is right about the whole table and too
broad about the open rows: the harm it describes needs both duplicates to be
open. Historical duplicates among finished visits are untidy; duplicates among
the eleven people in the corridor are the wrong patient in the consulting room.

The migration can still refuse, and does so with a sentence naming each
duplicate token and how many rows hold it, rather than with a constraint name.

`appointments_token_idx` is dropped. It was added by `20260919000000` for
exactly one query, whose predicate is the new index's predicate — so the full
index would have gone on costing a write on every arrival in order to answer
nothing, which is the condition `workspace-performance.test.mjs` exists to
catch. Its plan assertion names the partial index now and asserts the old one
is gone.

### What the tests caught that the implementation did not

Four, and the first two are the ones that mattered. The second was found by
reading rather than by a test, which is worth saying because it is the kind
that a green suite hides.

1. **A booking retry was told to justify overbooking itself.** Two tablets
   sending one reference: the winner commits, and the loser — which took the
   advisory lock on the doctor and then went straight to the conflict check —
   found the winner's booking sitting in the slot and was refused with
   `OVERRIDE_REASON_REQUIRED`. About its own appointment, a millisecond old.
   The refusal is false, it is unanswerable from where the person is standing,
   and the only answer that would get past it books the patient twice. The
   reference is now re-read under the lock, **before** the conflict check, and
   the loser is handed what the clinic holds.
2. **A read that could leak an advisory lock onto the wrong connection.**
   `readReconciliation` took `pg_try_advisory_lock` in one statement and
   released it in the next. The lock is SESSION-scoped and `db` is a pool of
   two connections outside a transaction, so the release was free to land on
   the other connection, fail silently, and leave the lock held for the life of
   the first — after which every signing under that reference would wait for
   ever. It passed every test, because a pool that is idle hands back the same
   connection. Now one statement takes it and gives it back, with the CTE
   `materialized` so the unlock cannot be inlined ahead of the lock, and the
   test reads it five times and asserts `pg_locks` is empty afterwards.

   This is the exact shape of fault the programme's own rule about short
   transactions and consistent lock order exists to prevent, arriving through
   a READ, which is where nobody looks for it.
3. **A NUL byte in a sentinel.** The conflict query excluded the booking being
   moved with `id <> coalesce(?, <NUL>)`, and Postgres refuses `0x00` in
   text — so every booking failed with an encoding error rather than a clinic
   sentence. An empty string is a value no id ever has and works.
4. **Three test faults of my own**, recorded because a slice that lists only
   the product's defects is not evidence of having checked: a test deleted from
   `appointment_events`, which is append-only by trigger and raised; the
   calendar test published availability for a fixed weekday and booked on
   whatever day tomorrow happened to be, so it passed or failed by the date it
   ran on; and the two-doctor race passed in isolation and failed about one run
   in three in the full suite, which is how the shared-lock defect above was
   found at all.

   That last one is the argument for running the whole suite rather than the
   file you just wrote. It passed five times alone before it failed once in
   company.

### The independent review, and what it caught

An agent that did not implement the slice reviewed it against owner items
65–74, the programme's Slice 2 acceptance criteria and the code, before this
handoff. It found no critical defect — it could construct no path to a second
encounter, a second fee, an edited signed encounter, or an attempt released
while the outcome was genuinely unknown — and then found four things above the
minor bar. All four are fixed. They are recorded because a slice that lists
only what it got right is not evidence of having been checked.

**1. A resolution that changed nothing about the next press.** The worst of the
four, and the one that would have made the whole slice feel broken in use.
`replayConsultation` answered `another_visit` without looking at whether a
doctor had already resolved the reference — so a doctor who recorded **New
attendance**, then pressed Finish, read the identical refusal that had sent
them to resolve in the first place, with nothing to say their decision existed.
The reconciliation read then reported all three options unavailable as
`RECONCILIATION_ALREADY_RESOLVED`. A loop with no exit, and the contract and
this register both claimed the reference had been released.

The replay now consults the resolution and answers from it, and the answer
splits: `ATTEMPT_SETTLED_BY_RECONCILIATION` after **New attendance** or an
abandoned attempt, which the tablet DOES rotate on — owner item 73 names an
audited resolution as the one thing that may release an attempt, and this is
it arriving as a code — and `ATTEMPT_RECONCILED_AS_SAME_ATTENDANCE` after
**Same attendance**, which it must not, because there the visit has been closed
and a fresh reference would have nothing live to name and would write a direct
consultation and a second fee for the attendance just reconciled.

**2. "The deployed client never reaches the new refusal" was false.** Stated
absolutely in four places. It is true of an attempt that already holds a visit,
because `beginAttempt` mints the moment a different one goes live. It is not
true of an attempt that holds NONE: `supersededByANewArrival` requires a stored
visit, and an attempt opened from the register stores `null` for its whole
life, so it never mints however many visits appear. A walk-in whose first press
did not commit, signed against a visit created afterwards, whose reply was then
lost, met by a second arrival, reaches `ATTEMPT_NEEDS_RECONCILIATION`, holds
the reference, and has nowhere to go — the doctor cannot sign.

That path double-charged before this slice and now stops instead, which is the
safer trade, but it is a narrow exposure rather than an impossible one. The
claim is corrected in all four places and the path has a test of its own in
`tests/attempt-key.test.ts`.

**3. One dated window locked a nurse out of every other day of the year.**
`published` asked whether the doctor had published anything ANYWHERE, so a
single "this Thursday, nine to one" refused a nurse `OUTSIDE_PUBLISHED_AVAILABILITY`
on every other day, and a weekly window whose effective range had run out
refused them for ever with nothing on any screen to say why — nothing retires
one automatically. It is scoped to the day being booked now, so an unpublished
day is simply an unconstrained day, which is the same default an empty calendar
gets. Three tests: the dated window, the expired range, and a doctor who works
weekdays, where Saturday is correctly closed rather than unconstrained.

**4. A foreign key with no usable index, and a gate test that could not see
it.** The migration claimed `appointments.booking_id` was served by
`appointments_one_live_arrival_per_booking`. It is not: that index is partial
on `booking_id is not null AND status <> 'cancelled'`, and the second conjunct
cannot be implied by `booking_id = $1`. Proved with `EXPLAIN` under
`enable_seqscan = off` — a sequential scan over the one table here that grows
for ever. `provider_availability.doctor_id` had the same shape behind
`where active`. Both now have plain-enough indexes, and the claim is corrected.

The gate test — `slice3-gate.test.mjs`, *"every foreign key has an index that
supports it"* — checks only that some index has the key as a leading prefix,
never that a partial index's predicate is implied. It returned `[]` while the
property did not hold. **Twenty pre-existing foreign keys across five earlier
slices are in the same position**, so tightening it would fail the suite on
conditions this slice did not create; it is written up under *What Slice 2 did
not close* as a hardening decision for somebody to take deliberately rather
than one to take on the way past.

Nine more, all fixed: a cancelled booking replayed as *"Already booked"* with a
`bookingId` a screen would render as live; `abandoned_attempt` skipped owner
item 73's own condition when the caller simply omitted `openedVisitId`; the
reconciliation read offered `abandoned_attempt` while the opened visit was
still in the queue, breaking the one promise its doc comment makes; that read's
comment claimed it answered "under the same lock the write takes", which it
does not and cannot; `reschedule_appointment` took the calendar lock after a
row lock while `book_appointment` took it before; `BOOKING_REFERENCE_REUSED`
(since replaced by `APPOINTMENT_REFERENCE_REUSED`, §12.1)
named three fields when the identity covers five; `retire_availability` wrote
the retirement reason into the note on some rows and not others; a no-show
refusal about last Thursday said *"This appointment was for 10:00"*; and two
policy numbers each had two copies, now in `_shared/clinic-policy.ts` with the
owner item cited beside each.

And four test weaknesses of the kind the review was asked to hunt: the new
`list.today_queue` columns were asserted nowhere; the snapshot-leak test
stringified the mapped row rather than the whole snapshot, so it only
re-stated the two lines above it; no test refused a pharmacist any appointment
command; and the migration's duplicate-token guard — the one statement designed
to fail a real deployment — was exercised by nothing, because the rehearsal
seeded no arrivals at all. The rehearsal now carries five legacy arrivals,
two of them finished and sharing JMC-0004, and asserts that the columns land
over existing rows, that the partial index tolerates the historical duplicate,
and that a second WAITING patient cannot be given a token somebody is holding.

### What Slice 2 did not close

- **The client still mints on a visit change**, so the duplicate charge is
  still reachable from the build on the clinic's tablets. Named above and in
  the contract; it is the frontend cutover.
- **No reminder is scheduled or sent.** `appointment_events` is the durable
  hook a later scheduler reads, and it carries the actor, the reason and the
  time of every transition. Owner items 76–83 now answer D8 to D12c — channel,
  timing, quiet hours, per-purpose consent, delivery-failure ownership,
  template approval, opt-out and recall eligibility. Slice 3 owns the
  implementation and has not started.
- **`jmc.vitals` still cannot be tied to a visit.** Unchanged from Slice 1; the
  honest fix is a foreign key on a table this slice had no reason to open.
- **A patient with two open visits is still resolved by `.find()` in four
  places in `components/`**, which takes the first in `scheduled_at` order.
  That is pre-existing and this slice does not make it more likely; it is
  recorded because check-in is a second way for a patient to acquire two open
  rows.
- **Reschedule after check-in cancels the arrival rather than moving it.**
  There is no way to move a queue row to another day, and inventing one would
  be inventing a clinic workflow. The booking goes back to `booked` and checks
  in again on the day it moved to.
- **Any doctor may resolve any doctor's attempt.** The resolving doctor is
  recorded, and the encounter's own doctor is not required to be the same
  person — deliberate, because a locum covering a clinic where the reply was
  lost yesterday is a real situation and refusing it would leave the reference
  held for ever. Narrowing it is an owner decision, not a defect.
- **The foreign-key gate test cannot see a partial index whose predicate is not
  implied.** `slice3-gate.test.mjs` and `slice6-gate.test.mjs` both check only
  that some index has the key as a leading prefix. Adding `and i.indpred is
  null` would be the strict form and would light up twenty foreign keys across
  five earlier slices — `follow_ups.doctor_id`, `supplier_returns.supplier_id`,
  `consultation_templates.owner_doctor_id` among them. Slice 2's own two are
  fixed and the rest are named here rather than swept in, because tightening a
  shared gate onto conditions a slice did not create is how a slice comes to
  own somebody else’s work. Nothing deletes a parent row in any of the twenty
  today, so the cost is latent.
- **One resolution per attempt, for ever.** A patient left holding two leftover
  queue rows for one attendance can have one closed by `same_attendance` and
  not the other; the second call is `RECONCILIATION_ALREADY_RESOLVED`. The
  second row is closed from the queue in the ordinary way. Recorded rather than
  fixed because a second resolution row against one reference would need its
  own idempotency scope, and nobody has met the case.
- **A resolution may name a reference the clinic has never seen.** On the
  `not_committed` branch nothing validates that the key ever existed, so a
  doctor can record a determination about nothing. Keys are random uuids and
  the row writes nothing clinical or financial, so the cost is a row describing
  an attempt that was never made.
- **`check_in_appointment` has no horizon.** A booking ninety days out can be
  checked into today’s queue. Deliberate — a patient standing at the desk is a
  patient standing at the desk, and refusing them because the calendar says
  Tuesday would be the software arguing with the room — but it is an allowance
  rather than an oversight, so it is written down.
- **The snapshot’s new ordering and the `.find()` hazard are the same hazard.**
  Four screens resolve "this patient’s open visit" by taking the first match in
  snapshot order (`consultation-workspace.tsx`, `care-workspaces.tsx` twice,
  `vitals-view.tsx`). `urgent desc` cannot move anything today, because every
  row is `false`; the first time a doctor prioritizes a patient who has two open
  rows, which visit the consultation attaches to changes. Pre-existing, and
  this slice adds a second way for a patient to acquire two open rows, so the
  two belong together.
- **Neither new work list is sargable**, and neither is measured at volume.
  Both scan the `status = 'booked'` partial index, which is small by
  construction, but `workspace-performance.test.mjs` seeds no bookings, so
  nothing proves it stays small.

## 12.1 Slice 2 was returned unaccepted, and what the correction changed

The handoff above reported a green gate. It was green and it was not enough:
the acceptance review reproduced, against the guarded loopback database,
failures that none of those 632 tests could see. Every one of them is a case
where the tests and the code agreed with each other and both were wrong about
the clinic.

**Slice 2 is not accepted.** This section records the correction; the slice
goes back for review rather than being called finished here.

### The one that could take money

**A first signing ignored the visit the attempt was opened against.** Slice 2
let the live visit win unconditionally — the code said "the tablet is looking
at it" — so an attempt opened against A that had committed nothing, arriving
with B live, signed B on the spot. An encounter, a ₹300 fee, and A still
standing in the queue, stepped around without anybody deciding anything.

That is the case owner item 74 is written for, and the register's own §12
claimed the slice implemented it: *"If A did not commit, the doctor explicitly
chooses which active attendance continues; the abandoned path is preserved in
audit."* Two real visits and one attempt is not a question the software may
answer, and cancelling one of them afterwards does not answer it either.

It refuses now, before any clinical or financial write, with the same
`ATTEMPT_NEEDS_RECONCILIATION` the replay path raises — so the exit is the one
that already exists, and the doctor says which attendance continues. The four
compatible shapes (`A/A`, `none/B`, `A/none`, `none/none`) are each pinned
separately, because a refusal that also refuses the ordinary retry would be a
worse fault than the one it fixes.

### Idempotency that was not idempotency

Four commands decided "have I already done this?" by reading the booking's
CURRENT state. That reads like a retry guard and is a guess that expires,
because the whole reason a retry arrives late is that the state moved. Both
endings were reproduced:

> Move to 11:00. Reply lost. Somebody moves it to 12:00. The retry arrives,
> finds the booking is not at 11:00, decides it is therefore not a duplicate,
> and moves it **back** to 11:00.

> Check in; JMC-0001 issued. Reply lost. The appointment is rescheduled and
> that arrival cancelled. The retry arrives, finds the booking `booked`, mints
> **JMC-0002**, and drags the booking back into `checked_in`.

The programme's rule is not ambiguous and was not followed: *"Every
client-retryable consequential command accepts a scoped idempotency key and the
server stores enough request identity and result identity to return the
original outcome safely."* Stored. Not derived.

`jmc.appointment_command_receipts` is one receipt per command, written in the
same transaction as its effect and serialized on one advisory lock backed by a
unique index. Request identity is a fingerprint over everything material —
including `overrideReason`, which Slice 2 left out, so two requests differing
only in why an override was allowed were one request. Result identity is the
stored outcome: the booking id, the resolved doctor, the queue token, the
numbers a screen already printed.

It is read before anything **mutable** happens, which is not the same as "before
anything else happens" — the sentence this register carried after the first
correction, and which the third review was right to call out. Two things run in
front of it: the role check, because a receipt must never be a way past
authorization, and canonicalising what the caller sent, because a naive local
time in a fixed zone is the same instant whenever it is asked. Everything that
asks about the clinic **now** runs behind it: the ninety-day horizon, which
doctor a nurse means when there is only one, what today's date is. A retry
arrives precisely when "now" has moved, and the first correction had a
reschedule that succeeded yesterday answered with "that day is in the past" and
a nurse's exact retry answered with "say which doctor this appointment is with"
after a locum joined — in both cases about work that had already committed.

**All ten mutating appointment commands take one**, not the four the review
named, and the key is **required**. The consultation key had to stay optional
because a build on the clinic's tablets sends none; these have no deployed
caller at all, so a compatibility window would be a hole beside the guarantee
it defeats, which is what the review said.

**And a replay carries the present as well as the past.** The check-in above
replays JMC-0001 *and* reports `superseded: true`,
`currentArrivalStatus: "cancelled"`, `currentBookingStatus: "booked"`. Handing
back only the token would be accurate about the past and useless about the
room.

### A reschedule that validated and then discarded

Three faults in one command.

**"Same time" was treated as a duplicate**, so a request that moved an
appointment into a forty-five-minute type at its existing time silently kept
the old type and the old duration. Time is not the whole of what a reschedule
changes.

**The override was checked and thrown away.** `clearSlot` ran, its answer was
dropped, and the booking kept whatever flags the ORIGINAL booking had decided —
so one moved out of a conflict into a clear slot went on claiming it was
overbooked, with the old reason attached, and one moved INTO a conflict did
not.

**The history recorded neither.** `appointment_events` held the time before and
after and nothing else. It now carries the type and duration before and after,
the override flags, the override reason, the actor and the time.

### A policy read backwards

Owner item 71 says a nurse may book *within* published availability. Slice 2
read an exception into it — that a day with nothing published constrains
nobody — and justified it in a long comment. The review reproduced the
consequence: a nurse booking a patient for three in the morning.

There is no exception. A day with no open window is a day a nurse cannot book,
and the clinic is not locked out, because a doctor or an admin books it with
the recorded override. **That the doctor keeps an override is an implementation
default**, written down as one this time: item 71 constrains the nurse and is
silent about the doctor, who owns the hours.

### A cross-patient relationship the schema allowed

`consultation_attempt_resolutions` could record that one patient's queue row
was the same attendance as another patient's consultation. The command checked
the encounter and neither visit. It checks all three now, and
`20260921000000` adds composite foreign keys on `(visit, patient)` and
`(encounter, patient)` so the schema refuses it whatever the command does —
which is the reviewer's instruction, and the right shape: the constraint is the
guarantee and cannot be forgotten, the command is the sentence a doctor reads.

### An invariant documented and not enforced, and a citation that was false

`appointment_bookings` required a reason for `overbooked` and required nothing
for `outside_availability`, although the column comment beside it described the
reason as covering both. The replacement is symmetric in both directions:
either flag requires a sentence, and neither flag requires the ABSENCE of one —
so a reschedule into a clear slot cannot clear the flags and leave the old
reason standing.

And the 480-minute ceiling on an appointment type was written under a heading
citing owner item 65. Item 65 decided the fifteen-minute default and the
per-type override and said nothing whatever about a maximum. The bound stays
because it is useful; the attribution is gone from the schema, the code and the
contract.

### One more, found while fixing the rest

The receipt's stored outcome came back empty on every replay. The driver
serializes a parameter bound to a json column by JSON-stringifying it, so an
already-stringified value went in stringified twice and returned as a JSON
string scalar. A check-in retry was answered without the token it asked for —
the exact failure a replay exists to prevent, in the mechanism built to prevent
it. `::text::jsonb` pins the parameter as text and lets Postgres parse it.

### Every regression was proved non-vacuous

The reviewer asked for it and it is worth the half hour. For each correction
the production change was reverted, the test that names it was run and observed
to FAIL, and the change was restored and the test observed to pass. The six:
the A/B guard, the receipt, the reschedule's override, the availability rule,
the cross-patient check, and the override constraint. A test that passes
against the broken code is not a regression, and three of the tests in this
slice's first pass were exactly that.

### What ran after the correction

| | |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | 38 unit tests, all passing |
| `deno check --node-modules-dir=none supabase/functions/**/*.ts` | clean, all 13 Edge Functions |
| static export against `http://127.0.0.1:54321/functions/v1` | succeeds |
| `npm run test:db` | **666 tests over 27 files, all passing** (632 when the slice was returned) |
| `npm run staging:rehearse` | **21 named checks**, all passing, over a clinic with five legacy arrivals; every migration applied twice |
| `npm run test:browser` | 64 journeys — unchanged, which is the point: this slice still adds no screen |
| `git diff --check` | clean |
| non-vacuity | **twelve** corrections reverted one at a time — six from the acceptance review and six from the independent review of the correction — each named regression observed to FAIL, then restored and observed to pass |

The database was destroyed and rebuilt from the migrations before the run.

**None of this makes the slice accepted.** The first handoff reported a green
gate too. It goes back to the reviewer.

### The second independent review, and what it caught

An agent that did not implement the correction reviewed it before this handoff.
It found no path to a duplicate charge or an edited signed record, and then
found eighteen things above the nit bar. All of the ones that change behaviour
are fixed; the rest are documentation the code did not support.

**Two were the correction contradicting itself.**

`set_queue_priority` was the one command of the ten with no standing test, so a
stale retry replied *"Moved up the queue"* about a patient somebody had since
put back — and `urgent` is the field that decides who is called next. Worse,
**the test written for that exact scenario asserted the database and not the
answer**, so it would have passed against a version with no standing mechanism
at all. That is the class of test this correction exists to stop shipping.

And `same_attendance` accepted no `subjectVisitId` while a visit was in the
queue: it closed nothing, spent the reference's one resolution, and then told
the doctor on every later press that the visit had been closed — under a code
that does not rotate. No way to sign it, no way to resolve again. Owner item 72
defines Same attendance as creating the link AND closing the leftover visit; it
now refuses with `SUBJECT_VISIT_REQUIRED` naming the waiting tokens, and the
refusal after a determination that named no visit says so truthfully and lets
the doctor sign.

**`superseded` was reachable from one command of ten.** `bookingStanding`
returned it only when the booking row was missing, and nothing ever deletes
one, so the branch was dead while the contract promised it generally. Each
command answers its own question now — a move stands while the booking is at
the time it moved to, a cancellation while it is cancelled, a priority while
the visit still carries it — and the contract has the table.

**A clinic with a morning and an afternoon session refused its own hours.**
`inside` asked whether ONE window contained the whole appointment, so 12:55
with 09:00–13:00 and 13:00–17:00 both published was outside published hours
although every minute of it is published. It is range coverage now: subtract
the union of the open windows from the appointment and see whether anything is
left over.

**The correction tightened a command and left its read behind.** The
reconciliation read treated "that visit was not found, or is not this
patient's" as "that visit is not active", so it offered `abandoned_attempt` as
available while the newly-tightened command refused it — breaking the one
promise that read's own comment makes. And it returned another patient's
resolution, free-text reason included, because the patient filter the
consultation two statements above it carries was not on that query.

**Three claims the code did not support.** `clinic-policy.ts` still cited owner
item 65 for the 480-minute ceiling, in the one file whose header says a number
without a citation is an invented clinic rule — while §12.1 claimed the
attribution was gone from the code. The contract listed a refusal code,
`ARRIVAL_MISSING`, that exists nowhere. And it named five fields of a booking's
material identity when there are seven, omitting exactly the two the correction
had added.

**And the migration did to the next operator what it complained of.**
`20260920000000` refuses duplicate queue tokens with a sentence naming them,
on the reasoning that a SQLSTATE does not say which rows to look at; the
correction added three foreign keys and a stricter check with no such
pre-flight, and the rows they forbid are exactly the rows the code being
corrected could create. Both now raise naming the bookings or the
reconciliations, and the receipts table has its own immutability message
instead of borrowing the one about prescription lines.

The rest: the atomicity test drove its failure from outside the transaction and
proved nothing about atomicity; *"on every command"* was five commands of ten;
the outside-hours arm of `OVERRIDE_REASON_REQUIRED` had no test; the
constraint-drop loop matched broadly enough to swallow a future named
constraint about the same columns; `publish_availability` put a freshly
computed default into its own fingerprint, so a retry crossing midnight was
refused as a reused reference; and `appointment_bookings` carried two dead
idempotency columns the schema document still described as the live mechanism —
they are written now, as the booking's own copy of the reference beside the
authoritative receipt.

Two were recorded rather than changed, and are in the contract's §10: a
reschedule cannot clear an appointment type, and a slot held by a patient who
has already checked in does not conflict.

## 12.2 Returned again, and what the second correction changed

Slice 2 was **still not accepted**. The review reproduced four findings and
five failures against the guarded loopback database, all of them past a suite
of 120 Slice 2 tests that were green. Slice 2 remains **under review**; it is
not called accepted here.

The thread running through three of the four is the same one §12.1 pulled and
did not pull all the way: *a record and the sentence read off it must be the
same thing.* A receipt that cannot be reached is a record nobody can read; a
`superseded` that compares one field of an effect is a sentence about a record
it did not look at; a closure recorded as having happened when it did not is
both at once.

### The receipt was behind the things that expire

`book_appointment`, `reschedule_appointment` and `publish_availability` asked
their mutable questions in front of `once()`.

> A reschedule succeeds. The reply is lost. The tablet retries the next
> morning, and is told **"that day is in the past"** — about a move that
> committed yesterday.

> A nurse books with one doctor in the clinic and names nobody. A locum joins.
> The exact retry is refused with **"say which doctor this appointment is
> with"**, about a booking that already exists.

Both were reproduced. `requireInsideHorizon`, `resolveDoctor` and the
`effectiveFrom` default now run inside `work()`, in the receipt's transaction.
The fingerprint is built from what the **caller sent** — `doctorId` is the
doctor asked for, which may be nothing — and the resolved doctor comes back as
result identity, so a replay names the doctor the booking was actually made
with rather than re-deriving one.

Only two things run before the receipt now, and the rule is written above
`once()` so the next command added does not have to rediscover it: the role
check, because a receipt must never be a way past authorization, and
canonicalising the caller's own values, because a naive local time in a fixed
zone is the same instant whenever it is asked.

§12.1's sentence *"read before anything else happens"* was wrong and is
corrected in place. It is read before anything **mutable** happens.

### `superseded` described one field of the effect

`moveStillStands` compared the scheduled instant alone.

> Reschedule to 11:00 with a thirty-minute type. Reschedule again to **the same
> 11:00** with a forty-five-minute type. The first retry replays thirty
> minutes, reports `currentDurationMinutes: 45`, and says `superseded: false`.

`appointmentTypeStanding` was worse: it returned `superseded: false` whenever
the row existed, so a stale duration update replayed against a changed type and
claimed to still stand.

One comparison now, `bookingEffectStands`, covering status, instant, type,
duration and both override flags, shared by booking and reschedule. The type is
compared **by id**, because two types may run the same number of minutes and
moving between them is a change no number would show. An appointment type is
superseded the moment any field **the request set** stops saying what it set —
and not because somebody renamed a type when the request only sent a duration,
which is why each one stores what it applied. (This correction gave creation a
separate rule, "superseded by nothing short of the row going away"; the
independent review below showed that was both the wrong question and a constant
`false`, and the two share one rule now.)
`set_queue_priority` compares the reason as well as the flag: two doctors
prioritising one patient for different reasons are two decisions.

A field absent from an older receipt is treated as agreeing, so a receipt
written before this comparison existed does not read as superseded for
something it never carried.

### A closure that never happened, recorded and then reported

Owner item 72: Same attendance "creates an append-only audited reconciliation
link and closes the leftover visit". Naming a visit that was **already
cancelled or finished** was accepted, recorded with `subject_visit_closed =
false`, and then described on the doctor's next press as a visit they had
closed.

False in the clinical record, false on the screen, and expensive: the
reference's single resolution was spent getting there, so the doctor could
neither sign the visit in front of them nor resolve again.

`SUBJECT_VISIT_NOT_OPEN` refuses it before anything is written, naming the
token and what is actually wrong with it, so the reference is unspent and the
doctor can say what they meant.
`20260922000000_same_attendance_closes_the_visit.sql` carries the same rule as
a check constraint — forward-only, nothing already applied edited, offending
rows named rather than migrated past.

`refuseSettledAttempt` now reads `subject_visit_closed` and not only the id.
Recorded honestly: with the refusal and the constraint both in place that
conjunct cannot currently be false, so it has **no regression of its own**. The
reachable falsehood is held by the two that do.

### The read offered what the command refused

Again, and for the same reason as last time: the command grew a refusal and the
read was updated in one of the three places it applied. A cross-patient
`openedVisitId` made `abandoned_attempt` unavailable while Same attendance and
New attendance were still offered as available against a stranger's visit.

The nested conditional is gone. The read walks a **table of the command's
refusals in the command's own order**, once per determination, and the first
that holds is the answer. Order matters inside it — a committed attempt with an
unknown opened visit is refused as already committed, not as an unknown visit —
and the table makes that visible instead of implicit.

Eight rows, covering the refusals the read is in a position to know about.
**Not all of them**, and the first draft of this section said "each one exactly
one refusal", which the independent review correctly called stronger than the
code. Three of the command's refusals turn on `subjectVisitId`, which the read
is never given — `workspace/index.ts` passes the key, the patient and the
opened visit. Those three are disclosed in the contract's §3 as the screen's
own responsibility, each one refusing before any write and leaving the
reference unspent, and each one now has a test where it actually lives.

### Every regression was proved non-vacuous

Each production correction was reverted, the named tests observed failing, and
the correction restored:

| Reverted | Failed | Passed again |
|---|---|---|
| horizon and roster back in front of `once()`; resolved doctor back in the material | 4 of 6 | 6 of 6 |
| `moveStillStands` back to the instant alone; `appointmentTypeUpdated` back to `false`; priority reason dropped | 4 of 5 | 5 of 5 |
| `bookingStillStands` back to "still open" | 1 of 1 | 1 of 1 |
| `SUBJECT_VISIT_NOT_OPEN` removed | 2 of 6 | 6 of 6 |
| `resolutions_same_attendance_closes_its_visit` dropped on staging | 1 of 1 | 1 of 1 |
| gate 7 back to `abandoned_attempt` alone | 3 of 6 | 6 of 6 |

Two of the six in the first row are guards rather than regressions and pass in
both states by design: `APPOINTMENT_REFERENCE_REUSED` is still returned for a
materially different request, and authorization is still not bypassed by a
receipt. They are there because the correction moved work around the role check
and the fingerprint comparison, and an over-correction would be silent.

### What could not be reproduced in a suite, and is therefore said plainly

The clinic day comes from `now()` in Postgres, so no test here can watch a
receipt survive midnight. What the two horizon tests hold is the **order**: a
past day sent under a reference that has already been spent is answered
"that reference is spent", not "that day is in the past". Under the revert the
horizon answers first and both fail. The identical-request-across-midnight case
is the same production line, exercised by the two roster tests, which the suite
can move.

### What ran after the second correction

120 Slice 2 tests became 174: `slice2-appointments` 79 → 93, and
`slice2-reconciliation` 41 → 81. The larger part of the second is a 30-cell
read/write matrix walked one clinic per cell; the rest is what the independent
review below sent back.

### The independent review of this correction, and what it caught

Read-only, by an agent that did not write any of it. Two of its findings were
reproduced against the guarded database before anything was changed; one was
reproduced by the review itself; the rest were read out of the source.

**It also caused the 41 failures in the first full run of the database suite,
and said so first.** It ran `slice2-appointments.test.mjs` twice against the
same scratch database while the gate was running. `emptyClinic` truncates every
table in `jmc` and then restores the vocabulary it read first, so two suites at
once leave a release row with no phrases under it — which `clinic.mjs:60-65`
predicted in a comment written before either of us. "No clinical vocabulary
release is installed" and "Prescription was not found" are both that. The five
affected files were the last five alphabetically; every Slice 2 file had
already passed. The gate was rerun on a rebuilt database with nothing else
touching it.

#### A booking untouched by anybody, replaying as superseded

Reproduced. `bookingEffectStands` compared the recorded instant against
`String(row.scheduled_at)`, and the driver turns a timestamptz into a
JavaScript `Date`, whose `toString()` has no milliseconds. A booking made for
10:30:00.**500** compared as 10:30:00.000, so the exact retry came back
`superseded: true` — the tablet told that its committed booking no longer
stood, which is the failure this whole mechanism exists to prevent, arriving
through the mechanism. Any client that does arithmetic and then `toISOString()`
sends a fraction.

Both sides are now `to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, the same shape
`clinicMoment` records, so the comparison is between two strings Postgres
wrote.

#### A reference settled for one patient, offered as available for another

Reproduced. The read filtered its resolution lookup by patient, which was the
right fix for a different fault — the second review found it handing back a
stranger's doctor's free-text reason — and the wrong place for it. The command
looks the key up and nothing else, because the key is unique across the clinic.
So a reference resolved for somebody else made the "already resolved" gate
miss, all three options came back available, and the command refused every one
of them with `RECONCILIATION_ALREADY_RESOLVED`.

The filter is on what is **shown** now. The gate asks whether the reference is
settled; `resolved` and the detail ask whose it is.

#### A creation that stood merely because the row existed

`appointmentTypeCreated` returned a literal `superseded: false`, and nothing
deletes an appointment type — so it was the constant `false`, which is exactly
the shape the third review rejected as HIGH for the update half. The first
correction rewrote one half and left the other.

Worse than a flag: the stored **message** is "Antenatal added, 30 minutes",
which asserts a name and a duration. A type since renamed and lengthened makes
that sentence untrue and a replay hands it straight back. Creation and update
ask one question now — does every field this request set still say what it set
— and the creation stores what it applied so the question can be asked.

#### A read that could make a writer lie

`readReconciliation` took `pg_try_advisory_lock` and released it in the same
statement, carefully, because a leaked session-scoped lock would hold the
reference hostage. It was careful about releasing and not about holding: for
the microseconds the read owned it, a concurrent `resolve_consultation_attempt`
lost its `pg_try_advisory_xact_lock` and refused the doctor with "this
consultation is being signed right now" — a false sentence about the clinic,
produced by a read.

It observes `pg_locks` now and acquires nothing.

#### A database fault reported as a malformed date

`clinicMoment` is the one database round-trip still in front of the receipt,
and a blanket `catch` reported every failure — a connection reset, a statement
timeout, a deadlock — as "scheduledAt is not a time". On a retry after a
transient fault that tells a tablet its date is malformed while its earlier
request has already committed. The shape is judged in JavaScript now, before
anybody is asked, and the catch is narrowed to 22007 and 22008.

#### And one line of belt and braces

`isReceiptClash` matched only `appointment_command_receipts_key`. The booking
carries its own copy of the reference under
`appointment_bookings_idempotency_key`, and a 23505 from that index means
exactly what the first one means. Unreachable behind the advisory lock; it
would have been a stack trace rather than a replay.

### What the review found and this correction did NOT change

> **Superseded by owner policy item 75, 16 September 2026.** What follows was
> right about the problem and wrong to leave it. The decision below now allows
> the retrospective link, and `subject_visit_disposition` records which of the
> two happened — see [§12.3](#123-returned-a-third-time-and-the-one-that-could-take-money-twice).

**Same attendance now has a shape no doctor can record truthfully.** A leftover
visit V1 and a genuine second arrival V2 are both open; a nurse tidies the
queue and marks V1 done; the doctor then wants to record that the signed
consultation was the same attendance as V1. Naming V1 is refused
(`SUBJECT_VISIT_NOT_OPEN`), naming nothing is refused because V2 is open
(`SUBJECT_VISIT_REQUIRED`), and naming V2 would close a real second attendance.
The reference stays unspent and nothing false is recorded, which is better than
what it replaced — but item 72's link cannot be recorded at all in that shape,
and the constraint means a later release cannot record it retrospectively
either without a new column. **An owner decision, not a defect**, and it is
written here so it is decided rather than discovered.

### Every regression was proved non-vacuous, and two were not

| Reverted | Failed | Passed again |
|---|---|---|
| the instant compared through the driver's `Date` again | 1 of 1 | 1 of 1 |
| a creation standing while the row exists | 1 of 1 | 1 of 1 |
| the already-resolved gate filtered by patient | 1 of 1 | 1 of 1 |

The other two changes have tests that are **guards**, and both say so in their
own names and comments rather than being counted as regressions:

- *`clinicMoment`'s narrowed catch.* Inducing a connection reset or a statement
  timeout inside one statement is not something this suite can arrange. The
  test holds the observable half — every shape a tablet sends is accepted, and
  every shape that is not a time is refused in the caller's words.
- *The read taking no lock.* A race of microseconds cannot be arranged
  deterministically, and a test that only sometimes fails is worse than none.
  The test holds that no lock is left in either namespace after any number of
  reads and that the reference is free for the work that follows; the
  correction itself is proved by construction, the read no longer executing an
  acquire at all.

### What the review checked and found nothing in

Fingerprints derived from mutable state, across all ten commands' material and
everything executed before `once()`. Receipts bypassing authorization —
`requireRole` runs first in all ten, and the actor is inside the fingerprint.
Deadlock cycles between the four advisory namespaces. The Slice 1 guarantees:
one encounter per key, one fee line per encounter, `visitToSignAgainst`'s five
refusals, the append-only triggers, and RLS plus the revokes on all six new
tables. And the `SUBJECT_VISIT_NOT_OPEN` refusal has no TOCTOU window —
`visitOfThisPatient` reads `for update`, so a concurrent status change either
commits before the read or waits behind it.

### What ran after this correction

| | |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | 38 unit tests, all passing |
| `deno check --node-modules-dir=none` over every Edge Function file | clean |
| static export against `http://127.0.0.1:54321/functions/v1` | succeeds; the bundle names 127.0.0.1, not the clinic |
| `npm run test:db` | **720 tests over 27 files, all passing** (666 after the first correction, 632 when the slice was first returned) |
| `npm run staging:rehearse` | **22 named checks**, all passing, twice, over a clinic with five legacy arrivals |
| `npm run test:browser` | **64 journeys over 22 files, all passing** — unchanged in count, which is the point: this slice still adds no screen |
| `git diff --check` | clean |
| non-vacuity | **fifteen** corrections reverted one at a time — twelve from the earlier rounds and three from this one — each named regression observed to FAIL, then restored and observed to pass. Four more changes have tests labelled as guards rather than regressions, for the reasons given above. |

The database was destroyed and rebuilt from the migrations before the run, with
nothing else touching it. The first full run was invalidated by the independent
review running a suite against the same scratch database at the same time; that
run is described above rather than reported as a result.

**None of this makes the slice accepted.** Two previous handoffs reported a
green gate. It goes back to the reviewer.

## 12.3 Returned a third time, and the one that could take money twice

Slice 2 was **still not accepted**. Four findings. One of them reopened the
duplicate-consultation and duplicate-fee path that owner items 72 to 74 exist
to close, and the previous handoff had reported 720 database tests and 64
browser journeys all green — because none of them contained the case.

All four were reproduced against the guarded loopback database before anything
was edited. Slice 2 remains **under review**; it is not called accepted here.

### A reconciled visit could be put back in the queue

The critical one, and the shortest to state:

> Sign a consultation. A leftover visit appears. Resolve it as the same
> attendance — the visit goes `done` and nothing is charged again. A nurse
> tidying the queue sets it back to `waiting`. Sign it under a fresh reference.

**Two encounters, two fee lines, ₹600 for one attendance.** No idempotency
guard applies, because the second signature carries a new key; and none should,
because a genuinely returning patient signs under a new key too. The thing that
distinguishes them is the determination a doctor already made about that visit,
and nothing was reading it.

`set_appointment_status` moves any visit to any status, which is right for a
queue and wrong for this one row. So the closure is enforced where the queue is:
`appointments_reconciled_visits_stay_closed`, a `before update` trigger, refuses
`waiting` and `in_consult` for any visit a `same_attendance` determination
names. The command refuses it first with a sentence and
`VISIT_RECONCILED_AND_CLOSED`, and `sign_consultation` refuses one by name
rather than falling through to "that visit is already finished", which is true
and useless.

A `new_attendance` subject is deliberately untouched: owner item 74 keeps that
visit available to be consulted, and a guard test holds that it still can be.
The patient who genuinely comes back is untouched too — arrive them afresh,
sign, two encounters and two fees, which is correct.

### The closure constraint checked a boolean, not a closure

`20260922000000` asked that `subject_visit_closed` was true. It never looked at
the appointment. The review inserted a row claiming a closure while the visit it
named sat `waiting`, and the schema took it — so the previous handoff's claim
that no other database route could record a false closure was false, and is
corrected in place.

A boolean the writer sets is not evidence. What makes a closure true is the
visit being closed and an event saying who closed it and when, which is three
rows in two other tables — more than a check constraint can see.
`resolutions_subject_is_what_it_claims` is a **deferred** constraint trigger, so
at COMMIT all three exist and can be compared with one another. The closure
event carries `resolution_id` now, so the schema can tell a closure THIS
determination performed from one an earlier reconciliation performed about the
same visit.

### And the pre-flight offered no way out

`20260922000000` named the offending rows and told an operator to "close or
cancel the visits they name, and record the correction". The review called it
unusable and was right: the resolution row is immutable, so closing the visit
afterwards changes nothing about it, and the unique key on `idempotency_key`
forbids a replacement determination. It named a problem and no way out of it.

The new migration has three pre-flights and each prints the statement that makes
the record true again. None of them touches a resolution — a determination is a
doctor's and is not edited. What they correct is the queue, which is what was
wrong.

### A new attendance accepted a visit nobody could consult

Owner item 74 is the doctor saying which attendance continues. The command
asked `same_attendance` to name its visit and never asked `new_attendance`, so
a determination could be recorded against a patient with visits standing in the
queue and name none of them — the reference spent, and nothing said about
which. It also accepted a cancelled or finished visit as the attendance that
continues, which is the one thing that determination says is not the case.

Both are refused now, and by the deferred trigger as well as the command.

### An in-flight determination was reported as a signing

A resolution holds **both** advisory namespaces: the resolution lock to
serialize against other determinations, and the attempt lock to fail closed
against a signing. The read watched the attempt lock alone and said "a
consultation is being signed under this reference right now" — with nothing
being signed at all.

The read now distinguishes them and says which, and the payload carries
`inFlight: "signing" | "resolution"`. They are different situations: a signing
is owner item 73's fail-closed state and the command refuses against it, while
a determination is another doctor deciding, which the command waits for. The
resolution case therefore carries no refusal code, because naming one would
promise a refusal that may not be the one that arrives.

`pg_locks` is also filtered to the current database now. It is cluster-wide,
and the scratch database sits beside others on the same server.

### The owner decision this round carried

Item 75 of `OWNER_POLICY_REGISTER.md`, approved with the finding:

> A doctor may retrospectively link `same_attendance` to a same-patient visit
> already marked done. Record whether the resolution closed it now or found it
> already done; never claim the resolution performed a closure it did not
> perform. A cancelled visit remains ineligible until separately corrected.
> Other open visits remain untouched.

This answers the shape §12.2 recorded as an owner decision rather than a defect
— the one where a nurse closes the leftover visit before the doctor reconciles,
and item 72's link could then not be recorded truthfully at all.

`subject_visit_disposition` carries it: `closed_now`, `already_done`,
`not_applicable`. A field of its own rather than a second meaning for
`subject_visit_closed`, because a boolean cannot hold three answers and the
attempt to make it do so is exactly what produced the false sentence in the
first place. The boolean is kept in step by a check and means what it always
meant.

One consequence worth recording: `20260922000000`'s pre-flight encodes the
policy as it stood before item 75, so it reads an `already_done` row as hollow
and a database that has adopted the decision does not re-run it. Migrations are
applied once, so this costs nothing in the clinic; the migration rehearsal
applies everything twice, which is why its fixture uses a real `closed_now`
closure.

### What the Slice 2 suites hold now

174 Slice 2 tests became **204**: `slice2-appointments` 93, unchanged, because
this round was about the reconciliation; `slice2-reconciliation` 81 → **111**.

### Every regression was proved non-vacuous

| Reverted | Failed | Passed again |
|---|---|---|
| the queue's refusal to reopen a reconciled visit | 2 of 2 | 2 of 2 |
| `sign_consultation`'s refusal by name | 1 of 1 | 1 of 1 |
| `appointments_reconciled_visits_stay_closed` dropped on staging | 1 of 1 | 1 of 1 |
| a new attendance needing a usable named visit | 7 of 9 | 9 of 9 |
| the read watching the attempt lock alone | 1 of 4 | 4 of 4 |
| `resolutions_subject_is_what_it_claims` dropped on staging | 3 of 6 | 6 of 6 |

The rows that pass in both directions are guards against over-correction: a
reconciled visit may still be closed or cancelled further, a `new_attendance`
subject may still be consulted, and a patient genuinely returning is still
signed and charged in the ordinary way.

### The independent review of this correction, and what it caught

Read-only, by an agent that did not write any of it. Five findings, plus one the
lead found while checking the trigger's coverage. All six were fixed before the
migration left the scratch database, so `20260923000000` carries them rather
than a `20260924000000` correcting a file written the same afternoon.

**The one the lead found: a reconciled visit could still be cancelled.** The
trigger blocked `waiting` and `in_consult` and let `done → cancelled` through.
A determination saying the patient was seen at that visit, beside a queue row
saying the visit never happened. It cannot produce a second fee — signing needs
an open visit — which is precisely why it would have gone unnoticed, and it is
the same class of fault as the finding this round was correcting: a rule written
where it can be walked around. `done` is now the only status a reconciled visit
may still take.

Worth recording plainly: **a test written this round asserted the cancellation
was allowed**, as a guard against over-correction. It was a guard around a
defect. It now asserts the rule, and the revert makes it fail.

**The deferred trigger counted events without reading them.** It asked for a row
with the right `event`, `arrival_id` and `resolution_id` and looked no further —
so an event claiming the visit went to `cancelled`, or came from a status it was
never in, satisfied a constraint whose entire purpose is that a closure is an
event rather than a boolean. Neither column carries a check anywhere in the
schema, so this was the only place that could ask, and it did not.

**The migration's own remediation SQL wrote a false transition.** The `UPDATE`
matched `waiting` or `in_consult`; the paired `INSERT` hardcoded
`from_status = 'waiting'`. An operator running the statement this migration
offers as the way to make a record true again would have written a false
transition into the audit trail it exists to make trustworthy. One statement
now, with `RETURNING` giving each visit's status as it was before.

**The read did not tell a `new_attendance` to name its visit.** This round gave
that determination a `SUBJECT_VISIT_REQUIRED` refusal and left its `detail`
branching on whether anything had been signed, so the option came back available
saying nothing about naming anything. A screen built to the contract's own
instruction — render what is available, the detail says what is needed — would
have submitted without a subject and met the refusal. The promise the option
list exists to keep, broken for the case this round had just created. The
contract asserted it had been done for both; it had been done for one.

**And one message said two things.** `RESOLUTION_MESSAGES` took a boolean, so
`already_done` — the whole of owner item 75 — read exactly like a determination
that named no visit at all.

Each of the four with a reachable test was reverted and the named regression
observed to fail:

| Reverted | Failed | Passed again |
|---|---|---|
| a reconciled visit may be cancelled again | 1 of 1 | 1 of 1 |
| the closure event counted but not read | 1 of 2 | 2 of 2 |
| the `new_attendance` detail saying nothing about a visit | 1 of 1 | 1 of 1 |
| one sentence for two dispositions | 1 of 1 | 1 of 1 |

### What ran after this correction

| | |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | 38 unit tests, all passing |
| `deno check --node-modules-dir=none` over every Edge Function file | clean |
| static export against `http://127.0.0.1:54321/functions/v1` | succeeds; the bundle names 127.0.0.1, not the clinic |
| `npm run test:db` | **757 tests over 27 files, all passing** (755, 750, 746, 720, 666 and 632 after the earlier rounds) |
| `npm run staging:rehearse` | **24 named checks**, all passing, twice, over a clinic with five legacy arrivals |
| `npm run test:browser` | **64 journeys over 22 files, all passing** — unchanged in count, which is the point: this slice still adds no screen |
| `git diff --check` | clean |
| non-vacuity | **twenty-five** corrections reverted one at a time — fifteen from the earlier rounds, six from this one and four from its independent review — each named regression observed to FAIL, then restored and observed to pass |

The database was destroyed and rebuilt from the migrations before the run, with
nothing else touching it.

**None of this makes the slice accepted.** Three previous handoffs reported a
green gate, and the fourth review found a path to two consultations and two
fees that every one of them had been green over. It goes back to the reviewer.

## 12.4 Returned a fourth time: a closure that is performed, not claimed

Four blocking defects and one integrity race. All five reproduced against the
guarded loopback database before anything was edited. Slice 2 remains **under
review**.

### The pattern worth naming, because it has now happened four times

`20260920000000` trusted a boolean. `20260922000000` checked that boolean.
`20260923000000`'s first draft checked that a closure EVENT existed, and then
that the event's `to_status` was honest. Every round asked a better question of
the same untrusted writer, and every round the next review answered it by
writing the row the check was looking for.

This one stops asking. `jmc.close_visit_for_reconciliation()` takes the visit's
row lock, reads its status, performs the transition and emits the event, in one
operation — and `appointment_events_closure_is_genuine` makes it the only route
into that event at all. The event's existence is the transition having happened.
There is no claim left to check.

**The suite was complicit.** The fourth review's reproduction of the forgery was
this repository's own test: a visit already `done` for unrelated reasons, a
`closed_now` determination and a fabricated `waiting -> done` event inserted
beside it, which the test called "the true one" and asserted was accepted. That
is the second time in two rounds a test of ours has asserted a hole was correct
behaviour. Both are now written the other way round.

### The migration could not upgrade a single real row

Both tables carry `before update` triggers that raise unconditionally, so the
backfill would have failed on any clinic holding a reconciliation written
between `20260922000000` and this file. The rehearsal was green because it had
none.

It now seeds exactly those rows, applies the two migrations in sequence, and
asserts the upgrade. The backfill disables the two triggers for the width of its
own statements — inside the migration's transaction, as the table owner,
deriving every value from what is already stored. Reverting that disable makes
the rehearsal fail with *"A signed prescription line cannot be changed"*, which
is the review's finding, now caught here.

### The recovery SQL could not be followed

It read the prior status from `UPDATE ... RETURNING`, which returns the row as
it now is, so every event it wrote would have said `done -> done` and been
rejected by the rules the recovery exists to satisfy. This is the second
unusable recovery path in two rounds. It now prints a call to the closing
function, which reads the status itself.

### The lock read combined different people's work

A resolution holds both namespaces on one connection; a signing holds the
attempt lock alone. The query asked whether each lock was held anywhere, so a
doctor signing on one connection while another doctor resolved on a second was
reported as *"nothing is being signed"* — the one sentence owner item 73 must
never produce. Grouped by `pid` now, and a backend holding the attempt lock
without the resolution lock is a signing, which wins.

### And `already_done` could paper over a duplicate

A signing under a fresh reference wins the visit lock, writes its own encounter
and its own ₹300, and leaves the visit `done`. The reconciliation wakes, sees
`done`, and records that visit as the same attendance as the earlier
consultation. It did not cause the duplicate — it wrote a false determination
over it and hid the exact condition reconciliation exists to expose.

`SUBJECT_VISIT_ALREADY_CONSULTED` refuses it and says what is actually true:
this patient has been charged twice and the duplicate needs correcting on its
own. The deferred trigger refuses it by any other route. The consultation the
determination is about is excluded, because a doctor who signed with the visit
on screen and lost the reply is who the control is for.

### Every regression was proved non-vacuous

| Reverted | Failed | Passed again |
|---|---|---|
| the scoped trigger disable in the backfill | rehearsal | 25 of 25 |
| `appointment_events_closure_is_genuine` | 1 of 1 | 1 of 1 |
| the `already_done` encounter check, in the database | 1 of 1 | 1 of 1 |
| the `already_done` encounter check, in the command | 1 of 1 | 1 of 1 |
| the lock read counted across the database | 1 of 1 | 1 of 1 |

## 12.5 Returned a fifth time: a convention is not a capability

Three integrity blockers, all reproduced before anything was edited.

### The guard was a GUC, and anyone can set a GUC

§12.4 said the closure was "performed, not claimed", and it was not. The
mechanism was a transaction-local setting that the closing function set and the
event trigger checked. The fifth review called `set_config()` itself — four
lines, no privileges — and the forgery from the round before worked again.

That is the fifth time this slice has answered "how do we know the closure
happened" with a better question put to the same untrusted writer. So the
question is gone: **inserting the closure event is what moves the visit.** The
trigger locks the determination and the visit, refuses a visit that is not in
the queue, performs the update, and fills in `from_status` from the row it
locked. An event beside an untouched visit cannot exist, because writing one is
what touches it.

### The recovery the migration printed did not exist yet

The pre-flight told an operator to call `jmc.close_visit_for_reconciliation()`.
That function is created two hundred lines below the `raise` that prints its
name, so at the moment the message appears the remedy is unavailable. This is
the third unusable recovery path in three rounds, and the reason the rehearsal
kept missing it is that its only legacy row was already valid — it proved the
backfill and never the refusal.

The message now prints a single statement using nothing but the schema in force
before this migration. The rehearsal seeds a hollow row, expects the migration
to REFUSE, runs the printed statement **verbatim**, and applies the migration
again expecting success. The printed text and the tested text are the same text.

### The closure could be signed in somebody else's name

`close_visit_for_reconciliation()` took the actor, the reason and the detail
from its caller. The review closed a doctor's determination with a nurse's id
and the event named the nurse — a false name against a clinical act, written by
the mechanism that exists to make such acts attributable.

It takes the determination's id and nothing else now. The visit, the doctor and
the words are read from the stored row under its own lock, and the trigger
checks `actor_id` against `resolved_by` independently, so a caller that
constructs the event by hand cannot get it wrong either.

### Every regression was proved non-vacuous

| Reverted | Failed | Passed again |
|---|---|---|
| the GUC guard, with no transition performed | 2 of 2 | 2 of 2 |
| the recovery path, by the rehearsal's hollow-row walk | rehearsal | 25 of 25 |

The forgery test now sets the GUC itself, the way the review did, so the old
design fails it for the right reason rather than for want of trying.

## 12.6 The sixth correction: the words are the doctor's too

One blocking finding and two cleanups, all bounded.

**The last thing taken on trust.** §12.5 moved the transition, the visit, the
actor and both statuses out of the caller's hands and left `reason` and `detail`
in them. A direct writer could therefore record a genuine closure — right
doctor, right visit, real transition — carrying words nobody said, in a table
whose whole purpose is that it cannot be edited afterwards.

The trigger reads the determination's reason and encounter, derives the
prescription number, and overwrites both fields exactly as it already overwrote
`from_status` and `to_status`. The closing function stops building the detail,
so the canonical sentence exists in one place.

**And two cleanups the review was right to separate from it.** The rehearsal's
recovery check executed a duplicated constant while claiming to run the printed
SQL verbatim; it now slices the statement out of the refusal message between the
printed marker and the closing sentence, asserts it is a statement, and runs
those characters. `docs/README.md` said thirty-six unit tests where the gate
reports thirty-eight.

| Reverted | Failed | Passed again |
|---|---|---|
| `reason` and `detail` taken from the writer | 1 of 1 | 1 of 1 |

## 12.7 Slice 2 accepted

Slice 2 was accepted on **17 September 2026** after the sixth bounded
correction. The acceptance gate was 758/758 database tests, 212/212 Slice 2
tests, 25/25 migration-rehearsal checks on each of two applications, 38/38 unit
tests, a clean frontend typecheck, and a clean `git diff --check`. The focused
direct-writer regression was also rerun independently and passed.

No browser journey was rerun for the sixth correction because it changed only
a database trigger, its characterization test, the migration rehearsal, and
documentation; the preceding full browser gate was 64/64. Acceptance closes
W5 as a backend capability. It is not a deployment, and the later frontend
programme still owes the calendar and reconciliation controls described in
`SLICE2_FRONTEND_CONTRACT.md`.
