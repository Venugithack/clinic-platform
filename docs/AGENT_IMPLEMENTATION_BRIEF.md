# AI implementation brief for Jayamurugan Clinic

This file is the coding handoff for the approved product direction. Treat it as
an execution contract, not as permission to rewrite the application or deploy
to the clinic without review.

## 1. Mission

Implement the Jayamurugan Clinic redesign as a sequence of small, verified
vertical slices. The result must make routine work fast for doctor, nurse, and
pharmacy while keeping detailed controls in admin.

Confirmed additions from the owner:

- The pharmacy counter collects the doctor's consultation fee, even when no
  medicine is supplied by the clinic.
- Staff sign-in changes from a six-digit PIN to a four-digit numeric PIN.
- Approved owner decisions are recorded in `docs/OWNER_POLICY_REGISTER.md`.
- The target role workflows and interaction rules are recorded in
  `docs/UI_UX_PLAN.md`.

Do not interpret "predictive" as autonomous clinical decision-making. The
system may help the doctor find and reuse information; it must never diagnose,
choose treatment, approve a substitution, or sign on the doctor's behalf.

## 2. Read before changing code

Always read `AGENTS.md`, then `docs/README.md`. The documentation map in that
file routes each task to its current sources. Before implementation, also read:

1. `docs/UI_UX_PLAN.md` for any role workspace or interaction change.
2. `docs/OWNER_POLICY_REGISTER.md` for workflows controlled by clinic policy.
3. `docs/SCHEMA_AND_TYPES.md` for any data, API, or shared-type change.
4. The applicable document in `docs/reference/` for specialist subject matter.
5. The applicable runbook in `docs/operations/` for staging or release work.
6. `.github/workflows/ci.yml` before changing code or verification.

`docs/reference/PRODUCT_UX_DISCOVERY.md` preserves the earlier design-session
rationale. Later core documents take precedence where the direction changed.

`archive/` describes a retired application. It may explain old decisions but
is not an implementation source. Do not restore its architecture, commands,
tests, or database model.

This repository uses Next.js 16 with breaking changes. Before editing any
Next.js or React integration code, read the relevant installed documentation in
`node_modules/next/dist/docs/` as required by `AGENTS.md`. Do not rely on model
memory for framework APIs.

Before Supabase work, review the current official Supabase changelog for
relevant breaking changes and then the official documentation for Edge
Functions, Postgres migrations, database security, and private Storage. Check
the installed CLI with `supabase --help`/subcommand `--help`; do not guess CLI
commands.

## 3. Preserve the current architecture

The current system has two independently deployed halves:

- A statically exported Next.js/React application in `app/`, `components/`,
  and `lib/`.
- Deno Supabase Edge Functions and Postgres migrations in `supabase/`.

Preserve these constraints unless the owner separately approves an architecture
change:

- `next.config.ts` remains a static export. Do not introduce server-only Next.js
  runtime assumptions, route handlers, or same-origin cookies.
- The browser talks to the backend only through `lib/api.ts`.
- The database objects live in the private `jmc` schema. The shared database has
  conflicting table names in `public`; every query and migration must preserve
  the intended `search_path`/qualification.
- Supabase service-role credentials and database URLs never enter public code or
  a `NEXT_PUBLIC_` variable.
- Preserve the revision-based snapshot protocol and command-response snapshot
  behavior until a tested replacement is explicitly approved.
- Large history, stock ledgers, payment history, and clinical-image bytes are
  fetched on demand, not added to the whole-clinic polling snapshot.

## 4. Absolute safety boundary

Local development currently targets whatever backend is configured in
`.env.local`, which may be the live clinic database. Before running the app or
any mutating test:

1. Inspect the target without printing secrets.
2. Establish a separate staging Supabase project/database and Edge Function
   environment with synthetic data.
3. Prove that the local UI points to staging.
4. Create and verify a backup/restore path before rehearsing migrations.

If staging is unavailable, continue with read-only analysis, pure unit tests,
and code that does not make requests. Stop before any database mutation,
function deployment, seed, browser workflow, or live API call.

Never deploy, push migrations, change production secrets, or run a production
data correction without explicit approval. Never test by registering a fake
patient, changing stock, dispensing, or taking payment in the live clinic.

Preserve all existing user changes. Start with `git status`; do not reset,
checkout, delete, or overwrite unrelated work. Do not edit `archive/` as part of
this programme.

## 5. How to use subagents

Use subagents for bounded, non-overlapping work and independent review. The
main agent remains responsible for the shared contract and final verification.

Suggested workstreams:

- Data and security: schema inventory, migration design, constraints,
  transactions, authentication, authorization, and Storage policy.
- Doctor and nurse UX: selected-patient context, one-screen consultation,
  structured inputs, queue, vitals, follow-up, and print.
- Pharmacy, inventory, and finance UX: packages, receiving, FEFO picking,
  partial dispensing, consultation-fee collection, payments, and receipts.
- Verification: characterization tests, database/concurrency tests, role tests,
  browser flows, accessibility, print, and regression review.

Rules for delegation:

- Every agent reads the applicable source documents and reports assumptions.
- One owner controls shared hotspots such as `components/ClinicApp.tsx`,
  `lib/types.ts`, `supabase/functions/_shared/types.ts`,
  `supabase/functions/_shared/commands.ts`, and migrations. Do not let several
  agents edit those files concurrently.
- Agree on schema/API/type contracts before UI agents depend on them.
- Prefer subagents for inspection, isolated components, fixtures, tests, and
  review when a shared worktree would create conflicts.
- Subagents do not deploy or touch live data. The main agent reviews every
  result and runs the full gate.

## 6. Implementation sequence

Do not build all features in one unreviewable change. Finish and verify each
slice before advancing.

### Slice 0: safety and characterization

- Create the staging/local database and Edge Function workflow.
- Add realistic synthetic fixtures without patient-identifying information.
- Characterize current sign-in, queue, consultation, dispensing, billing,
  stock, and print behavior with tests.
- Record the existing schema and all frontend/backend type mappings.
- Add database/integration and browser-test foundations; current CI has neither.
- Obtain owner sign-off for unresolved choices that block a later slice.

Gate: no test can mutate production; backup restore is rehearsed; baseline
checks run reliably.

### Slice 1: four-digit PIN and shared patient context

- Update staff creation, PIN reset, bootstrap, lock screen, frontend validation,
  backend validation, help text, and tests.
- Preserve individual staff attribution, slow salted hashing, generic sign-in
  errors, current server-side wrong-attempt throttling/temporary lockout, idle
  expiry, audit events, and revocation of existing sessions on PIN reset.
- Reject repeated digits and simple ascending/descending sequences.
- Add selected-patient context shared by Queue, Vitals, and Consult.
- Allow the doctor to find/register a patient, create today's visit, record
  available vitals, and open Consult without changing accounts.
- Show duplicate suggestions before registration; never auto-merge patients.

PIN migration must be two-stage. A stored hash cannot be truncated or converted:

1. Add an explicit PIN-format/version marker for existing staff.
2. During a short compatibility release, allow each existing six-digit PIN to
   unlock only until that staff member is reset; all new/reset PINs are four
   digits.
3. Let an authenticated admin reset every staff member, including themselves.
   Resetting revokes the affected sessions.
4. Verify that no legacy PIN remains, then remove six-digit compatibility.

Do not deploy exact-four-only login before a reset path exists; that would lock
the whole clinic out.

Gate: every active user can sign in with an individual four-digit PIN, legacy
PIN count is zero, throttling works, reset revokes sessions, and doctor-alone
check-in works.

### Slice 2: doctor and nurse workspaces

Current status, 17 September 2026: the bounded consultation-attempt safety
cutover is implemented in the existing doctor workspace. It is not the full
appointment-calendar UI, and Slice 3 messaging has not started.

- Use English only for the first release: interface copy, autocomplete,
  templates, clinical phrases, and printed prescriptions. Do not build Tamil,
  bilingual selection, or print-time machine translation in this slice.
- `Call in` opens the selected patient directly in Consult.
- Build the landscape one-screen consultation with sticky patient identity,
  allergy/status flags, latest vitals, current encounter, compact previous
  visit, active medicines, and image-series status.
- On portrait tablets, keep the consultation primary and put patient context in
  a drawer/disclosure; keep identity and final actions visible.
- Add structured controls and safe free-text fallbacks for complaint, duration,
  examination, diagnosis, medicine, dose, frequency, timing, route,
  instructions, advice, and follow-up.
- Search medicine by brand, generic/ingredient, strength, form, code, and known
  barcode. Never hide strength/form differences in fuzzy results.
- Add doctor-specific recents/favourites, clinic dictionaries, templates loaded
  as visible drafts, and reviewed phrase completion.
- Let each doctor manage personal templates. Only the owner-doctor or another
  explicitly authorized doctor may publish clinic-wide templates; a non-doctor
  admin cannot edit clinical template content. Version and retire templates
  instead of overwriting history.
- Store unsigned drafts server-side for the responsible doctor so they survive
  sign-out and authorized-tablet changes. Keep them out of pharmacy and signed
  printing, and show a stale-draft review warning after seven days.
- Normalize prescription headers and lines. Signing makes the clinical intent
  immutable; templates and repeated visits can only create drafts.
- Add a dedicated A4 prescription and audited reprint independent of medicine
  purchase or payment.
- Print only when requested after signing. Reserve a physical signature area;
  do not store or place a digital signature image in the first release.
- Nurse arrival combines search/register, visit reason, and token creation.
- Vitals keep units visible, use large numeric entry, permit `Not measured`,
  retain repeated readings, and show approved `Review this reading` prompts.
- Add observation elapsed timers, next-check due, notes, doctor instructions,
  handoff, discharge, and transfer confirmation.
- Medicine given and skipped are NOT in this release. Owner policy register
  item 64, decided 13 September 2026: a patient under observation is given what
  the doctor wrote as a free-text observation instruction on the bed, and what
  happened is recorded as an observation note in the same timeline. The nurse's
  round carries the queue, the readings, the observation checks and the
  handoffs, and carries no dose list. This is settled scope, not a gap.

Gate: a normal doctor visit stays in Consult, exact medicine identity remains
visible through signing/printing, and nurse work never requires reselecting the
patient.

### Slice 3: medicine identity, packages, and stock

Implement the hierarchy without collapsing clinical identity into inventory:

```text
Substance/ingredient
  -> clinical drug (ingredient + strength + form + route)
  -> branded/real product
  -> versioned package SKU
  -> batch/lot
  -> stock and dispense events
```

- Use the clinic formulary as the local working set. Keep authoritative source,
  code, version, display term, synonyms, active state, and provenance separate
  from local favourites and operational records.
- Do not import or redistribute licensed terminology without confirming the
  applicable India/SNOMED/CDCI terms.
- Store stock in an integer base unit. Do not use floating-point quantities or
  money.
- Put package identity, hierarchy, conversion factors, receivable/sellable
  levels, and barcodes on a versioned package SKU.
- A batch references a package version and retains an immutable receipt-time
  conversion/price snapshot. Batch/lot, expiry, MRP and its basis, purchase
  cost and its basis are explicit.
- A plain GTIN/barcode normally identifies a package level, not a batch. Use
  batch/expiry from a scan only when the encoded payload actually contains it.
  Unknown scans require verified mapping.
- Purchase orders do not add stock. Accepted goods receipts add stock. Support
  partial receipts and quarantine/rejection.
- Receiving uses boxes/strips/loose units, previews the exact base-unit result,
  then posts one append-only positive movement.
- Show combined medicine stock in reliable base units; show boxes/strips/loose
  decomposition per batch when package definitions differ.
- FEFO excludes expired, recalled, quarantined, exhausted, or otherwise blocked
  batches.
- Adjustments, returns, write-offs, and reversals are compensating ledger
  events with actor, time, reason, and approval; never rewrite history.

Gate: every active product has an unambiguous base unit and price basis, package
differences do not corrupt history, and a verified physical opening count
reconciles with the ledger.

### Slice 4: dispensing, consultation fee, bills, and payments

- A signed prescription is immutable clinical intent. Opening it or entering a
  proposed `Give now` quantity does not reduce stock.
- Model dispense header, lines, and exact batch allocations as append-only
  events. Derive Waiting/Partially dispensed/Dispensed/Not taken/Cancelled.
- For each prescription line show prescribed, previously supplied, available,
  `Give now`, and remaining-after-this quantities.
- `Confirm and hand over` is one database transaction: authorize; enforce an
  idempotency key; lock affected prescription/batch rows in a stable order;
  recheck remaining prescribed and available batch quantities; allocate FEFO;
  write dispense/allocations and negative stock movements; update any balance
  cache; create medicine bill lines; then commit.
- Enforce sum of successful dispense quantities less than or equal to the
  prescribed quantity. Reject retries, over-dispensing, expired/blocked batches,
  and negative stock.
- Do not reserve stock for uncollected prescription remainder by default.
- A pharmacist may request a prescription change for an unavailable item but
  cannot dispense a substitute against the unchanged prescription. Only a
  doctor-authorized amended/replacement order permits it.

Consultation-fee rules:

- Completing an encounter creates at most one consultation-fee bill line, with
  a snapshot of the fee or approved waiver/follow-up rule effective then.
- Enforce uniqueness by source/encounter so retries cannot double-charge.
- Send that payable task to the pharmacy Counter even if there is no
  prescription or the patient buys no medicine.
- Medicine charges arise only from quantities actually handed over. A later
  dispense for a remainder adds only that later medicine charge; it never adds
  the consultation fee again.
- Pharmacy shows consultation fee and medicines as separate lines, then accepts
  full payment, cash + GPay/UPI/card split, part payment, or pay later.
- Bills and payments are separate records. Derive Unpaid/Part-paid/Paid from
  successful allocations. Never overwrite the bill total to represent a due,
  waiver, reversal, or refund.
- Payment posting and balance calculation are atomic and idempotent. Never
  allow allocations to exceed the remaining bill balance.
- Produce separate prescription, dispensing, bill, and payment receipts. The
  receipt distinguishes prescribed, supplied today, remaining, charged, paid,
  and due.

Gate: full, partial, multi-visit, declined, out-of-stock, consultation-only,
split, part-paid, and pay-later paths all reconcile under retry and concurrency.

### Slice 5: clinical images

- Keep the feature disabled until the owner approves consent, access, export,
  retention, correction/deletion, device-loss, and breach-response policy.
- Capture only from an open patient/encounter: Before/Progress/After, body site
  and side, consent, patient confirmation, optional caption, then upload.
- Store originals immutably in private object storage. Store crops and
  annotations as derived objects/events.
- Use the authenticated Edge Function boundary and short-lived
  operation-specific access. Never expose service credentials or public URLs.
- Doctor access is default; nurse access is policy-controlled; pharmacy has no
  image access. Admin access is not automatic.
- Do not place image bytes in snapshots, localStorage, or a public device
  gallery. Failed uploads show retry/discard and are never reported as saved.

Gate: cross-role and cross-patient access tests prove the privacy boundary, and
wrong-patient attachment is actively guarded in the UI.

### Slice 6: admin and rollout

- Group admin navigation into people/access, clinic operations, inventory,
  finance, and settings.
- Add reports for stock valuation/movements, expiry/returns, package audit,
  outstanding prescriptions, patient dues, payment reconciliation, follow-up,
  and image access.
- Keep complexity in admin and keep doctor/nurse/pharmacy screens focused.
- Test real tablets, clinic Wi-Fi, HP Smart Tank 580 A4 printing, and any later
  80 mm receipt device.
- Run an owner-approved parallel paper/system period and reconcile stock,
  consultation fees, medicine charges, cash, UPI/card, patient dues, and printed
  totals daily before cutover.

## 7. Database and security invariants

Every new migration and mutating command must satisfy all of these:

- Forward-only migrations, rehearsed outside production.
- Exact decimal `numeric` values for money; integer base quantities for stock;
  timezone-aware timestamps for events.
- Foreign keys, checks, and indexes on referencing columns.
- Authorization and validation on the server; hidden/disabled buttons are not
  security boundaries.
- Short transactions and consistent row-lock ordering.
- Idempotency/unique source keys for encounter completion, dispensing, goods
  receipt, billing, and payment.
- Append-only clinical, stock, dispense, payment, refund, and audit history.
- No exposed service key, raw PIN, or clinical-image URL.
- If any table/schema is exposed through the Supabase Data API, enable RLS and
  write specific authorization policies. `TO authenticated` alone is not
  authorization. Views must not silently bypass RLS. Privileged functions stay
  out of exposed schemas, have an explicit authorization check and restricted
  `EXECUTE`, and are never added merely to bypass a permission problem.

Stock truth is the movement ledger. Prescription truth is the signed line plus
subsequent events. Financial truth is immutable bill lines plus payment
allocations and compensating events. Cached balances must always be
reconcilable to those sources.

## 8. UI rules

- Work follows the selected patient; do not ask staff to select them again.
- One dominant work surface and one visible primary action.
- Put uncommon exceptions behind disclosure without hiding their state.
- Use clinic language: `Give now`, `Remaining`, `Receive boxes`, `Record part
  payment`, and `Print prescription`.
- Minimum 44 px targets, visible focus, readable contrast, reduced-motion
  support, stable layouts, and no color-only meaning.
- Medicine suggestions always show exact ingredient/brand, strength, dosage
  form, route/release details when relevant, and stock state.
- Autocomplete and templates remain visibly editable. Free-text fallback
  preserves the doctor's wording and can be mapped later without rewriting the
  signed record.
- Preserve the calm clinic-ledger identity, but reduce decorative card borders,
  tracked all-caps, monospace body copy, and long flat navigation.

## 9. Verification required for every slice

At minimum:

```text
npm run typecheck
npm test
npm run build
```

Also run the Edge Function typecheck used by CI:

```text
deno check --node-modules-dir=none supabase/functions/**/*.ts
```

Use an appropriate shell/glob expansion so every Edge Function file is checked.
Add and run, on staging/local infrastructure:

- Migration/schema verification and database constraint tests.
- Transaction, retry, and concurrency tests for stock, dispensing, encounter
  fees, and payments.
- Role/capability and image-object authorization tests.
- Browser journeys for nurse-present and doctor-alone visits, physical
  prescription printing, full/partial dispensing, consultation-only payment,
  split/part/pay-later payment, and four-digit PIN reset/sign-in.
- Accessibility, portrait/landscape tablet, long-name, offline/error recovery,
  and print-layout checks.

Do not declare completion based only on compilation or screenshots. Report the
exact commands run, test results, migrations applied and where, manual checks,
and any unverified hardware or owner-policy dependency.

## 10. Open decisions: do not silently invent policy

> **Status update, 11 September 2026:** the owner supplied the policy answers in
> [`OWNER_POLICY_REGISTER.md`](OWNER_POLICY_REGISTER.md). That register is
> authoritative for approved decisions and remaining clinical, regulatory, and
> real-data validation gates. The list below is retained as the original risk
> checklist.

The following originally required owner sign-off where they blocked implementation:

- Who collects the consultation fee when pharmacy is closed or unattended.
- Follow-up fee/waiver rules and who may approve waivers, discounts, refunds,
  and reversals.
- Prescription remainder validity and whether any short reservation is needed.
- Which staff may create/edit medicine/package definitions.
- Image consent, access, export, retention, and deletion/correction policy.
- Final paper sizes for dispensing/payment receipts if an 80 mm printer is
  introduced.
- Due dates, credit limits, and reminder policy for pay-later balances.

Safe defaults until approval: no automatic stock reservation, no automatic
substitution, no autonomous diagnosis/treatment, no automated WhatsApp, no
pharmacy image access, and no image release.

### Deferred by decision, not left open

**Nurse medicine due, given and skipped** is out of scope for this release —
owner policy register item 64, decided 13 September 2026. It is recorded here
because it is the one capability in `docs/UI_UX_PLAN.md` the application
deliberately does not implement, and a later reader should not mistake that for
unfinished work.

The clinic keeps working as it does: `set_observation_instructions` holds what
the doctor wrote, `record_observation` holds what the nurse did, and both sit in
the same bed timeline. There is no order, no schedule, no due time and no
given/skipped event anywhere in the schema, the commands or the types.

Building it later is a clinical subsystem and not a panel. Section K of the
register lists the seven questions that must be answered first — who orders a
dose, what makes one due and what escalates, what is recorded when one is
given, what a skip is and which skips reach the doctor, whether administration
moves pharmacy or ward stock, who pays, and what happens to an unfinished round
at handover. **Do not answer any of them by implementing one**, and do not show
a nurse a dose list with no authoritative order behind it: the value of that
screen is that everything on it is real.

## 11. Definition of done

A slice is complete only when its schema, Edge Functions, shared types, UI,
permissions, migration/reconciliation path, automated tests, error states,
accessibility, and documentation agree. There must be no placeholder that
pretends to save, dispense, charge, pay, print, or upload.

Finish each slice with a concise report containing:

- Outcome and user-visible change.
- Files and migrations changed.
- Data migrated/reconciled.
- Tests and manual flows passed.
- Security and concurrency checks performed.
- Remaining owner decisions or rollout risks.
