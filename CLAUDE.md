@AGENTS.md
@docs/AGENT_IMPLEMENTATION_BRIEF.md
@docs/UI_UX_PLAN.md

# The clinic UI/UX redesign

The direction in `docs/UI_UX_PLAN.md` has been implemented in the working
application. What follows is the record of what was required, how the work was
organised, and the rules that still govern anyone changing it. It is no longer
an open assignment — see **Status** below before starting anything.

Preserve every existing capability, permission, clinical safeguard, inventory
rule, billing rule, and audit trail. Reuse the current backend and command
contracts wherever they already support the intended workflow. When a required
interaction needs missing data or server support, trace the current schema and
types first, then add the smallest complete contract consistent with
`docs/OWNER_POLICY_REGISTER.md` and `docs/SCHEMA_AND_TYPES.md`.

## Status

The redesign in `docs/UI_UX_PLAN.md` is **implemented**. All seven slices are
built and integrated, and the complete gate passes together: `npx tsc --noEmit`,
`npm test` (35), the static export build, `git diff --check`, `npm run
test:browser` (64 journeys), `npm run test:db` (526 tests), and `deno check`
over every Edge Function.

Two things to know before changing any of it:

- **Build with the staging URL on the command itself.** Plain `npm run build`
  reads `.env.local`, which names the live clinic, and leaves `out/` pointed at
  Chennai. Use
  `NEXT_PUBLIC_FUNCTIONS_URL=http://127.0.0.1:54321/functions/v1 npx next build`.
- **`npm run staging:up` reseeds but does not truncate.** A package a test
  built, or stock a test moved, survives it. For a true signal run
  `npm run staging:destroy && npm run staging:up`, which is what
  `npm run test:browser` does for itself.

### Out of scope by owner decision, not unfinished

**Nurse medicine due, given and skipped is deferred from this release.** Owner
policy register item 64, decided 13 September 2026. The clinic continues to
work as it does today: the doctor writes what a patient under observation is to
be given as a free-text observation instruction on the bed
(`set_observation_instructions`), the nurse reads it there, and what happened is
recorded as an observation note in the same timeline (`record_observation`).

This is a decision about clinical scope, and the Due-now workspace is complete
against it. Do not treat it as a gap to fill in: the application has no model of
a medicine administration at any layer, and building one means answering who
orders a dose, what makes it due, what a skip is and which skips escalate,
whether administration moves pharmacy or ward stock, who pays, and what happens
to an unfinished round at handover. Those seven questions are written out under
item 64 in section K of `docs/OWNER_POLICY_REGISTER.md`. **Do not invent any of
them, and do not put a dose list in front of a nurse with no authoritative order
behind it** — that screen's whole value is that everything on it is real.

## Required result

This was the specification, and the application now meets all of it except
where item 64 of the policy register defers a capability. It is kept as the
checklist any later change must still satisfy:

1. A shared, truthful action lifecycle: ready, review when required, working,
   confirmed, partial or pending, failed, and outcome unknown.
2. Action-specific loading states, duplicate-submit protection, slow-request
   messaging, and preserved user input after failure.
3. Timed result overlays for backend-confirmed work, with appropriate icons,
   patient or transaction identity, the important result, immediate dismissal,
   and durable evidence after the overlay closes.
4. A complete modal, drawer, popover, and result-overlay system with focus
   trapping, inert backgrounds where applicable, Escape handling, focus
   restoration, screen-reader announcements, and reduced-motion support.
5. One consistent icon family with short text labels, the existing clinic logo
   in the approved locations, role-specific task icons, and task-specific
   completion treatments.
6. Paper and ink, Night shift, and High contrast themes, with meaning preserved
   across themes and the selected preference stored according to the plan.
7. Direct role landing: doctor on today's queue and consultation flow, nurse on
   Due now, pharmacy on the ready OTC counter with waiting prescriptions inside
   it, and admin on the operational overview.
8. Compact daily navigation with occasional authorized work under More or the
   applicable workspace. Do not remove capabilities or change permissions to
   make navigation look simpler.
9. The unified pharmacy counter: OTC sale, prescription loading into the same
   surface, prescribed and supplied product shown separately, controlled
   substitution, supply, consultation fee, billing, payment, remaining supply,
   balance, receipt, and explicit New sale behavior.
10. The doctor workspace, nurse patient-grouped due workflow, and admin
    consistency pass described in the plan.
11. Responsive and accessible behavior at 1280x800, 1024x768, 768x1024, 390px,
    and 320px, including long names, keyboard navigation, screen readers,
    slow/offline behavior, printing, and partial outcomes.

## Execution order

Follow the implementation sequence in `docs/UI_UX_PLAN.md`:

1. Shared task feedback, overlays, windows, icons, themes, and accessibility.
2. Role-specific landing and navigation.
3. Unified pharmacy counter.
4. Doctor workspace.
5. Nurse workspace.
6. Admin consistency.
7. Full-flow verification and correction.

Finish and integrate each slice before depending on it in the next one. Keep a
live task list tied to these seven slices. Mark an item complete only after its
code is integrated and its relevant checks pass.

## Required use of agents and subagents

Use agents and subagents for bounded work that can proceed independently. The
lead Claude instance owns the shared contract, integration order, final review,
and final test run. Start with parallel read-only audits, then delegate edits in
waves after shared contracts are stable.

### Wave 1: parallel inspection

Delegate these read-only tasks in parallel:

- Shared-system audit: inspect `ClinicApp.tsx`, `clinic-context.tsx`,
  `navigation.ts`, `workspace-router.tsx`, `app/globals.css`, and
  `components/ui/`; map the current shell, busy state, notices, focus behavior,
  responsive navigation, logo, and theme support to the UI/UX plan.
- Pharmacy audit: inspect `checkout-workspace.tsx`, `pharmacy-workspace.tsx`,
  relevant types and commands, and browser tests; identify what can be reused
  for the unified counter and what is missing.
- Clinical-role audit: inspect `consultation-workspace.tsx`,
  `care-workspaces.tsx`, selected-patient state, and relevant tests; map doctor
  and nurse changes without duplicating current capabilities.
- Verification audit: inspect the existing browser, accessibility, database,
  printing, and staging gates; produce a coverage matrix for every UI/UX
  acceptance criterion.

Each inspection agent must report exact files, reusable behavior, missing
behavior, risks, and proposed test coverage. It must not create another general
plan or edit shared files during this wave.

### Wave 2: shared foundation

The lead owns and integrates shared hotspots:

- `components/ClinicApp.tsx`
- `components/clinic-context.tsx`
- `components/navigation.ts`
- `components/workspace-router.tsx`
- `components/ui/`
- `app/globals.css`

Build the shared action-state contract, accessible windows and overlays, icon
and logo conventions, themes, responsive shell, and role landing behavior.
Delegate isolated primitives or independent review when useful, but allow only
one editing owner per shared file at a time.

### Wave 3: role workspaces

After the shared interfaces are integrated, delegate non-overlapping role work:

- Pharmacy agent: own `components/checkout-workspace.tsx` and the relevant
  portions of `components/pharmacy-workspace.tsx`, plus focused pharmacy tests.
- Doctor agent: own `components/consultation-workspace.tsx` and focused doctor
  tests.
- Nurse agent: own the queue/vitals/nursing portions of
  `components/care-workspaces.tsx` and focused nurse tests.
- Admin agent: work on the applicable dedicated admin panels only after the
  lead assigns exact files. `components/shared-panels.tsx` has one editing owner
  because it contains several cross-role surfaces.

An agent may use a narrower subagent for isolated research, test analysis, or
read-only review. Do not let two agents edit the same file concurrently. Every
agent returns a concise handoff containing files changed, behavior completed,
tests run, failures, and assumptions. The lead reviews every diff before
integration and fixes inconsistencies across roles.

### Wave 4: independent verification

Use a verification agent that did not implement the feature to review the
integrated result against every numbered requirement above and every acceptance
gate in `docs/UI_UX_PLAN.md`. Let it identify regressions, inaccessible focus
behavior, false success states, missing pending states, breakpoint problems,
and incomplete role flows. The lead must correct the findings and rerun the
affected checks.

## Safety and validation

- Preserve the user's existing working-tree changes. Inspect `git status`
  before editing and never reset or overwrite unrelated work.
- Read the relevant installed Next.js 16 documentation required by `AGENTS.md`
  before changing Next.js or React integration code.
- Never use the clinic's live backend for development or browser actions. Use
  the guarded scratch staging workflow in `docs/operations/STAGING.md`.
- Do not deploy, push migrations, change production secrets, or mutate clinic
  data as part of this assignment.
- Run focused checks after each slice. At completion run `npm run check` and
  `git diff --check`. Run `npm run test:browser` against guarded staging. If
  backend behavior changes, also run `npm run test:db` and the backend Deno
  typecheck described in `docs/README.md`.
- Inspect the actual rendered application at every required viewport. Verify
  the complete workflows and real state transitions rather than accepting the
  HTML concepts as proof.
- Treat failed checks and verification-agent findings as work to fix. Continue
  until the applicable gates pass or a concrete external blocker makes further
  progress impossible.

The final report must state what changed for each role, how icons, themes,
loading, popups, and completion feedback work, which checks passed, and any
remaining limitation with exact evidence. Do not claim the UI/UX redesign is
complete while a required slice or acceptance gate remains unfinished.
