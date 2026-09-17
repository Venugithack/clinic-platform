# UI/UX implementation plan: daily clinic work

Status: **implemented**, 13 September 2026. Every slice and acceptance gate in this document is built and passing against guarded staging — 56 browser journeys, 316 database tests — with one capability deliberately out of scope: nurse medicine given/skipped, deferred by owner policy register item 64 and described under [Nurse](#nurse) below.

This document was written as the implementation brief for the redesign and is kept as the record of what was asked for and what the application now does. Where it describes a behaviour, that behaviour exists.

Safety integration update, 17 September 2026: the bounded Slice 2 consultation
cutover is implemented in the existing doctor workspace. A held signing attempt
survives reload and visit changes; the doctor can inspect and record Same
attendance, New attendance, or permitted abandonment without exposing internal
reference terminology. This is not the full appointment-calendar UI and does
not start Slice 3 messaging.

**Visual reference:** `docs/design/clinic-visual-workflow.html`. It demonstrates role-specific workspaces and strong completion feedback. It predates the final loading and timed-dismissal rules below and must be updated before it is treated as the finished interaction.

## Contents

1. [Product decision](#product-decision)
2. [Lessons from the earlier platform](#lessons-from-the-earlier-platform)
3. [Current and target prescription flow](#current-and-target-prescription-flow)
4. [Interaction contract for every task](#interaction-contract-for-every-task)
5. [Role workspaces](#role-workspaces)
6. [Windows, drawers and popups](#windows-drawers-and-popups)
7. [Icons, themes and enjoyment](#icons-themes-and-enjoyment)
8. [Shared visual system](#shared-visual-system)
9. [Implementation sequence and acceptance gates](#implementation-sequence-and-acceptance-gates)

## Product decision

The application opens as a working desk for the signed-in role. It does not open on a generic overview for doctor, nurse or pharmacy, and it does not ask staff to choose a module before beginning daily work.

| Role | First screen after sign-in | Primary job visible without navigation | Daily navigation |
| --- | --- | --- | --- |
| Doctor | Today's queue and consultation | Call patient, see identity/alerts/history/vitals, document, prescribe and finish | Today, Consult, Patients, More |
| Nurse | Due now | See patients needing attention, record vitals, work the observation round | Due now, Vitals, Observation, More |
| Pharmacy | Counter ready for an OTC sale | Search/scan medicine, open a waiting prescription into the same counter, supply, bill and collect | Counter, Stock, History, More |
| Admin | Clinic overview | See operational exceptions and move directly to the responsible control | Overview plus grouped People, Operations, Inventory, Finance and Settings |

Occasional capabilities stay authorized and reachable through **More** or the relevant workspace. They do not compete with the primary job on every screen.

## Lessons from the earlier platform

The earlier `hospital al in one platform` prototype has fewer capabilities, but its role screens are easier to operate because they begin with the work rather than the software structure.

- The doctor sees the queue beside the current patient, chart and consultation.
- The nurse sees **Due now**, grouped by patient, with vitals and medicine actions in place.
- The pharmacist sees the prescription counter and the next prescription immediately.
- The role name remains obvious without consuming a wide navigation rail.

The redesign carries that operating model forward while retaining the current application's stronger permissions, database records, billing, inventory, prescription validity, partial supply, payments and audit history.

The earlier interface is a reference, not a screen to copy pixel for pixel. Its doctor consultation becomes extremely long, some text and controls are too small, and it relies heavily on uppercase labels. The new interface keeps its compact working-desk layout, then adds better grouping, readable type, responsive behavior and focused drawers for supporting detail.

The governing rule is: **after sign-in, the next patient or task is already in front of the staff member.**

## Current and target prescription flow

### Current behavior

1. Pharmacy signs in to **Overview** and must navigate to **Counter**.
2. Counter opens **Hand over a prescription** by default.
3. Waiting prescriptions, OTC sale and payment appear as three separate stations.
4. Opening a prescription shows its items and defaults **Give now** to the remaining prescribed quantity.
5. Confirming the hand-over allocates stock, charges what was actually supplied and opens the patient's bill for payment.
6. OTC sale begins on another station with a separate blank basket.

The backend already supports a controlled substitution during `dispense_rx`: the prescribed order must be generic, the offered product must map to the same clinical drug, and the pharmacist must record a reason. It refuses a different clinical drug and a brand-specific substitution. The current counter interface does not expose the substitute product and reason fields, so this supported capability is not usable from the screen.

### Target behavior

Pharmacy lands directly on one counter ready for an OTC sale. Search or scanning is immediately available, and a persistent **Prescriptions waiting** control is visible on the same screen.

Opening a prescription changes that counter into clearly labelled prescription mode and fills:

- patient identity and prescription number;
- doctor and signed date;
- prescribed products and directions;
- quantities already supplied and quantities remaining;
- suggested **Supply now** quantities;
- consultation fee, existing bill and amount due.

Each medicine row keeps **Prescribed** and **Product supplied** separate. Changing the supplied product never edits the signed prescription. The selector offers only backend-verified equivalents; selecting one requires a reason and records the substitution. Anything outside that narrow rule shows **Doctor amendment required**.

OTC items may be added while serving a registered prescription patient, but the interface continues to identify prescription supply and OTC sale as different recorded events. The patient sees one understandable amount due at checkout.

## Interaction contract for every task

Every task moves through the same truthful states:

```text
Ready -> Review when needed -> Working -> Confirmed result
                                  |            |
                                  |            +-> timed dismissal + persistent saved status
                                  +-> Failed or outcome unknown -> keep work and explain the next step
```

### Working state

- Change the pressed action to the exact present-tense operation: **Saving vitals…**, **Completing consultation…**, **Handing over medicines…**, **Receiving payment…**.
- Disable controls that could change or repeat the in-flight operation. Keep navigation available only when leaving cannot create an ambiguous result.
- Cover the affected work panel with a quiet loading layer. Use a full-workspace loading screen only during sign-in or when the workspace has no safe content to show.
- If the request takes longer than four seconds, change the message to **Still saving—do not repeat this action**. Do not show invented percentage progress.
- Background refresh uses a small connection indicator and never blocks active work.

### Confirmed result

- Show a large checkmark or task-specific icon, the completed action, the patient or transaction identity, and the important result. This is the same clarity as a successful payment screen, expressed in the clinic's visual language.
- Show success only after the backend confirms the saved record. Animation cannot get ahead of the record.
- Routine results remain for about 2 seconds. Consult completion, medicine hand-over and payment remain for about 3 seconds because staff must read the patient or amount. The user can dismiss them immediately.
- Dismissing the result never erases the evidence. The queue row, patient timeline, bill, stock count or audit row keeps a compact completed status.
- Do not automatically select the next patient or start another transaction. After dismissal, place focus on a clear **Next patient**, **New sale** or **Return to queue** action.
- Respect reduced-motion settings. Use a short check draw/scale once; do not use confetti, looping animation or decorative motion.

### Partial, pending and failed results

- Partial payment, partial medicine supply, a refused supplier credit, stock written off and saved-but-unsigned drafts are not green completion states. Use amber with the exact remainder or next responsibility.
- Failure never auto-dismisses. Keep all entered work, name what failed and provide **Try again** only when retrying is safe.
- If the request may have reached the server but confirmation was lost, show **Outcome not confirmed** and check the saved record before enabling the action again. Reuse the existing idempotency protection for dispense, sale and payment commands.
- State meaning with an icon and words. Color alone never communicates success, pending work or failure.

## Role workspaces

### Doctor

The doctor lands on today's queue. Calling a patient opens the consultation beside the queue with a persistent patient band containing token, name, age, allergy/clinical alerts, latest vitals and draft status. History stays beside the current work on wide tablets and opens from the patient band on narrower screens.

- **Call patient:** row-level **Opening consultation…**, followed by the selected patient band. This is navigation feedback, not a success celebration.
- **Save draft:** button-level spinner, then a small two-second check with **Draft saved · Still unsigned**. The draft badge remains.
- **Finish consultation:** review sheet first, then a blocking **Completing consultation…** state. Show **Consultation completed** with patient, token, prescription number or **No medicines prescribed**, fee, and handoff to the counter. Auto-dismiss after about three seconds; leave **Next patient** and **View summary**.
- **Prescription:** remains the doctor's immutable order after signing. Pharmacy supply or substitution never silently edits it.

### Nurse

The nurse lands on **Due now**, grouped by patient rather than by module. Each group shows bed/token, last readings, missing readings, observation checks that are due or overdue, doctor handoffs, and one contextual action per task.

- **Save vitals:** block the vitals panel with **Saving vitals…**. Show **Vitals saved** with patient, recorded values and any measurements not taken. Auto-dismiss after about two seconds; the row shows the recorded time and leaves the due list when appropriate.
- **Observation update:** show the recorded observation and the next due time. Urgent or overdue work remains visible after the popup closes.

> **Medicine given and skipped are deferred from this release.** Owner policy register item 64, decided 13 September 2026. The clinic continues to work the way it works today: the doctor writes what the patient is to be given as a free-text observation instruction on the bed, the nurse reads it there, and what happened is recorded as an observation note in the same timeline.
>
> This is a clinical-scope decision and not an unfinished screen. The application has no model of a medicine administration at any layer — no order, no schedule, no due time, no given or skipped event — and the eight clinical questions a later release must answer first are written out under item 64. Due now is complete against the decided scope: every task it shows has an authoritative record behind it, which is the property that makes it worth trusting on a round.

### Pharmacy

The pharmacist lands on one counter ready for an OTC sale. A persistent **Prescriptions waiting** area opens a prescription into the same counter instead of sending the pharmacist to another module.

```text
Counter                                      Prescriptions waiting (4)
[ Scan or search medicine                                  ] [Add]

Patient / walk-in band
Prescribed item | Supply now | Product supplied | Stock | Price
---------------------------------------------------------------
Consultation fee                                      amount
Medicines                                             amount
Due                                                   amount
                                      Review and complete
```

- **OTC sale:** starts with an empty search/scan field in focus. Adding and changing basket items is local draft state and shows no success popup.
- **Open prescription:** fills patient, signed prescription items, remaining quantities and existing bill. The screen clearly changes to **Prescription [number]** mode.
- **Change product supplied:** keep the prescribed medicine visible and record the supplied product separately. Offer a substitute only when the backend can prove it is the same clinical drug and the prescription permits it. Require a reason. Brand-specific or non-equivalent changes stop with **Doctor amendment required**.
- **Hand over:** show **Handing over medicines…** while stock and invoice lines are committed. Then show **Medicines handed over** with patient, dispense number, supplied items, remaining quantities and amount added to the bill. Auto-dismiss after about three seconds and keep the dispense/bill status visible.
- **Payment:** show **Receiving [amount]…** followed by a large payment result. Full payment is green with amount, method, receipt number and **Balance ₹0**. Part payment is amber with amount received and balance due. Pay later is amber and never says completed.
- **New sale:** clears the counter only when the pharmacist chooses it. Closing the success popup does not silently replace the completed transaction with a blank basket.

### Admin

Admin keeps a detailed, grouped interface because the role investigates exceptions across the clinic. The first screen is an operational overview: people waiting, unfinished consultations, observation tasks, prescription/stock attention, money due and failed or unconfirmed operations.

- Filters, searches and opening records use inline loading or skeleton rows; they do not trigger success popups.
- Saved settings, staff changes and routine corrections use a small two-second success result plus a persistent updated value.
- Financial corrections, voids, stock adjustments, account changes and other consequential actions require a review step, a blocking action-specific loading state and a result that names exactly what changed and who/what it affected.
- Admin results remain in the activity/audit record after the popup closes. Exceptions stay visible until resolved rather than disappearing because they were opened.

## Windows, drawers and popups

Popups shorten a focused decision while preserving the patient or transaction behind them. They do not contain whole workspaces.

| Pattern | Placement and behavior | Appropriate use |
| --- | --- | --- |
| Main workspace | Full available content area | Queue, consultation, due-now round, pharmacy counter, reports and large tables |
| Right-side drawer | Opens over part of the workspace; becomes full-screen on narrow devices | Patient history, vitals entry, prescription details and supporting context |
| Center modal | Short form or review; background is inert; focus returns to its trigger | Finish consultation review, observation and discharge confirmation, substitution reason, payment and consequential admin actions |
| Small popover | Anchored to the control that opened it | Theme choice, filters and compact options |
| Result overlay | Centered above the unchanged workspace; dismissible and timed according to the interaction contract | Backend-confirmed consultation, vitals, hand-over, payment and consequential admin results |
| Full-workspace loading state | Replaces the workspace only when no safe content exists yet | Sign-in and initial clinic loading |

Role placement:

- **Doctor:** history in a drawer; final consultation review in a modal; completion in the result overlay. The consultation itself remains in the workspace.
- **Nurse:** vitals in a drawer; observation notes, handoff and discharge in a compact confirmation modal; the due list remains visible behind it.
- **Pharmacy:** waiting prescriptions remain part of the counter; substitution and payment use focused modals; the result overlay confirms hand-over or payment.
- **Admin:** editing and consequential adjustments use drawers or modals; overview, reports and investigation tables remain in the workspace.

When a modal or drawer submits, its own surface shows the loading state. The whole application does not blank or jump. Long forms, queues and reports are never placed inside nested popups.

## Icons, themes and enjoyment

The paper-and-ink appearance remains the product's default identity. Enjoyment comes from quick recognition, responsive controls and satisfying truthful feedback rather than decoration.

### Icon system

- Use one consistent icon family with similar stroke weight and optical size.
- Pair every task and navigation icon with a short text label. Icons never become the only source of meaning.
- Use a stethoscope or consultation sheet for doctor work, a pulse/thermometer/bed for nurse work, a prescription sheet and medicine pack for pharmacy, and people/inventory/finance symbols for admin.
- Loading uses restrained movement related to the action. Completion may transform the task icon into a checkmark: a pulse settles into a check for vitals, a signed sheet receives a check for consultation, a medicine pack moves into a bag for hand-over, and a rupee circle resolves to a check for payment.
- Use the clinic logo on sign-in, the main identity area, printouts and receipts. Do not repeat it on every panel.
- Do not invent patient portraits. Use initials or the patient token when a compact visual identifier is useful.

### Theme options

Offer three purposeful choices:

1. **Paper and ink:** warm paper, dark green ink and white work surfaces. This is the default.
2. **Night shift:** low-glare dark surfaces with readable warm text for dim rooms.
3. **High contrast:** stronger boundaries, text contrast and focus indicators.

The theme follows the staff account on shared tablets, with the device setting as the sign-in fallback. Themes may change surfaces, text and borders; they do not change meaning. Confirmed remains green, pending/partial remains amber, and failure/blocked remains red in every theme. Icons, words and status shape continue to carry the same meaning without color.

Motion is brief and connected to an action. Respect reduced motion, avoid looping decoration, and do not add confetti or sound by default. The memorable moment is successful task completion, not constant animation.

## Shared visual system

The patient or transaction band is the memorable visual element. Keep the surrounding workspace compact, calm and left-aligned. Avoid a dashboard made from equally prominent cards.

| Token | Value | Use |
| --- | --- | --- |
| Workspace | `#F0F5F3` | Quiet area around active work |
| Surface | `#FFFFFF` | Patient band, forms and result layer |
| Text | `#213B32` | Primary text |
| Secondary text | `#586E63` | Supporting labels and units |
| Confirmed | `#176751` | Completed action and primary control |
| Pending | `#A35C00` | Partial, refused or still-due work |
| Failure | `#B42318` | Failed or blocked work |
| Divider | `#D6E2DB` | Information boundaries |

Keep Archivo, move controls and labels to sentence case, use at least 16px for entered values, and reserve tabular numerals for quantities, measurements and money. Loading and result layers use `role="status"`/live announcements; blocking confirmations and failures manage focus as dialogs.

## Implementation sequence and acceptance gates

1. **Shared task feedback:** implement the action state model, panel loading layer, result overlay, persistent status treatment, focus management and reduced motion. Wire success to confirmed command responses only.
2. **Role landing:** route doctor, nurse and pharmacy directly to their primary workspaces after sign-in. Retain Admin Overview. Move occasional destinations under More without changing permissions.
3. **Unified pharmacy counter:** combine OTC draft, waiting-prescription opening, controlled substitution, supply, billing and payment on one patient-preserving surface.
4. **Doctor workspace:** combine queue, patient context, consultation, prescription, review and completion handoff.
5. **Nurse workspace:** build the patient-grouped due list with vitals, medicine and observation feedback.
6. **Admin consistency:** apply the shared feedback states and compact visual language to admin controls while retaining grouped detail.
7. **Full-flow verification:** test each role from sign-in through completion at 1280×800, 1024×768, 768×1024, 390px and 320px; verify keyboard and screen-reader announcements, slow/offline responses, duplicate-tap prevention, long names, printing, partial outcomes and role permissions.

The redesign passes only when each non-admin role can begin its main job immediately after sign-in, finish it without visiting another module, see an unmistakable backend-confirmed result, and find durable evidence of that result after the overlay disappears.

## What the current implementation already gets right

- Selected-patient context survives movement between Queue, Vitals and Consult.
- Consult includes a sticky patient band, allergy flags, previous visits, server-backed drafts and a sticky action area.
- Shared buttons have minimum heights of 44 or 48 pixels; main care actions use 56 pixels.
- Counter separates signed prescriptions, supply, billing and payment, and supports partial supply and payment exceptions.
- Admin navigation is already grouped. Keep role permissions and existing capabilities intact while improving their presentation.

The old current-state table in `docs/reference/PRODUCT_UX_DISCOVERY.md` predates many of these improvements. It should not be used as a list of features still missing.

## Findings to address

| Finding in current source | Practical consequence | Proposed direction |
| --- | --- | --- |
| `components/navigation.ts` lists 9 doctor, 6 nurse and 14 pharmacy destinations. | Occasional tasks compete with the patient workflow. | Three or four daily destinations per clinical role. Keep other authorized capabilities in a clearly labeled secondary menu. |
| `.eyebrow` in `app/globals.css` uses 11px uppercase text with 0.16em tracking; buttons and navigation repeat this treatment. | Important labels have low visual prominence and long words consume space. | Sentence-case field and action labels, 13–14px labels, 16px inputs, and 18–22px patient names. Preserve tabular numerals for aligned values. |
| The shell header and workspace `PageHeader` both identify the current screen. WhatsApp configuration appears in every role's shell header. | Repeated headings and setup status consume space above the patient. | One workspace title. Show integration setup status where staff can act on it. Use the shared header for clinic identity, role and actual connection state. |
| Consult's history column starts at `xl` (1280px). At 1024px the 212px rail is present, but history falls below the form. | A common landscape tablet layout loses the intended simultaneous patient context. | Choose the split based on available workspace width. At narrower widths expose a compact history disclosure near patient identity. Validate at 1280×800, 1024×768, 768×1024 and 390px. |
| `components/ui/Modal.tsx` declares a modal, but only moves focus and handles Escape. It does not trap focus, restore the trigger, or make the background inert. | Keyboard users can reach controls behind a displayed modal. | Use native dialog behavior or an equivalent complete focus/inert implementation. Verify opening, Tab/Shift+Tab, Escape and closing. |
| The mobile navigation drawer is translated offscreen, without hidden/inert behavior or managed focus. | Offscreen navigation can remain in keyboard order. | Make closed navigation inert and provide focus management when the menu opens and closes. |
| Failed background refreshes share the global action notice; the shell has no last-successful-update indicator. | Staff cannot readily distinguish a stale queue from a recently refreshed one. | Announce connection/refresh status separately and clearly distinguish an old snapshot from confirmed saved work. |

## Earlier concept record

The sections below preserve the source review and the two discussion concepts. Where they differ from the implementation plan above, the implementation plan is authoritative.

### First visual direction

Keep Archivo as the existing type family. Use readable case and a smaller set of sizes before considering a font change. Use a calm green active color tied to the clinic's existing green ink/status family. Reserve amber and red for attention and risk. Avoid coloring every section.

| Token | Proposed light value | Use |
| --- | --- | --- |
| Workspace | `#F0F5F3` | Surrounding work area |
| Surface | `#FFFFFF` | Patient band and work sheet |
| Text | `#213B32` | Primary text |
| Secondary text | `#586E63` | Supporting labels and units |
| Primary action | `#176751` | Current location and main action |
| Divider | `#D6E2DB` | Quiet boundaries |

The concept also includes corresponding dark colors for the conversation preview. A production dark-mode requirement has not been decided.

```text
Clinic identity                         Staff / connection
Today             Consult             Patients        More

Consultation                              Draft state
Token | Patient / age | Allergy / alerts
Vitals with values and units

Current visit                         Previous visit
  Complaint, diagnosis                Compact summary
  Examination disclosure              Patient history
  Prescription
  Advice and follow-up

Save status                  Save draft    Review / finish
```

The single memorable visual element is the patient band. Keep the work sheet quiet and readable. Use left alignment, consistent field spacing and one prominent action per task. Wide layouts keep history beside the work; narrow layouts should bring it into a disclosure close to the patient band. The inline concept stacks context at narrow widths so the discussion remains readable without internal scrolling; sticky viewport behavior must be evaluated in the actual application.

### Earlier role-specific discussion

- **Doctor:** Today, Consult and Patients. Keep allergies, patient identity and current draft state visible. Favourites should reduce typing without choosing treatment. Integrate recent history close to the current visit. Keep templates and review requests reachable without making them permanent competing destinations.
- **Nurse:** Queue, Vitals and Observation, with patient registration available from Queue. A queue row shows the patient, arrival/wait state and one contextual next action. Keep units attached to every measurement and missing readings explicit.
- **Pharmacy:** This earlier version separated Prescriptions, Counter and Stock. The final direction integrates waiting prescriptions into the Counter, with Stock, History and More as navigation. Keep the selected patient while moving from quantities supplied to bill and payment. Show the consultation fee separately and retain it when medicine quantity is zero. Label remaining medicine quantities and money due separately.
- **Admin:** Retain grouped navigation and detailed controls. Clinical simplicity must not hide finance exceptions, pending approvals or inventory review work from the people responsible for them.

### Discussion concept

`docs/design/clinic-workspace.html` provides a self-contained interactive concept with a workspace selector, daily navigation, patient selection, draft fields, optional clinical context, vitals entry and a counter quantity/payment illustration. All patients, quantities, fees and measurements are illustrative. The workspace selector compares roles in the design; it is not a proposed way to grant or switch production permissions.

The concept makes no API calls and does not sign, save clinical records, dispense or collect payments. Secondary-menu destinations are shown as information architecture examples, not implemented feature screens. It is not a prescription composer or a clinical decision aid.

### Earlier implementation order

Superseded by **Implementation sequence and acceptance gates** above, which begins with shared task feedback and role landing, then implements the unified pharmacy counter before the doctor, nurse and admin passes.

### Earlier questions for the design discussion

1. Does this calmer, lighter direction fit the clinic, or should the current ledger appearance remain stronger?
2. Is the three-destination daily navigation right for each clinical role, including days when one person covers another role?
3. On the doctor's tablet, which information must always be visible: full previous-visit context, recent vitals, or more space for prescribing?

These are design preferences, not a request to repeat the existing owner-policy approvals.

### Concept validation

The concept was opened in an isolated headless browser with outbound API requests blocked. The connected in-app browser was unavailable. Checked the doctor and pharmacy layouts at 736px, pharmacy and nurse navigation at 360px, light/dark appearances, visible control heights, draft editing and the counter quantity/payment illustration. Those inspected layouts had no horizontal overflow; measured visible buttons, inputs, selects and disclosures met the 44px minimum. Changing medicine supply to zero retained the illustrative ₹200 consultation fee. No browser runtime errors were reported in the checked views.

Application workflows, physical tablets, the on-screen keyboard, production printing and a production dark theme were not tested or changed in this discussion pass.

### Owner feedback that led to the implementation plan

The owner identified four requirements during this discussion:

1. Staff need an unmistakable signal when a process finishes.
2. Every non-admin role should be simple. Admin can retain detailed controls.
3. The interface should use recognisable visuals, including the clinic logo and icons, alongside concise labels.
4. Every saved task needs a clear working state and an appropriate result that dismisses after it has been read while leaving durable evidence behind.

The second concept opens on an illustrative completed consultation so the completion treatment is immediately visible. Select **Next patient** to try a visit, or change **View as** to compare nurse and pharmacy tasks. All actions are simulated and all records are examples. Each role demonstrates its own example workflow; these are not synchronized backend records.

#### Completion is a visible state

| Action | Immediate feedback | Persistent outcome |
| --- | --- | --- |
| Save draft | Checkmark on the button and “Draft saved · Still unsigned” nearby | The visit stays unfinished. Editing changes the status back to unsaved. |
| Save vitals | Saving state with repeat submission disabled | Large checkmark, “Vitals saved”, patient/token, recorded and missing reading counts, and next patient. |
| Finish consultation | Review first, then saving state | Large checkmark, “Consultation completed”, saved visit details and the next handoff. |
| Receive full payment | Review supply and money, then saving state | “Payment received”, amount received and zero balance. Remaining medicine supply is still shown if applicable. |
| Receive part payment | Review the amount actually received | “Part payment received”, outstanding amount and unsupplied medicine in amber. |
| Pay later | Review without recording a payment | Amber clock, “Payment pending”, amount still due and unsupplied medicine. No full-completion signal. |

The checked concept kept major task results visible until the user chose the next action. The final implementation changes this to the timed result overlay specified above. It still does not silently select another patient. Queue rows retain a checkmark or a pending indicator, and pharmacy counts distinguish new, pending and complete. When all new work has been reviewed but balances or supply remain outstanding, the queue says that pending work remains.

The concept uses a persistent screen-reader status region for completion announcements. While a task is saving, controls are disabled to prevent repeat submission or changes to the in-flight form. The next-patient action receives keyboard focus without scrolling past the result.

When implementing this in the application, show completion only after the backend confirms the actual outcome. Derive it from the saved visit, dispense and payment records. A network timeout must not produce a completed signal or a blind retry that could duplicate an action. Preserve the entered work and distinguish an unconfirmed result from a confirmed failure.

#### Simple roles and meaningful visuals

- Doctor: **Today**, **Consult**, **Patients**.
- Nurse: **Queue**, **Vitals**, **Observation**.
- Pharmacy: **Counter**, **Stock**, **History**, **More**, with waiting prescriptions inside Counter.
- Admin: retain grouped navigation and detailed configuration, finance, inventory and audit controls.

Use the existing clinic logo, icons with short labels, patient token blocks, observation-bed icons, measurement icons and a visual Arrival → Vitals → Consult → Counter progression. The completion mark is deliberately larger than a navigation icon. Checkmarks, clocks and written statuses make meaning available beyond color alone. Patient portraits are not invented.

Occasional functions belong within the relevant workspace or a contextual disclosure. This is a proposal for where capabilities appear, not a change to who is authorized to use them. Preserve the existing doctor fallback registration/vitals capabilities and the approved pharmacy and admin boundaries.

The revised doctor example is a consultation without prescribed medicine, chosen to demonstrate completion without adding a new prescription editor. Actual implementation must retain the existing full composer, clinically necessary patient context, signing checks and print flow. The simplified mockup is not a complete replacement specification for those features.

#### Revised concept verification

- Loaded the embedded clinic logo and all icons successfully in an isolated headless browser.
- Checked the rendered queue, consultation and result at 736px; checked the nurse result at 360px in dark appearance with no horizontal overflow and no visible control below the 44px minimum.
- Verified draft saving stays distinct from completing a visit, saving disables controls, results are announced, next-patient selection changes patient, and completed queue marks persist.
- Verified two recorded nurse readings remain two recorded readings, with the other two explicitly not measured.
- Verified full checkout receives the illustrative ₹320 with zero balance, zero medicine supply with pay-later retains ₹300 due and ten tablets pending, and five tablets supplied with ₹200 received leaves ₹110 and five tablets pending.
- Verified the final pharmacy queue counts **0 new / 2 pending / 1 complete** for those three scenarios.
- Confirmed the final result icon renders at 44px and navigation icons at 23px. JavaScript syntax checks passed and no application runtime errors were reported in these checked flows.

An additional 320px check was not run: automatic approval review rejected that browser command because the account usage limit was reached. The implementation and the completed checks above remain available. The final icon-size adjustment was inspected at 736px; its appearance at 320px remains unverified.
