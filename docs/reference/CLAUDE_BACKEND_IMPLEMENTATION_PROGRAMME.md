# Claude backend implementation programme

> Copy-ready implementation brief for turning the 14 September 2026 product,
> workflow, UI/UX, frontend, inventory, supplier, and reordering findings into
> backend capabilities. This programme deliberately builds the backend first.
> The visual and workspace changes are a later programme and must not be mixed
> into these slices.

Status: **Slices 0, 1 and 2 are complete and accepted. Slice 3's owner policies
D8–D12c are approved as items 76–83; Slice 3A (the durable contract and domain
state machine) and Slice 3B (the provider adapter, the authenticated webhook
and the protected worker contract) are both implemented. Nothing has been sent:
no credential, no approved Meta template and no scheduler exists, and the
recall cohort and the messaging frontend remain unbuilt.** Slice 0's
verified evidence, work register, decision register, contract sequence, and
compatibility map are in
[`BACKEND_PROGRAMME_REGISTER.md`](BACKEND_PROGRAMME_REGISTER.md); Slice 1's
reported implementation is §11 of the same file and Slice 2's is §12, and their
frontend contracts are
[`SLICE1_FRONTEND_CONTRACT.md`](SLICE1_FRONTEND_CONTRACT.md) and
[`SLICE2_FRONTEND_CONTRACT.md`](SLICE2_FRONTEND_CONTRACT.md).

> **Slice 2 was implemented on 15 September 2026 and returned unaccepted on 16
> September 2026.** The acceptance review reproduced six faults against the
> guarded loopback database that the slice's own 632 passing tests did not see —
> the worst of them a first signing that ignored the visit an attempt was opened
> against, wrote an encounter and a ₹300 fee, and left the other visit waiting.
> The first six were corrected and every regression was proved non-vacuous by
> reverting the fix and observing the test fail. Five more bounded review rounds
> followed; `BACKEND_PROGRAMME_REGISTER.md` §12.1–§12.7 is the durable record.
> **Slice 2 was accepted on 17 September 2026.**
>
> It was implemented against owner-policy items 65–74. The appointment book is a table of its own rather than new states on
> the arrival queue, because owner item 70 says a booking does not join the
> live queue until check-in and `jmc.appointments` IS the live queue;
> `check_in_appointment` is the single door between them and a walk-in never
> passes through it. Items 72–74 became one doctor-only command,
> `resolve_consultation_attempt`, with a read behind the control the frontend
> programme will build.
>
> **One exposure is deliberately left open and is not a defect to be found
> later.** The deployed client still mints a fresh reference the moment a
> different visit goes live, so it never meets the new
> `ATTEMPT_NEEDS_RECONCILIATION` refusal and the duplicate charge it exists to
> stop is still reachable from the build on the clinic's tablets. Closing it is
> two frontend changes that must land together — stop minting, and offer the
> resolution — because either alone is worse than neither. It is named in
> `tests/attempt-key.test.ts`, in the register §12, and in the Slice 2 contract
> §1.1.

The first Slice 1 acceptance review found five defects: attempt identity omitted
the visit, the real client lifecycle had no component/browser coverage, search
did not escape LIKE metacharacters, consultation visibility reused the allergy
permission, and performance evidence was not reproducible. The reported
correction closes those five.

The second acceptance review found two remaining W1 defects:

1. A stored direct-consultation attempt (`visitId = null`) is silently reused
   when a live visit later appears. The client therefore sends no appointment
   id. Whether the original request committed or not, the new visit can remain
   `waiting` and unlinked after the consultation is confirmed. The frontend
   contract also contradicts itself: its normative rule says this transition
   reuses, while its recovery section says the same transition mints. A unit
   test of the stored key does not prove queue integrity.
2. A clinic-day rollover silently mints a fresh key even when the prior attempt
   is unresolved. The contract correctly admits that a reply lost just before
   midnight and retried just after it can create a second encounter and a
   second fee. A known path back to W1's duplicate charge is not acceptable as
   a completed idempotency fix. The safe default is to retain/fail closed and
   reconcile the earlier outcome; a new consultation must require an explicit,
   reviewable transition rather than elapsed time alone.

**The acceptance instruction at that point was:** do not begin another slice
until both paths had one unambiguous contract, end-to-end database/browser
coverage, no duplicate side effects, no silent orphaned waiting visit, and the
complete Slice 1 gate passed again. If the only sound resolution required
clinic policy, stop with the exact choice and evidence instead of selecting it
implicitly. The correction and later approval below supersede that temporary
stop.

> **Both were corrected on 15 September 2026** — see "The second acceptance
> correction" in [`BACKEND_PROGRAMME_REGISTER.md`](BACKEND_PROGRAMME_REGISTER.md)
> §11. The tablet now sends the visit it has on screen, the server compares
> stored and asked-for visits as a case analysis rather than an equality test,
> and elapsed time no longer mints a reference. Both branches and the midnight
> retry are covered by database tests and by real-screen browser journeys.
>
> **One thing was deliberately not decided and needs the owner.** A consultation
> signed before its visit existed leaves that visit `waiting` and attached to
> nothing. It is no longer silent — the signing is refused with
> `CONSULTATION_SIGNED_WITHOUT_THIS_VISIT`, which names both the consultation
> and the open visit, and the leftover visit is carried as an
> `unlinked_consultation` obligation — but closing it is a person's act.
> Automatic resolution means either editing a signed record (linking) or
> cancelling a visit a doctor deliberately created, and the three options with
> their costs are tabulated in the register section above.
>
> **A second question came out of reviewing the correction**, and it is the one
> more likely to be met on an ordinary day: after either non-rotating refusal
> the tablet holds an attempt it cannot let go of, and neither exit is a
> control the doctor has in front of them. They are not the same exit, either —
> `CONSULTATION_ALREADY_SIGNED` ends when the sheet is restored byte-for-byte,
> and `CONSULTATION_SIGNED_WITHOUT_THIS_VISIT` does not end that way at all,
> because the binding is judged before the fingerprint and a byte-perfect sheet
> is refused with the same code. That one ends when somebody closes the queue
> row — the same act the `unlinked_consultation` obligation asks for. Releasing
> on those codes reopens the duplicate charge; a control that abandons the
> attempt is a screen and belongs to the frontend programme. Both questions are
> tabulated in the register. At that handoff, Slice 2 was not to start before
> they were answered, because appointment convergence inherits both.

> **The acceptance review of that correction found two remaining defects and
> one missing concurrency proof.** First, sending only the visit currently on
> screen loses the visit the attempt began against. If an attempt began on a
> visit, the first request never committed, and that visit was then cancelled
> or otherwise left the snapshot, the retry sends no appointment and the server
> accepts a direct consultation. The cancelled visit has been bypassed and the
> new encounter and fee are unlinked. The request must carry both the immutable
> opened-against identity and the current live visit; replacing either with the
> other discards information the server needs. Second, the new
> `unlinked_consultation` query filters an appointment on `created_at` instead
> of `scheduled_at`, so an appointment for tomorrow booked today can be reported
> as today's orphaned queue visit, while today's appointment booked yesterday
> can be missed. Finally, the concurrent same-key test has no appointment at
> all, so it does not prove the common queued case where
> `requireActiveAppointment ... for update` runs before the unique-key
> serialization point. Reproduce that case and require both callers to receive
> the same truthful outcome. The current documentation also overstates the
> recovery: restoring the sheet cannot clear
> `CONSULTATION_SIGNED_WITHOUT_THIS_VISIT` while the live visit remains, because
> the binding refusal occurs before the fingerprint comparison.

> **All five were corrected on 15 September 2026, and the concurrency proof
> found a sixth defect on its first run.** The request now carries
> `openedVisitId` alongside `appointmentId`, additively, and a caller that
> sends neither behaves exactly as before; a visit that has been cancelled or
> closed under an attempt is refused with `ATTEMPT_VISIT_NO_LONGER_ACTIVE`
> instead of being bypassed. The obligation reads `scheduled_at`. The
> documentation now says which refusal each recovery belongs to.
>
> The sixth: with two tablets signing one **queued** patient under one key, the
> loser waited on `requireActiveAppointment ... for update`, woke to a visit the
> winner had just closed, and was told "That visit is already finished or does
> not belong to this patient" — false in both halves, with its own consultation
> sitting in the clinic. Having written nothing, it never reached the unique
> index, so the replay path never ran. The lock is now followed by a re-read of
> the key before any refusal, and that caller replays through the same recovery
> the index race uses. The whole state matrix is pinned by
> `tests/characterization/consultation-visit-identity.test.mjs`.

> **The owner approved the next-slice policy on 15 September 2026.** D1–D7 are
> owner items 65–71. The three consultation/visit reconciliation decisions are
> items 72–74. Together they require append-only, doctor-owned resolution before
> an ambiguous re-queue can release or mint an attempt. Slice 2 is unblocked;
> nothing in this approval retroactively adds those transitions to Slice 1.

## How to use this document

Give Claude this instruction from the repository root to begin implementation:

```text
Read docs/reference/CLAUDE_BACKEND_IMPLEMENTATION_PROGRAMME.md and
docs/reference/BACKEND_PROGRAMME_REGISTER.md completely. Slices 0 and 1 are
complete and accepted. Owner-policy items 65–74 are approved and Slice 2 is
unblocked. Implement Slice 2 only: appointments and walk-in queue convergence,
including the policy-backed append-only consultation/visit reconciliation
transitions and API contract. Leave the doctor-facing visual control to the
later frontend programme, but provide every field, state, refusal, and recovery
it will need. You may use agents and subagents exactly within the programme's
ownership rules. Do not work ahead, deploy, push migrations, use the live
clinic, or redesign the UI. Rerun the complete required gate and return the
twelve-part handoff.
```

After reviewing a completed slice, continue with:

```text
Continue the backend implementation programme with Slice <number> only. First
re-read the master programme, the previous slice handoff, and every current
document it requires. Preserve unrelated work. Finish and verify this slice,
then stop with the required handoff; do not work ahead.
```

The slices are intentionally reviewable. Do not ask one Claude session to
implement the whole programme in an unreviewed change.

---

## Master prompt for Claude

You are the lead implementation agent for Jayamurugan Clinic. Implement the
backend foundations and server workflows recommended by the current
competitive, workflow, UI/UX, and inventory research. The target is a simpler
clinic operating system for one doctor, one clinic, one in-house pharmacy, and
four tablets—not a generic hospital information system.

The assignment includes all of today's findings, not only inventory:

1. fast patient discovery and persistent visit context;
2. actionable workload, handoff, obligation, and exception read models;
3. future appointments that converge safely with the walk-in queue;
4. consent-aware reminders and clinician-selected recalls;
5. investigation, external-lab/referral, result, review, and notification
   closure;
6. secure patient continuity links, pre-visit intake, and patient uploads;
7. portable exports, integration events, retry safety, and recovery proof;
8. supplier master data and package-aware purchasing;
9. one authoritative goods-receipt path, discrepancy handling, and supplier
   credit closure;
10. explainable reorder assistance and supplier performance signals;
11. explicit, package-aware cycle-count scope and safe count completion;
12. feature-flagged ABDM/ABHA and standards-exchange groundwork;
13. narrowly scoped later foundations for payments, reconciliation,
    teleconsultation, accounting export, onboarding/migration, support
    diagnostics, and assistive drafting, but only where owner policy and a
    selected provider make implementation legitimate.

Build the server truth, contracts, migrations, permissions, audit, and tests
first. Do not redesign the frontend in this programme. Backend completion must
leave precise, minimal contracts for a later frontend programme.

## 1. Read before acting

Start every slice with `git status --short`. Preserve all existing and
unrelated user changes. Never reset, overwrite, reformat, or clean work merely
because it is not part of this assignment.

Read these files completely before planning or editing:

1. `AGENTS.md`
2. `docs/README.md`
3. `docs/OWNER_POLICY_REGISTER.md`
4. `docs/SCHEMA_AND_TYPES.md`
5. `docs/AGENT_IMPLEMENTATION_BRIEF.md`
6. `docs/UI_UX_PLAN.md`
7. `docs/reference/COMPETITIVE_LANDSCAPE_2026.md`
8. the specialist reference named by the slice, especially
   `docs/reference/INVENTORY.md` and `docs/reference/WHATSAPP.md`
9. `docs/reference/BACKEND_PROGRAMME_REGISTER.md`, when Slice 0 exists
10. relevant migrations, Edge Functions, shared types, and tests—the source of
   truth for implemented behaviour

Use this precedence when documents disagree:

1. current source code, migrations, and passing tests describe what exists;
2. `OWNER_POLICY_REGISTER.md` is authoritative product and clinic policy;
3. `UI_UX_PLAN.md` defines approved interaction intent;
4. `SCHEMA_AND_TYPES.md` and `AGENT_IMPLEMENTATION_BRIEF.md` define current
   technical constraints;
5. `reference/` supplies research and recommendations, not automatic policy;
6. `archive/`, including its ignored local comparison projects, is historical only.

Record a conflict; do not silently pick a convenient source. The inventory
reference currently describes learning reorder views as shipped, while current
source inspection found no active implementation and only retired public-view
names. Verify this independently and correct the current documentation as part
of the appropriate slice. Do not restore retired public views merely to make
the prose appear true.

Before changing any Next.js or React integration, read the relevant installed
Next.js 16 guide under `node_modules/next/dist/docs/`, as required by
`AGENTS.md`. Most slices should not need React changes.

For Supabase work, inspect the installed CLI help and current official
Supabase documentation/changelog for every API or platform behaviour that may
have changed. Do not rely on remembered commands. For ABDM, FHIR, payment,
messaging, or other external protocols, use current primary official sources
and save the exact source links and access date in the handoff. Research does
not authorize provisioning, credentials, production calls, or deployment.

## 2. Architecture and safety boundaries

Preserve the existing architecture unless a reviewed slice explicitly proves
that a small change is required:

- the Next.js application remains a static export;
- browser access to the backend remains centralized through `lib/api.ts`;
- the backend remains Supabase Postgres plus Deno Edge Functions under
  `supabase/`;
- the whole-clinic revision snapshot remains the compact current-state sync
  mechanism;
- large histories, ledgers, searches, exports, documents, and analytics remain
  on-demand rather than being added to every snapshot;
- command success continues to return authoritative server state in the manner
  required by the current contract;
- no separate local backend, hidden second source of truth, or speculative
  replacement stack may be added.

Absolute safety rules:

- Never use, browse, seed, mutate, or test against the live clinic.
- Use only the guarded loopback scratch/staging procedures in
  `docs/operations/STAGING.md`.
- Inspect the resolved backend target without printing secrets before any
  database or browser test.
- Never deploy Edge Functions, push migrations, change production or staging
  secrets, provision external services, send real messages, invoke real
  payment actions, or make live ABDM calls without a new explicit user
  instruction.
- If guarded scratch infrastructure is unavailable, continue with safe static
  work and tests, then report the exact missing gate. Do not substitute live.
- Do not push Git commits or branches unless explicitly instructed.
- Forward-only migrations only. Never rewrite an already-applied migration.
- Consequential writes must be authorized on the server, transactional,
  idempotent where retry is possible, and auditable.
- Use exact `numeric` values for money and integer base units for stock.
- Use `timestamptz`, foreign keys, check constraints, indexes, and explicit
  uniqueness where the domain requires them.
- Prevent negative stock, invalid batch allocation, duplicate receipt/payment
  effects, and silent partial completion.
- Keep clinical, financial, dispensing, inventory, count, and audit truth
  append-only. Correct by reversal, replacement, or explicit state transition;
  do not erase historical facts.
- Acquire stock-affecting row locks in the established consistent order and
  keep transactions short.
- Enforce role and row visibility on the backend. Hiding a frontend button is
  never authorization.
- Do not automatically send WhatsApp or other patient communications. Consent,
  configuration, approved template, and an attributable trigger are required.
- Prescribing does not reserve stock. Reorder calculations must not invent a
  reservation model that owner policy explicitly rejected.

## 3. What “backend first” means

Allowed work:

- forward-only database migrations;
- Edge Function commands and on-demand queries;
- database, Deno, contract, concurrency, and authorization tests;
- compatible shared TypeScript contract additions needed to expose the new
  server truth;
- the smallest non-visual client contract wiring required to make a safety or
  idempotency guarantee effective end to end. This exception does not authorize
  layout, navigation, copy, icon, theme, or workflow redesign;
- fixtures and guarded staging support;
- current documentation updates describing what is actually implemented;
- a concise frontend handoff contract listing fields, permissions, states,
  errors, and suggested actions.

Deferred work:

- React workspace changes beyond the explicit non-visual safety-contract
  exception above; navigation, screen composition, responsive layout,
  themes, visual polish, icons, sticky action areas, bottom navigation, or
  touch-target changes;
- public booking pages or patient portal screens;
- any visual claim that a backend capability is user-accessible before the
  frontend is implemented and verified.

Do not break the current frontend while working backend-first. Prefer additive
contracts and compatibility adapters. If a defect cannot be fixed without
changing an existing response, create a versioned or additive path, document
the deprecation, add characterization coverage for the existing consumer, and
defer removal until the frontend cutover has passed. Do not add large new
collections to the clinic snapshot for convenience.

## 4. Lead-agent and subagent rules

You may use agents and subagents because the programme is large, but one lead
owns integration and truth.

The lead exclusively owns:

- the programme work register and dependency order;
- migration numbering and shared schema decisions;
- shared types and response envelopes;
- shared command dispatch/routing and clinic snapshot shape;
- policy interpretation and conflicts;
- final diff review and all integration gates.

Good bounded agent assignments include:

- read-only schema/command/type audits;
- official-source research for one external standard;
- characterization of one existing workflow;
- isolated test fixtures or test review;
- independent authorization, concurrency, privacy, or migration review;
- verification of a completed slice against its acceptance criteria.

Do not let two agents edit the same file concurrently. Do not delegate a
cross-cutting migration, shared contract, or common command router to competing
agents. Agents do not deploy, use live data, alter secrets, or make external
writes. Every agent returns exact files inspected/changed, evidence, tests,
risks, and assumptions. The lead reviews every diff rather than accepting a
summary as proof.

At the beginning of each slice, use parallel read-only agents when helpful.
Freeze the slice contract before delegating edits. At the end, use an agent
that did not implement the slice for an independent review when capacity
allows, then address its findings before the handoff.

## 5. Programme-wide domain rules

Apply these to every slice:

### Truth and derivation

- Prefer deriving progress, outstanding obligations, inventory position,
  balances, and metrics from authoritative facts rather than adding mutable
  duplicate status fields.
- Where a stored state is necessary, define its state machine, allowed
  transitions, actor, timestamp, reason, and idempotency behaviour.
- Never report success before the authoritative transaction has committed.
- Represent partial completion and outcome-unknown explicitly.

### Idempotency and retries

- Every client-retryable consequential command accepts a scoped idempotency
  key and the server stores enough request identity and result identity to
  return the original outcome safely.
- The same key with materially different input must be rejected.
- External delivery attempts use an outbox/attempt model with retry count,
  next-attempt time, terminal failure/dead-letter state, and provider reference
  where applicable.
- Webhooks are authenticated, deduplicated, ordered or reconciled where
  ordering is not guaranteed, and retain raw evidence safely without exposing
  secrets.

### Privacy and access

- Minimize data in search results, snapshots, logs, analytics, exports, share
  links, and external payloads.
- Patient links use opaque random tokens; store a hash, not the bearer token.
- Documents and exports remain private and use short-lived, purpose-limited
  access. Log issue, access, revocation, and exceptional failure without
  logging confidential contents.
- Intake and uploaded material keep source/provenance and require staff review;
  they do not silently become authoritative clinical facts.

### Financial and inventory integrity

- Preserve immutable ledger lines and document relationships.
- Tax, MRP, purchase basis, package conversion, free quantity, returns, and
  credits remain exact and traceable.
- Stock moves only on completed approved events. Draft purchase orders,
  prescriptions, suggestions, and pending counts do not move stock.
- Reordering is decision support. It must never place or send an order
  automatically.

## 6. Slice 0 — evidence baseline, policy gates, and contract freeze

Do this slice first and stop when it is complete. It creates the safe basis for
all implementation work.

### Required work

1. Map the current schema, migrations, Edge Function commands, shared types,
   snapshot fields, on-demand endpoints, role checks, audit events, and test
   coverage relevant to every programme workstream.
2. Characterize the existing patient, queue, consultation, pharmacy, billing,
   inventory, supplier, purchase-order, receipt, return, stock-count,
   WhatsApp, export, and backup workflows with exact source references.
3. Verify these suspected inventory conditions rather than assuming them:
   - `post_goods_receipt` is the richer/canonical receiving engine;
   - an older `receive_order` path is still used by the current Orders UI and
     bypasses some GRN/package/invoice/idempotency/quarantine behaviour;
   - medicine creation can establish opening stock through a path that does not
     provide the same verified package/count controls;
   - purchase-order lines already contain some structured package fields but
     the user-facing workflow still relies on lossy text in places;
   - active learning-reorder views are absent even though a specialist
     reference calls them shipped.
4. Create a programme work register in current documentation. For every item,
   record: present behaviour, gap, governing owner policy, proposed server
   contract, migration need, compatibility risk, test plan, frontend handoff,
   external dependency, and status.
5. Create a decision register containing only unresolved policy questions.
   Cross-reference existing owner decisions rather than repeating them.
6. Propose the smallest additive contract order for Slices 1–11, including
   table and command names only after checking repository conventions.
7. Add characterization tests where the highest-risk current behaviour is not
   protected, but do not implement feature behaviour in Slice 0.
8. Correct documentation statements that are objectively contradicted by
   current source and tests. Preserve historical rationale as historical.

### Policy questions to classify

Do not invent answers. Mark each as `already decided`, `safe technical
default`, or `owner decision required`:

- appointment duration, booking horizon, overbooking, cancellation,
  rescheduling, no-show, walk-in priority, and who may edit availability;
- reminder channel, timing, quiet hours, consent source, template approval,
  retry ownership, and opt-out;
- recall eligibility and which clinician action schedules it;
- patient-link identity check, purpose, expiry, revocation, download permission,
  proxy/family access, and rescheduling limits;
- online intake fields, consent wording/versioning, attachment types/limits,
  retention, and staff review responsibility;
- investigation catalogue ownership, abnormal flag source, who must review,
  escalation time, who may notify, and whether notification text contains
  clinical detail;
- supplier-invoice duplicate policy, discrepancy tolerance, damaged/short/free
  quantity treatment, attachment retention, and receipt approval roles;
- purchase-order approval thresholds, preferred supplier selection, manual
  channel recording, short-close/cancel reasons, and expected-arrival rules;
- reorder review interval, safety buffer, demand window, seasonality override,
  substitution relationship, and who accepts/dismisses suggestions;
- stock-count cadence and scope rules after opening count;
- ABDM consent, identifiers, supported workflows, facility/provider setup, and
  pilot boundary;
- payment provider, payment-link expiry, fees, refunds, reconciliation
  ownership, and webhook dispute handling;
- teleconsult provider, identity, consent, recording prohibition/retention, and
  failure fallback;
- assistive drafting data handling, permitted content, reviewer, provenance,
  and explicit prohibition on autonomous diagnosis or prescribing.

Owner policy already says not to build automated pay-later/debt reminders in
the initial system. Appointment reminders or clinician-selected follow-up
recalls must not smuggle in automated debt collection.

### Slice 0 deliverables

- evidence-backed work register;
- unresolved-decision list suitable for the owner to answer;
- additive contract and migration sequence;
- compatibility map for existing frontend consumers;
- focused characterization tests, if needed;
- documentation corrections supported by source/tests;
- no feature implementation.

### Slice 0 gate

Run the applicable static/type/unit/characterization checks and
`git diff --check`. Report checks that cannot safely run. Stop for review.

## 7. Slice 1 — cross-workspace discovery, context, workload, and obligations

Build the reusable backend read models that make the later UI faster and
simpler without bloating the clinic snapshot.

### Required capabilities

- **Fix W1 before the read models.** `sign_consultation` currently creates a
  second encounter, invoice, and consultation-fee line when the same
  no-appointment consultation is submitted twice. Add a stable client
  idempotency key, a forward-only unique persistence contract on the encounter
  or shared operation record, and enough material request identity to reject
  reuse of the same key with different input. A replay of the same request must
  return the original authoritative encounter, prescription, invoice/fee, and
  response identity without repeating follow-up, phrase-learning, billing, or
  audit side effects. Cover the concurrent first-write race, not only a
  sequential retry.
- Wire that key into the existing consultation caller as the smallest
  non-visual safety change: one key per consultation attempt, preserved across
  refusal, lost response, and outcome-unknown; rotate it only after confirmed
  completion or an explicit new consultation. Do not alter the screen's layout,
  icons, navigation, wording, or normal workflow. Keep the server compatible
  with the previously deployed no-key client while documenting the remaining
  exposure of an old cached build; do not call the issue closed unless the
  current repository client actually sends and reuses the key.
- On-demand global patient search by the approved identifiers that current data
  can truthfully support: normalized name, phone, patient ID, and today's token.
- Role-minimized results with stable patient and current-arrival references;
  no broad clinical or financial detail in a generic search result.
- A patient-context read model for authorized staff containing only supported
  facts such as patient identity, current token/arrival, age/sex when recorded,
  recorded allergy/alert summary, current balance, prescription waiting,
  result pending, and current visit stage. Do not fabricate absent fields.
- Actionable workload counts and drill-down queries: today, due now, counter,
  pending review, expiring, unresolved stock/count/billing exceptions, and
  admin `Needs attention`. Counts must represent real actionable sets, not
  decorative record totals.
- A derived visit-progress/handoff model covering applicable stages: arrival,
  vitals, consult, counter, payment, follow-up, and results. Each open stage
  identifies its status, responsible role/owner, age, and safe next action.
- A derived safe-exit obligation model that can tell a workspace what remains
  unresolved before leaving a patient or transaction.
- A consistent additive action/outcome contract for working, confirmed,
  partial, pending, failed, and outcome-unknown where the existing response
  contract does not already cover these states.
- On-demand eligible-equivalent lookup for controlled pharmacy substitution if
  the existing server contract is incomplete. It may expose approved candidates
  and constraints; it must never choose a substitute or make a clinical claim.
- For every new Slice 1 endpoint, declare its allowed roles in one reviewable
  capability source used by its authorization path and tests. The Slice 0 audit
  found that command `requireRole` checks and seven snapshot gates are maintained
  independently with no database-policy fallback. Do not undertake a risky
  rewrite of all existing authorization merely for neatness, but do add an
  explicit coverage test proving every new endpoint declares a capability and
  every returned field is minimized for that role. Record the wider legacy
  drift risk for a later dedicated hardening decision.

### Acceptance

- Search is indexed, bounded, paginated or capped, role-authorized, and does
  not require loading all patients into a client.
- Every count reconciles with its drill-down query under a transactionally
  sensible snapshot of data.
- Progress and obligations are derived from authoritative facts and cover
  partial/failed states.
- Existing snapshot and workspace consumers continue to pass unchanged.
- W1's old characterization assertion is replaced by prevention tests: same
  key/same input returns the original result; same key/different material input
  is rejected; concurrent same-key calls create exactly one encounter, fee,
  prescription/follow-up set, and audit effect; the current client reuses the
  key after an outcome-unknown.
- Database tests cover role leakage, ambiguous matches, duplicate names,
  missing optional data, clinic-day boundaries, partial workflows, and query
  performance on a representative fixture volume.

## 8. Slice 2 — appointments and walk-in queue convergence

Add a minimal future-scheduling domain for this clinic. Do not build enterprise
resource scheduling unless an owner decision expands the clinic model.

### Required capabilities

- Apply owner-policy items 65–71 exactly: 15-minute default duration with
  per-type configuration, a 90-clinic-day horizon, no ordinary overbooking,
  role- and reason-gated overrides, the approved cancel/reschedule/no-show
  rules, one arrival-ordered queue, doctor-only urgent prioritization with a
  reason, and doctor/admin-owned availability.
- Appointment type/configuration and provider availability only to the degree
  approved by policy.
- Appointment states with explicit transitions, actor, reason, and timestamps:
  at minimum draft/booked, confirmed where used, rescheduled, cancelled,
  no-show, arrived/checked-in, completed or closed as justified by the current
  visit model.
- Conflict/availability checks inside the authoritative write transaction.
- Idempotent booking, rescheduling, cancellation, and check-in commands.
- A bounded day/range calendar query and patient appointment history query.
- Check-in that links exactly one appointment to exactly one current arrival
  and existing token/queue workflow. Retrying must return the same arrival,
  never create two queue entries.
- Walk-ins continue to work with no appointment. Scheduled and walk-in patients
  converge after check-in rather than creating parallel consultation systems.
- Audit and role authorization for availability and appointment changes.
- Apply owner-policy items 72–74 as one reconciliation workflow. Add
  append-only, doctor-authorized backend transitions for **Same attendance**,
  **New attendance**, and abandonment of an inactive opened visit. Never rewrite
  a signed encounter, never infer a second consultation from reception creating
  another queue row, never release or mint while the prior outcome is unknown,
  and never create a second encounter or fee during reconciliation. Reuse the
  Slice 1 outcome/idempotency contract rather than creating a parallel truth.
- Return explicit, stable conflict/refusal data for the later doctor-facing
  resolution control. Do not add that visual control in this backend slice.
- Hooks/outbox events for later reminders, without sending anything in this
  slice.

### Acceptance

- Concurrent booking/check-in tests prove that conflicts and duplicate arrivals
  cannot be created.
- Clinic-day/time-zone handling uses the current clinic configuration and
  `timestamptz` correctly.
- Cancellation/rescheduling history is preserved.
- The complete lost-reply/re-queue matrix is tested through the real backend:
  committed and uncommitted A, accidental and genuine B, same/new attendance,
  inactive opened visit, unknown outcome, repeated resolution, and two people
  resolving concurrently. Every branch asserts encounter count, fee lines,
  queue state, audit/reconciliation history, and truthful retry response.
- Only a doctor can make the same-attendance/new-attendance clinical resolution;
  reception, nurse, pharmacy, and an admin without a doctor role are refused.
- Existing walk-in workflows and snapshot polling continue to pass.
- No patient-facing page or frontend calendar is added.

## 9. Slice 3 — reminders, recalls, and communication delivery truth

Build a provider-neutral, consent-aware communication scheduler around the
existing WhatsApp capability and approved policy. Do not treat a provider API
response as patient delivery.

### Required capabilities

- Versioned message-template metadata with purpose, locale, approval/config
  state, and allowed variables. Do not store a second uncontrolled template
  system if the existing WhatsApp model can be extended safely.
- Communication consent/preference evidence scoped by channel and purpose,
  including source, time, withdrawal, and actor where policy requires it.
- Reminder/recall schedules tied to an appointment, encounter/follow-up, or
  other authoritative source.
- States such as scheduled, suppressed, queued, sent-to-provider, delivered,
  failed-retryable, failed-terminal, cancelled, and outcome-unknown, mapped to
  actual provider evidence.
- Durable outbox/delivery attempts with idempotency, exponential or
  policy-approved retry, next attempt, provider reference, error category, and
  dead-letter ownership.
- Authenticated, deduplicated provider-status webhook handling if supported by
  the existing integration.
- Queries for staff-owned failures, due reminders, consent suppression, and
  delivery outcome.
- Manual resend/cancel where policy permits, with audit and duplicate-safety.
- If separately approved, a saved, reviewable recall-cohort definition with a
  frozen recipient set, per-recipient consent/eligibility check, dry-run count,
  authorized release, and individual delivery truth. Do not turn clinical
  recall into an unrestricted marketing broadcast tool.

### Boundaries

- No automated debt/pay-later reminders.
- No medical detail in a message beyond approved template policy.
- No live sends in development or tests.
- If no safe scheduler is currently available, implement the durable data and
  protected worker contract, document the required scheduling mechanism, and
  stop before provisioning it.

> **Slice 3A, implemented 18 September 2026.** The five tables, the state
> machine, nine commands, four on-demand reads and an injectable channel
> exist, against owner items 76–83. `docs/SCHEMA_AND_TYPES.md` §15 is the
> contract. The last boundary above is the one that decided the shape: no
> scheduler is provisioned, the worker is a pair of exported functions nothing
> invokes on a timer, and the required mechanism is written down in §15.8
> rather than built.
>
> **Slice 3B, implemented 18 September 2026.** The provider adapter, the
> authenticated statuses webhook with durable event deduplication, and the
> protected worker endpoint. `docs/SCHEMA_AND_TYPES.md` §16 is the contract.
> The instruction directly above — *"if no safe scheduler is currently
> available, implement the durable data and protected worker contract, document
> the required scheduling mechanism, and stop before provisioning it"* — is
> exactly what was done: `functions/worker` exists behind a shared secret,
> `operations/ROLLOUT.md` §9 holds the `pg_cron`/`pg_net`/Vault steps and their
> rollback, and none of them has been run. The adapter stays fully disabled
> without its four `WHATSAPP_*` values, and no value for any of them exists.
>
> **Still outstanding in Slice 3:** the saved, frozen, dry-runnable recall
> cohort (owner item 80) and the frontend messaging workspace. Neither can be
> validated against a real provider until a connection exists, which is a
> release gate rather than an engineering one.

### Acceptance

Test consent withdrawal, rescheduling, cancellation, quiet hours, template
unavailability, duplicate worker invocation, webhook duplication/out-of-order
events, terminal failure, retry exhaustion, and role visibility.

## 10. Slice 4 — investigation, referral, result, review, and notification loop

Close the common outpatient diagnostics loop without building a LIMS, RIS,
PACS, or analyzer integration platform.

### Required capabilities

- A controlled investigation/referral catalogue appropriate to the approved
  clinic scope and role ownership.
- An order/referral tied to patient and encounter, with requested items,
  external facility when applicable, instructions, priority if approved,
  ordering clinician, and immutable provenance.
- A state machine covering the real loop: ordered, referred/sample or external
  work in progress where applicable, result received, awaiting review,
  reviewed, patient notification pending, notified, closed, cancelled, and
  overdue/exception. Use only states justified by policy.
- Private result documents with metadata, checksum/provenance, upload actor,
  corrected/superseded relationships, and tightly scoped access.
- Structured values only where the product has a legitimate bounded catalogue;
  otherwise preserve the received report rather than pretending to be a LIMS.
- An abnormal/urgent flag whose source is explicit (external report, imported
  structured flag, or authorized manual flag). Never infer medical abnormality
  from free text or an unapproved AI model.
- Clinician review acknowledgment, review note if approved, result correction,
  notification authorization, and patient-notification evidence.
- Due/overdue and exception read models with an accountable role/owner.
- Events/contracts for patient-link release and approved notification, without
  exposing a result before required review.

### Acceptance

Test role access, wrong-patient attachment prevention, corrected reports,
duplicate uploads, review-before-release, urgent ownership, notification
failure, revocation, and full audit history. Prove that a received result
cannot be reported as reviewed or patient-notified without the corresponding
authoritative event.

## 11. Slice 5 — patient continuity links, intake, and uploads

Provide narrow patient access to specific actions and documents without
creating a broad account portal or leaking the clinic snapshot.

### Required capabilities

- Purpose-specific opaque share/action grants. Store only a strong token hash;
  record patient, purpose, allowed resource/action, issued/expiry/revoked time,
  issuer, use limits if approved, and last-access evidence.
- Short-lived access resolution that returns the minimum necessary resource,
  never staff-only data or a general patient record.
- Approved purposes may include appointment confirmation/reschedule/cancel,
  visit summary, prescription, invoice/receipt, reviewed result, and follow-up
  instructions. Implement only purposes whose policy has been decided.
- Revocation on correction, replacement, patient request, or staff action as
  required. Previously issued links must not silently follow a document to a
  different clinical version.
- Rate limiting, safe error equivalence, audit, expiry, and token rotation.
- Versioned intake forms/answers and consent acknowledgements with provenance.
- If public booking is approved, a clinic-scoped availability query and
  rate-limited booking request that reuses the appointment conflict and
  idempotency engine from Slice 2. It must not expose staff schedules, patient
  existence, or unrestricted clinic data. Requests requiring staff acceptance
  remain requests—not confirmed appointments—until the authoritative
  transition occurs.
- Patient uploads into private quarantine/review state, including file type,
  size, checksum, malware/content-safety mechanism if available, and reviewer.
- Explicit staff accept/link/reject action. Uploaded statements do not silently
  overwrite demographics, allergies, diagnoses, medicines, or results.

### Acceptance

Test token hashing, guessing/rate limiting, expiry, revocation, resource and
patient isolation, corrected/superseded documents, proxy policy, repeated
submission, attachment limits, unauthorized clinical merge, and audit privacy.
Do not create the patient-facing frontend in this slice.

## 12. Slice 6 — exports, integration events, resilience, and recovery proof

Make the clinic's data portable and consequential operations diagnosable.

### Required capabilities

- Authorized, bounded exports for patient, encounter, prescription/dispensing,
  bill/payment, inventory/stock ledger, purchasing, supplier credit, and audit
  domains, subject to role and policy.
- Async export jobs where size or document generation warrants them; private
  artifacts, expiry, checksums, status, failure reason, and audit. Small exports
  may remain synchronous if proven safe.
- Stable versioned export schemas and machine-readable formats; exact money,
  timestamps, identity, provenance, and reversals.
- A provider-neutral integration-event/outbox contract for approved downstream
  use. Publishing failure must not roll back the clinic transaction, and retry
  must not duplicate downstream effects.
- Webhook subscriptions/delivery only if current policy warrants them; include
  signing, secret rotation, replay defence, delivery logs, and dead-letter
  handling.
- An idempotency/outcome lookup for commands that can end in client-side
  outcome-unknown, so the UI can ask the server what committed.
- Degraded-state/health information that can tell the future UI when writes are
  unsafe, retries are queued, or data may be stale without claiming full
  offline capability.
- Close the backup confidence gap documented by the repository: prove that the
  actual stored backup artifact can be fetched, integrity-checked, decrypted
  where applicable, and restored into a disposable scratch target. Never
  restore over live or staging clinic data. If protected CI credentials or an
  external configuration are required, implement only safe local/CI logic and
  report the exact external step for approval.

### Boundaries

Do not claim offline-first operation until conflict, replay, duplicate effect,
and recovery behaviour are tested. Do not enable external webhooks, create
external buckets, or change branch protection in this slice without explicit
approval.

### Acceptance

Test export authorization and isolation, large-job retry, artifact expiry,
event deduplication, webhook signature/replay handling where present, outcome
lookup, and a full disposable restore drill or a clearly evidenced external
blocker.

## 13. Slice 7 — supplier master and package-aware purchase orders

Make ordering structured enough that receiving and reordering no longer depend
on retyping or parsing WhatsApp prose.

Read `docs/reference/INVENTORY.md` and the inventory deep dive in
`COMPETITIVE_LANDSCAPE_2026.md` again before this slice.

### Required capabilities

- Supplier edit, safe deactivate/reactivate, contact/channel details, return
  window, lead-time default, active status, and preferred/alternate role where
  approved. Historical documents must retain the supplier identity/version
  used at the time.
- A medicine-supplier procurement profile that can hold supplier SKU, specific
  package version, purchase basis, MOQ, order multiple, agreed/latest price and
  validity, lead time, preference priority, and active period. Do not overwrite
  historical purchase truth when a profile changes.
- Structured, editable, package-aware PO lines using existing fields where
  valid, including order-level name/count, package version, expected base
  quantity, quoted unit/package price, tax/basis as required, and a human note.
- PO states and transitions for draft, approved if policy requires it, placed,
  supplier acknowledged, partially received, fully received, cancelled, and
  closed short. Preserve actor, time, channel, reason, and supplier reference.
- Manual `mark placed` support for phone/WhatsApp ordering; sending via an
  integration is not required to establish purchase-order truth.
- Expected arrival and acknowledgement updates.
- Saved-PO-line rendering data for print/WhatsApp. Generated text must come from
  the saved structured lines, not become the source of truth itself.
- Open quantity derived from PO lines and posted receipts/closures. Cancelled
  and closed-short quantities must not count as on order.
- Duplicate-draft guard when a reorder decision has already created an open PO
  line for the same need, while still allowing an authorized intentional
  additional order with an explicit reason.

### Acceptance

Test package conversion, MOQ/order-multiple validation, supplier profile
version changes, partial receipts, cancellation/short close, duplicate draft,
manual place, permissions, and historical rendering. Existing Orders UI
responses must remain compatible until its later frontend cutover.

## 14. Slice 8 — canonical goods receipt, discrepancies, and supplier credits

Create one authoritative receipt engine without breaking the current frontend
before it is migrated.

### Required capabilities

- Establish `post_goods_receipt`—or the current verified equivalent—as the one
  domain engine for receipt posting. It must handle package conversion, batch,
  expiry, purchase price/basis, MRP where required, tax, paid quantity, free
  quantity, saleable/quarantine disposition, stock ledger, supplier document,
  purchase-order allocation, audit, and idempotency atomically.
- Add an on-demand receiving-prefill query from the saved PO, including ordered,
  already received, open, package, expected price, and expected arrival.
- Model receipt discrepancies explicitly: short, excess, substituted product
  if policy permits, price/tax mismatch, missing/damaged/free quantity, batch or
  expiry issue, and unallocated line. Record resolution, actor, and evidence.
- Protect against duplicate supplier invoices using the approved supplier-level
  identity rule. Where policy is not yet decided, surface a reviewable conflict
  rather than silently blocking legitimate duplicates or accepting them.
- Track supplier invoice/paperwork state and a private attachment if approved.
- Preserve partial receipts and allow authorised close-short/cancel of the
  remaining PO quantity.
- Extend supplier returns/credits with actual credit-note reference, date,
  amount, partial/full application, target invoice/receipt relationship, and
  unresolved credit balance. Inventory reversal and financial credit remain
  distinct linked truths.
- Provide a safe compatibility adapter for the currently used legacy
  `receive_order` command. Until its frontend caller is migrated, route it
  through the canonical engine when inputs are sufficient or retain it with
  explicit characterization, audit/telemetry, and deprecation. Do not simply
  delete it or silently reinterpret ambiguous quantities.
- Treat medicine-creation opening stock as a separate controlled opening-count
  event, not a back door around package, batch, expiry, or approval rules. Keep
  existing frontend compatibility until the opening-count UI changes, but add
  the safest server guard and migration path permitted by approved policy.

### Acceptance

Include database/concurrency tests for duplicate retry, same idempotency key
with different data, simultaneous receipts, over-receipt policy, paid/free
quantity, package conversion, partial receipt, batch/expiry validation,
quarantine, duplicate invoice, discrepancy resolution, stock/ledger
reconciliation, return/credit partial application, and legacy compatibility.

No receipt path may change stock without producing the same authoritative
receipt, ledger, batch, audit, and idempotency truth.

## 15. Slice 9 — explainable reorder assistance and supplier signals

Build deterministic decision support. Never automate a purchase decision.

### Required capabilities

- A bounded, indexed reorder-candidate query that uses integer base units and
  identifies the available package/procurement level.
- Inventory position calculated from pickable on-hand plus open PO quantity.
  Do not subtract prescription demand as a reservation because current policy
  explicitly has no reservation on prescribing.
- Recent demand/usage rates for 30/60/90-day windows where the history is
  sufficient, with clinic-day boundaries and reversal/correction handling.
- Lead time from the active supplier profile, with a derived actual supplier
  lead-time metric where enough receipt history exists.
- Expected need over lead time plus the approved review interval; approved
  safety buffer; target quantity; final suggested quantity rounded to MOQ/order
  multiple/package rules.
- Clear fallbacks for new, sparse, seasonal, non-moving, recently stocked out,
  substituted, or manually managed products. Missing evidence must not be
  disguised as mathematical certainty.
- An explanation payload that saves or returns the inputs, formula/version,
  window, stock, on-order, lead time, safety, rounding, confidence/data-quality
  flags, and reason for the suggestion.
- User decision history: accepted, adjusted, dismissed/snoozed, reason, actor,
  created PO/line if any, and outcome. The user action is auditable; it must not
  silently retrain an opaque model.
- Views for 30/60/90 usage, inventory position, stockout/expiry risk where
  supportable, last/average purchase price, price change, supplier fill rate,
  actual lead time, and unresolved credits. Use private/internal access
  patterns consistent with the current backend; do not resurrect retired public
  views.
- Avoid duplicate reorder drafts by reconciling accepted suggestions with open
  PO lines.

The baseline formula, subject to owner-approved parameters, is:

```text
pickable_on_hand = saleable, non-quarantined, non-expired base units
on_order = open base units on placed/acknowledged/partially received POs
inventory_position = pickable_on_hand + on_order
daily_use = supported recent net consumption / supported in-stock days
coverage_days = supplier_lead_time_days + review_interval_days
target = daily_use * coverage_days + approved_safety_buffer
raw_suggestion = max(0, target - inventory_position)
suggested_order = round_up(raw_suggestion, MOQ/order_multiple/package rules)
```

Do not blindly divide by calendar days when a product was stocked out, newly
introduced, or inactive; expose the data-quality limitation. Do not call this
AI. It is an explainable calculation.

### Acceptance

Create fixed fixtures for zero stock, open PO, partial receipt, returns,
corrections, free quantity, product inactivity, sparse history, stockout days,
supplier/package change, MOQ, order multiple, and clinic-day boundary. Assert
both quantity and explanation. Include query plans or an equivalent performance
check on representative data.

## 16. Slice 10 — explicit cycle-count scope and opening-count transition

Reduce stock-count ambiguity while preserving blind count and approval
controls.

### Required capabilities

- Freeze explicit scope membership when a count session starts: full clinic,
  chosen location/category, selected items, or a generated cycle-count set as
  approved. A later medicine addition must not invisibly change an open count.
- Record expected scope size without exposing expected quantity to the counter.
- Support package-aware entry converted to integer base units while retaining
  the entered package/unit evidence.
- Provide safe barcode/package resolution for later scan-first counting where
  the existing package catalogue supports it.
- Enforce completeness or explicit authorized omission before submission.
- Preserve blind counting until the approved reveal/review point.
- Separate count, review, approval, posting, and cancellation with actor/time;
  posted adjustments produce normal stock ledger and audit truth.
- Handle concurrent stock movement according to the existing approved count
  policy; do not silently compare against a stale quantity.
- Expose count-due and count-exception read models for the later admin/pharmacy
  UI.
- Model the transition out of opening count so medicine creation cannot remain
  an uncontrolled stock-entry path after rollout.

### Acceptance

Test frozen scope, new medicine during a count, zero counts, omissions,
package conversion, duplicate entry, concurrent sale/receipt, blind reveal,
approval permissions, retry, reversal/correction, and ledger reconciliation.

## 17. Slice 11 — ABDM/ABHA and standards-exchange foundation

This is a policy- and external-standard-gated foundation, not a claim of ABDM
compliance or production integration.

### Required process

1. Research the current official ABDM/NHA sandbox and production documentation,
   applicable Health Facility/Professional Registry requirements, consent
   manager behaviour, Scan & Share flow, ABHA linking, and the currently
   required FHIR profiles. Use primary official sources only.
2. Record exact versions, dates, required credentials/certification, data
   residency/security obligations, and unclear points.
3. Compare the current patient, encounter, practitioner, prescription,
   diagnostic, invoice, and consent schemas with the required resources. Create
   an explicit mapping and gap register; do not assume the names are enough.
4. Obtain/confirm owner decisions for the exact pilot use case. Do not build
   every ABDM workflow at once.

### Foundation capabilities after decisions

- Feature flags/configuration per environment and per workflow; disabled by
  default.
- Facility/provider identity configuration without secrets in source.
- Patient ABHA/identifier linkage with verification status, provenance, and
  unlink/correction history; never replace the clinic's patient ID.
- Versioned consent artefacts and purpose/expiry/revocation/audit.
- An adapter boundary and versioned mapping for only the approved FHIR/resource
  exchange.
- Durable request/outbox, callback/webhook idempotency, correlation, retry, and
  reconciliation.
- Private raw protocol evidence with retention/redaction controls where legally
  required, plus safe operational logs.
- Sandbox contract tests and fixtures that contain no real patient data.

### Boundaries and acceptance

- No production credentials or calls.
- No claim of compliance, certification, interoperability, or Scan & Share
  readiness until the official conformance path has actually passed.
- No bulk upload of existing patient data without separate policy, consent,
  migration, reconciliation, and rollback review.
- If policy, official specifications, or sandbox access block legitimate
  implementation, finish the verified mapping/foundation possible offline and
  report the blocker exactly rather than inventing a protocol.

## 18. Slice 12 — conditional commercial and assistive foundations

Do not start this slice automatically. It is a group of separate optional
slices, each requiring an explicit owner decision and, where relevant, a
selected provider. Split them rather than implementing them together.

### 12A. Payment links and reconciliation

- Provider-neutral payment intent/link with amount, bill, expiry, status, and
  immutable attempts.
- Authenticated/deduplicated webhooks, settlement/reconciliation, fees,
  refunds/reversals, unmatched-payment queue, and idempotent application to the
  existing payment ledger.
- Never mark a bill paid from a redirect alone.
- Provider discovery/provisioning and secrets require separate approval.

### 12B. Teleconsultation

- Appointment modality and provider-neutral meeting reference tied to the same
  appointment, encounter, bill, and follow-up—not a parallel patient record.
- Identity, consent, join/failure evidence, and in-person fallback.
- No recording unless separately approved with lawful consent/retention.

### 12C. Accounting export/integration

- Versioned journal/export mapping from immutable clinic financial facts;
  reconciliation and re-export identity; no duplicate posting.
- Select the target accounting product and mapping only after owner/accountant
  confirmation.

### 12D. Assistive dictation or note drafting

- Draft-only content with provenance, model/config version, data-handling
  approval, clinician review/edit/acceptance, and audit.
- Never autonomously diagnose, prescribe, sign, send, or alter the legal
  clinical record. Do not introduce an AI provider before explicit approval.

### 12E. Specialty packs, multi-provider resources, and expansion modules

Create only after customer evidence and owner scope change. Specialty defaults
must not silently change clinical policy. Multi-provider/room/equipment
scheduling must extend—not fork—the appointment and queue truth.

### 12F. Onboarding, migration, and support diagnostics

- Versioned import jobs with validate/dry-run/apply phases, row-level error
  reports, source provenance, duplicate matching for review, idempotency, and a
  rollback or compensating strategy. Never bulk-import directly into clinical,
  financial, or stock truth from an unchecked spreadsheet.
- A clinic configuration/readiness diagnostic covering only non-secret setup,
  missing required reference data, integration health, backup recency, and
  migration version. It must not expose patient data or credentials.
- A privacy-safe support bundle and operator runbook with explicit owner
  consent. In-product training/help presentation belongs to the later frontend
  programme.

## 19. Frontend handoff required from every completed slice

Backend-first does not mean backend-only documentation. At the end of each
slice, add or update a concise frontend contract containing:

- on-demand query/command name and purpose;
- request and response fields, nullability, units, and version;
- role/permission matrix;
- empty, ready, review-required, working, confirmed, partial, pending, failed,
  outcome-unknown, and stale/degraded states that apply;
- idempotency and retry instructions;
- direct safe next actions and their preconditions;
- audit/result identity that can be displayed after a modal closes;
- privacy/redaction rules;
- example fixtures for the later browser tests.

The later frontend programme should use these contracts to implement the
research recommendations:

- global patient search accessible from every authorized workspace;
- persistent compact patient context;
- role-specific actionable counts and direct exception queues;
- visit progress and safe-exit obligations;
- future calendar and scheduled check-in;
- reminder failures, pending result review, and notification ownership;
- narrow patient actions and document sharing;
- pharmacy purchasing as clear `Needs action`, `Orders`, `Receiving`, and
  `Suppliers` tasks;
- receiving prefilled from the PO and scan-first where supported;
- reorder explanations in human language with accept/adjust/dismiss, never a
  mysterious score;
- explicit cycle-count scope and package entry;
- the existing paper/ink visual language, one consistent icon family, unique
  task icons, sticky actions on task-heavy screens, large touch targets, and
  compact mobile access.

Do not implement those visual changes during these backend slices. Do not add
duplicate mutable fields solely to make a proposed screen easier to draw.

## 20. Scope that must remain out

Do not turn this clinic product into a hospital suite. The following are not
part of this programme:

- inpatient admission/discharge/transfer;
- medication administration record or nurse dose rounds (explicitly deferred
  by owner policy unless the owner reopens the full clinical model);
- operating theatre management;
- full LIMS, analyzer integration, blood bank, RIS, or PACS;
- insurance/TPA/claims;
- hospital HR, payroll, laundry, diet, facilities, or asset management;
- accreditation/document-management suites;
- marketplace, CRM, multi-location, or advanced patient portal by assumption;
- automatic clinical substitution, diagnosis, prescribing, or AI decisions;
- automatic purchase ordering;
- stock reservation at prescription time;
- a second general-purpose backend or a second patient/financial/stock source
  of truth.

## 21. Verification requirements

Run focused tests after every logical change and the slice-specific database,
authorization, idempotency, concurrency, and contract tests before handoff.
When applicable, run:

- the repository typecheck/check command documented in `docs/README.md`;
- focused unit tests;
- the guarded database suite;
- Deno check for all affected Edge Functions;
- the static export build with the safe loopback functions URL specified in
  current documentation;
- existing browser tests as a compatibility regression gate, even though the
  slice adds no new UI;
- `git diff --check`.

Never claim a gate passed if it was skipped, guarded off, pointed at the wrong
target, or only partially ran. Report command, resolved target (without
secrets), result, test count where available, and exact reason for anything not
run.

Each migration-bearing slice requires tests for clean migration, upgrade from
the current schema, constraints/indexes, authorization/RLS as applicable,
idempotent retry, and critical concurrency. Each consequential workflow
requires both happy-path and partial/failure/outcome-unknown coverage.

## 22. Required handoff after each slice

Stop after the assigned slice. Return:

1. outcome in plain language;
2. exact files changed;
3. schema/API/type changes;
4. migrations added and compatibility strategy;
5. owner decisions applied and unresolved decisions not implemented;
6. authorization, privacy, audit, idempotency, and concurrency behaviour;
7. tests/checks run with exact results;
8. checks not run and why;
9. independent review findings and how they were resolved;
10. frontend contract now available for the later UI programme;
11. known limitations or evidence-backed blocker;
12. recommended next slice—without starting it.

Mark a capability implemented only when migration, server command/query,
shared contract, permissions, audit, tests, error states, and current
documentation agree. A table alone, a UI mock, or an untested endpoint is not a
completed capability.

## 23. Current programme entry

Slices 0, 1 and 2 are complete and accepted. The evidence in
`BACKEND_PROGRAMME_REGISTER.md` takes precedence over unverified assumptions in
this original brief. Owner-policy items 65–74 are approved and implemented.

**Slice 3 is next, ready and not started.** D8 to D12c are approved as owner
items 76–83: official Cloud API plus bounded deep-link use, 08:00–20:00 quiet
hours and one-message schedules, channel-and-purpose consent, admin-owned
failure handling and escalation, doctor-released frozen recall cohorts,
immutable doctor-approved templates, explicit opt-out semantics, and
doctor-authored recall eligibility. Slice 2 left `jmc.appointment_events` as
the durable hook and sent nothing. Implement against those owner items and the
decision register rather than reinterpreting this summary. Provider-policy
validation, approved templates, credentials and the clinic privacy notice are
production release dependencies; they do not block building and testing the
provider-neutral backend with no live sends.

This policy-approval pass does not start Slice 3. When explicitly instructed,
Slice 3 is the next implementation slice. Do not start Slices 4–12, deploy, use
live data, or redesign the frontend as part of it.
