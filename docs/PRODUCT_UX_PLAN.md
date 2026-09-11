# Jayamurugan Clinic product and UX improvement plan

**Status:** Discovery draft for owner review  
**Prepared:** 10 September 2026  
**Scope:** Doctor, nurse, pharmacy, admin, inventory, dispensing, billing,
printing, and clinical images

This plan consolidates the clinic owner's feedback and the repository review
performed during the design discussion. It describes the product to build, the
order in which to build it, the safety boundaries, and the decisions that must
be confirmed before implementation. It does not authorize a production
migration or change any application behaviour.

The evidence base and refined data design for diagnoses, aetiology, medicine
identity, package SKUs, barcodes, and batches are in
`CLINICAL_TERMINOLOGY_AND_MEDICINE_DATA_RESEARCH.md`. Where that research is
more specific, it supersedes the earlier shorthand in this plan.

## 1. Product outcome

Jayamurugan Clinic should feel like four focused workbenches sharing one
accurate clinical and financial record:

- The doctor should complete a normal consultation in one workspace with very
  little typing.
- The nurse should move patients through arrival, triage, vitals, and
  observation without administrative detours.
- The pharmacist should see a live work queue and record exactly what was
  dispensed, including the consultation fee and medicine charges, and paid.
- The admin should retain a detailed control centre for configuration,
  inventory, finance, audit, imports, and reporting.
- Any authorized clinician should be able to keep the clinic moving when
  another staff member is absent. In particular, the doctor must be able to
  register a patient, add them to the queue, and record vitals.

The guiding flow is:

```text
Arrival -> Vitals -> Consultation + signed prescription -> Pharmacy Counter
        -> Consultation fee + medicines actually supplied -> One or more payments
```

Prescription, dispensing, billing, and payment are connected but separate
records. That separation is the basis for partial dispensing, split payments,
pay-later balances, correct inventory, and a trustworthy audit trail.

## 2. Confirmed owner requirements

The following requirements came directly from the clinic-owner discussion and
are treated as confirmed product direction:

1. Clinical-role screens must remain minimal. Admin screens may be more
   detailed because administration is the user's primary job there.
2. The doctor needs a one-workspace consultation with previous-visit summary,
   favourites, templates, quick prescriptions, and follow-up reminders.
3. The doctor wants dropdowns, autocomplete, and predictive text to reduce
   typing.
4. The nurse needs fast arrival, triage, vitals, abnormal-reading visibility,
   observation timers, and clear doctor handoff.
5. The pharmacist needs a live prescription queue, FEFO guidance, partial
   dispensing, substitution requests, barcode support, billing, and receipt
   printing in one flow.
6. Medicine packaging must support tablets, strips, boxes, packs, and loose
   units, as well as bottles, tubes, vials, pieces, and other real products.
7. A patient may take all, some, or none of a signed prescription.
8. A patient may need a physical prescription whether or not medicine is
   dispensed by the clinic.
9. A patient may pay in full, pay partly, split payment between cash and
   GPay/UPI, or pay later.
10. When the nurse is absent, the doctor must be able to register the patient
    and record vitals without changing accounts.
11. The patient record needs secure before, progress, and after clinical
    images.
12. The doctor's consultation fee is collected at the pharmacy counter,
    including when the patient does not purchase medicines from the clinic.
13. Staff sign-in uses a four-digit numeric PIN instead of the current
    six-digit PIN.
14. The first release uses English only for the interface, autocomplete,
    templates, clinical phrases, and printed prescriptions. Tamil and bilingual
    support are deferred.
15. Doctors manage their personal clinical templates. Only the owner-doctor or
    another explicitly authorized doctor may publish clinic-wide templates;
    non-doctor admins cannot edit their clinical content.
16. Unsigned consultation drafts survive sign-out and tablet changes for the
    responsible doctor, remain unavailable to pharmacy, and show a stale-draft
    warning after seven days.
17. Prescription printing is requested after signing, uses a physical signature
    area in the first release, and records every reprint.

## 3. Current-state findings

The existing application has broad functional coverage and several sound
foundations: touch-sized controls, role-aware navigation, append-only stock
movements, FEFO allocation, a patient record loaded on demand, native tablet
printing, audit events, and a revision-based refresh loop.

The gaps are structural rather than cosmetic:

| Area | Current behaviour | Required change |
|---|---|---|
| Navigation | Admin has 15 top-level destinations and pharmacy has 10 | Group admin functions; give each clinical role 3-4 task destinations |
| Doctor flow | Queue, patient, vitals, consultation, history, and print are separate interactions | Open the selected queue patient directly in one consultation workspace |
| Doctor fallback | Doctor can create patients and record vitals at the command layer, but cannot create an appointment and has no doctor-facing vitals workflow | Give doctor the complete quick check-in capability and contextual vitals panel |
| Consultation input | Diagnosis, notes, advice, dosage, and instructions are mostly free text; medicine is a long select | Add structured fields, searchable autocomplete, quick choices, favourites, and draft templates |
| History | A simple encounter list appears beside the form | Add a compact last-visit summary and deliberate access to full history |
| Prescription | Items are stored as JSON and the prescription has one `dispensed_at` value | Normalize prescription lines and support multiple dispense events |
| Dispensing | One button dispenses every line in full | Enter the quantity supplied for each line and preserve the remaining quantity |
| Billing | A bill is only unpaid or paid, and the consultation-fee collection point is not explicit | Route the consultation fee to the pharmacy counter and derive unpaid, part-paid, and paid from payment entries |
| Payment | One payment method is stored on a bill or OTC sale | Support multiple payments, methods, later collection, correction, and balance |
| Staff sign-in | Staff enter a six-digit numeric PIN | Use a four-digit PIN with server-side attempt limits, weak-PIN rejection, individual attribution, and session revocation on reset |
| Inventory | Medicine has a free-text stock unit; receipt takes a raw quantity | Define a base stock unit and batch-specific package conversions |
| Batch pricing | Batch has numeric prices but no explicit price/package basis | State whether MRP and purchase price apply to a tablet, strip, box, bottle, etc. |
| Print | Printing is based on the visible page and generic print rules | Produce dedicated prescription, dispensing, bill, and receipt documents |
| Clinical images | No image or attachment model exists | Add private object storage plus encounter-linked metadata and consent |
| Testing | Four unit tests and no browser/database workflow suite | Add unit, integration, concurrency, role, browser, print, and device tests |
| Development safety | Local development currently points to a deployed backend and can modify live data | Establish a staging database/functions project and realistic seed data first |

## 4. Product principles

### 4.1 Work follows the patient

The patient remains selected as staff move through vitals, consultation,
dispensing, billing, and follow-up. Staff should not repeatedly search for the
same patient or re-enter the same context.

### 4.2 Roles control authority, not artificial handoffs

The interface stays role-specific, but capabilities overlap where the clinic
needs resilience. Doctor access includes quick registration and vitals. An
admin account does not automatically gain authority to sign a prescription;
the person must also hold the doctor role.

### 4.3 Normal work is short; exceptions are explicit

The common path uses sensible defaults and large primary actions. Partial
dispensing, due balances, corrections, substitutions, and unusual packaging
remain visible when needed without cluttering the common path.

### 4.4 Suggestions never become clinical decisions

Autocomplete and predictive text may find known diagnoses, medicines, and the
doctor's own phrases. Templates load visible drafts. The system does not
diagnose, select a medicine, approve a substitution, or sign anything for the
doctor.

### 4.5 Clinical and financial history is append-only

A signed prescription is immutable. Dispensing, payment, refund, stock
adjustment, and image-annotation history is added as events. Corrections use
reversals or compensating entries with an actor, time, and reason.

### 4.6 The interface speaks in physical clinic language

Use labels such as `Give now`, `Remaining`, `Receive boxes`, `Record part
payment`, and `Print prescription`. Avoid implementation language such as
`transition`, `allocation`, or `payload` in staff-facing copy.

## 5. Information architecture and permissions

### 5.1 Doctor

Top-level navigation:

1. **Today** - queue, doctor-presence state, follow-ups, and unfinished drafts.
2. **Consult** - the active patient's complete consultation workspace.
3. **Patients** - search, clinical record, images, and follow-up history.

Contextual actions available from Today and Consult:

- Find patient
- Quick-register patient
- Add to today's queue
- Record or update today's vitals
- Print prescription
- Open previous visit

### 5.2 Nurse

Top-level navigation:

1. **Queue** - arrivals, waiting, ready, in consultation, completed, no-show.
2. **Vitals** - quick triage for the currently selected patient.
3. **Observation** - beds, timers, checks, and doctor handoff.
4. **Patients** - find or register a patient.

### 5.3 Pharmacy

Top-level navigation:

1. **Prescriptions** - waiting, part-dispensed, completed, and exceptions.
2. **Counter** - consultation fee, prescription supply, OTC basket, bill,
   payment, and receipt.
3. **Stock attention** - low stock, expiry, delivery awaiting entry, and count
   discrepancies.

Supplier configuration, CSV import, and full inventory reporting should not
interrupt this daily workspace.

### 5.4 Admin

Admin may remain powerful, but the current flat list should become grouped
navigation:

```text
Admin
|-- Dashboard
|-- People and access
|   |-- Patients
|   `-- Staff and roles
|-- Clinic operations
|   |-- Queue and observation
|   |-- Registers
|   `-- Activity audit
|-- Inventory
|   |-- Medicines and package definitions
|   |-- Batches and receiving
|   |-- Expiry, returns, and write-offs
|   |-- Stock-take
|   |-- Suppliers and orders
|   `-- Valuation and movement reports
|-- Finance
|   |-- Bills and payments
|   |-- Patient balances
|   |-- Day book and till
|   `-- Corrections and refunds
`-- Clinic settings
    |-- Letterhead and fees
    |-- Printing
    `-- Imports and exports
```

### 5.5 Capability matrix

`Yes` means included by default. `Owner decision` requires explicit sign-off.

| Capability | Admin | Doctor | Nurse | Pharmacy |
|---|---:|---:|---:|---:|
| Configure clinic/staff | Yes | No | No | No |
| Register/find patient | Yes | Yes | Yes | No |
| Create today's visit/token | Yes | Yes | Yes | No |
| Record vitals | Yes | Yes | Yes | No |
| Sign consultation/prescription | Only with doctor role | Yes | No | No |
| Capture clinical photo | Policy-based | Yes | Yes | No |
| View clinical photos | Policy-based | Yes | Policy-based | No |
| Dispense prescription | Policy-based | No | No | Yes |
| Request substitution | No | No | No | Yes |
| Approve substitution | Only with doctor role | Yes | No | No |
| Collect payment | Yes | Owner decision | Yes | Yes |
| Reverse/refund payment | Yes | No | No | No |
| Configure medicine/package | Yes | No | No | Limited/owner decision |
| Receive/count stock | Yes | No | No | Yes |
| Approve stock adjustment | Yes | Owner/doctor | No | No |

## 6. Doctor workflow

### 6.1 Start from the queue

`Call in` should select the patient and open Consult directly. The doctor
should not choose the same patient again from an all-patient dropdown.

When the nurse is absent:

```text
Find by phone or name
        |
        +-- Existing patient -> Add to queue -> Vitals -> Consult
        |
        `-- No match -> Quick registration -> Add to queue -> Vitals -> Consult
```

Quick registration requires only the data necessary to identify and treat the
patient safely. Additional demographic fields may be completed later. Before
creating a new record, show possible matches using phone, normalized name, and
age/date of birth. Never merge automatically.

### 6.2 Consultation workspace

Landscape tablet layout:

```text
+------------------------------------------------------------------+
| Token 12 | Patient, age/sex | allergy/status flags | latest vitals|
+------------------------------------------+-----------------------+
| Current consultation                     | Patient context       |
|                                          |                       |
| Complaints and duration                  | Previous visit        |
| Examination                             | Active medicines      |
| Diagnosis                               | Recent vitals         |
| Prescription composer                   | Image timeline        |
| Advice and follow-up                    | Full history ->       |
+------------------------------------------+-----------------------+
| Save draft | Add image | Print after signing | Sign and finish    |
+------------------------------------------------------------------+
```

On portrait tablets, patient context becomes a drawer or disclosure while the
current consultation remains primary. The patient identity bar and final
action area remain sticky.

### 6.3 Structured input strategy

Use the control that matches the size and risk of the choice:

| Information | Control |
|---|---|
| Common complaint | Searchable autocomplete plus recent/favourite chips |
| Duration | Number plus day/week/month dropdown |
| Small fixed choice | Segmented buttons or dropdown |
| Diagnosis | Searchable autocomplete plus free-text escape hatch |
| Medicine | Search by brand, generic/salt, strength, form, code, and barcode |
| Dose/frequency/timing | Structured quick choices with Custom option |
| Duration | Number plus unit; favourites shown first |
| Quantity | Calculated from dosage and duration, editable before signing |
| Advice | Favourite phrases and predictive completion, always editable |
| Follow-up | Today-relative choices plus calendar date |
| Complex clinical note | Free text and optional reviewed dictation later |

Medicine results must show exact strength, dosage form, stock state, and a
clear out-of-stock warning. A fuzzy match must never hide a strength or form
difference.

### 6.4 Favourites, templates, and prediction

Implement in increasing order of complexity:

1. Clinic-managed dictionaries for complaints, diagnoses, instructions, and
   advice.
2. Doctor-specific recent and favourite selections.
3. Reusable prescription/consultation templates loaded as drafts.
4. Phrase completion based on the same doctor's accepted wording.
5. Optional voice-to-text after the structured workflow is stable.

All inserted content remains visibly editable. Applying a template must show
every medicine, strength, dosage, and duration before the doctor can sign.
Do not include autonomous diagnosis or treatment generation in this scope.

Each doctor controls their personal templates. Publishing a clinic-wide
template requires the owner-doctor or another explicitly authorized doctor.
A non-doctor admin may manage access/operational metadata but cannot change
clinical template content. Templates are versioned and retired rather than
rewriting a version used previously.

Unsigned drafts are stored server-side for the responsible doctor and survive
sign-out or movement to another authorized clinic tablet. They remain visibly
`Draft`, never enter the pharmacy queue, and cannot print as signed
prescriptions. After seven days, show a stale-draft review warning rather than
silently deleting, signing, or submitting them.

### 6.5 Previous visit and follow-up

The side summary should show the latest relevant visit first: date, diagnosis,
medicines, advice, follow-up, and image-series status. `Repeat as draft` may
copy a previous prescription but must not sign, dispense, or silently replace a
medicine that is inactive or whose strength changed.

Follow-ups need a small work queue on Today:

- Due today
- Overdue
- Upcoming
- Completed/cancelled

The first release records and displays follow-ups. Automated messaging is a
separate opt-in decision.

## 7. Nurse workflow

### 7.1 Arrival and triage

The nurse searches by phone or name, selects an existing patient or completes
quick registration, enters the visit reason, and creates the token in one
flow. Duplicate suggestions appear before create.

### 7.2 Vitals

Vitals open for the selected queue patient; the nurse should not select again
from the full registry. Fields use large numeric keyboards and preserve the
unit beside the value.

Abnormal-reading visibility is a prompt for review, not a diagnosis. Threshold
rules must be clinically approved, age-aware where necessary, and should say
`Review this reading` rather than naming a condition. Staff can repeat a
reading and the record retains both entries.

If a value was not measured, record it as missing with an optional reason
rather than inventing zero. The current all-required vitals model must be
revisited for the doctor-alone fallback.

### 7.3 Observation

Each occupied bed needs:

- Patient identity
- Admitted time and elapsed-time indicator
- Latest vitals and next-check due time
- Doctor instructions
- Nurse observations
- `Call doctor`/handoff state
- Discharge/transfer action with confirmation

## 8. Prescription, printing, and dispensing

### 8.1 Prescription is the signed clinical intent

A prescription header and its lines become immutable once signed. Each line
stores the medicine identity and a signed snapshot of its displayed name,
strength, form, dosage, timing, duration, prescribed quantity, and instructions.

Do not use one JSON blob as the only source for line-level dispensing. Create
queryable prescription-line records so remaining quantity can be enforced.

### 8.2 Dedicated physical prescription

After signing, show:

- Print prescription
- Send to pharmacy
- Open patient record
- Next patient

Printing occurs only when the doctor selects `Print prescription`; signing must
not automatically open a printer dialog. The first release reserves a physical
signature area and does not store or place a digital signature image. Reprints
remain auditable.

The A4 prescription contains clinic letterhead/contact details, doctor name and
registration number, patient identity, date and prescription number, medicines
and directions, advice, follow-up, and signature area. It prints independently
of dispensing or payment and can be reprinted with an audit event.

Printing must be tested on the clinic's HP Smart Tank 580 over its real 2.4 GHz
Wi-Fi path. A future 80 mm printer is suitable for receipts, not the main A4
prescription unless the owner explicitly approves that format.

### 8.3 Partial dispensing

The pharmacy opens a prescription and enters `Give now` for each line:

```text
Paracetamol 500 mg
Prescribed 10 tablets | Previously supplied 0 | Available 43
Give now [5] tablets  | Remaining after this 5
```

One dispense event may contain all lines, some lines, or part of a line.
Statuses are derived:

- Waiting: nothing supplied
- Partially dispensed: some but not all prescribed quantity supplied
- Dispensed: every line complete
- Not taken: patient declines the clinic supply
- Cancelled: doctor cancels with reason
- Expired: only if the owner defines a prescription-validity policy

The system must reject over-dispensing, repeated submission, expired batches,
and negative stock. It allocates FEFO across one or more batches and records
the exact allocations. Remaining prescription quantity does not reserve stock
by default; reservation is an open owner decision.

### 8.4 Substitution

The pharmacist may flag the prescribed item as unavailable and request a
prescription change, showing an exact candidate with the same structured
ingredients, strengths, dosage form, route, and release characteristics. The
candidate is not dispensed against the unchanged prescription. The doctor
reviews it and, if accepted, issues a signed amended/replacement order according
to the clinic's approved policy. Preserve the original prescription, proposed
product, decision, new doctor-authorized order, time, and dispensed product.

### 8.5 Dispensing receipt

The patient may receive both the original prescription and a separate receipt
showing what was supplied today, what remains on the prescription, charges,
payments, and balance due.

## 9. Inventory and medicine packaging

### 9.1 Unit rule

Store stock in one integer base stock unit: the smallest countable unit whose
content the clinic must track. A pack-only item may still use tablet as its base
while a minimum-dispense multiple enforces complete-strip supply. Do not confuse
the clinical dose unit with the stock unit.

| Product | Clinical dose example | Base stock unit | Package examples |
|---|---|---|---|
| Tablet | tablet | tablet | strip, box |
| Capsule | capsule | capsule | strip, box |
| Syrup | ml | bottle when only whole bottles are sold | box of bottles |
| Cream | gram/application | tube | box of tubes |
| Injection | dose | vial/ampoule | tray, box |
| Bandage | application | piece | pack, carton |

### 9.2 Flexible package hierarchy

Do not hard-code only `strip` and `box`. Let the data model represent a
nested package hierarchy; the normal clinic UI may expose only the two or three
levels actually used. Each level has a base-unit conversion. Example:

```text
Medicine: Paracetamol 500 mg tablet
Base stock unit: tablet

Batch PCM2408
1 tablet = 1 base unit
1 strip  = 15 tablets
1 box    = 10 strips = 150 tablets
MRP      = Rs 30 per strip
```

Receiving two boxes, three strips, and four loose tablets converts to 349 base
units. The ledger stores `+349`. The batch can display `2 boxes, 3 strips, 4
tablets` without storing three competing balances.

The physical hierarchy lives on a versioned package SKU between the medicine
and batch. The batch references that package version and retains an immutable
snapshot of the conversions confirmed at receipt. Batch number, expiry, MRP,
and actual purchase cost remain batch/receipt values. If the package changes,
create a new package version; never mutate a conversion used by historical
stock.

When batches have different package definitions, do not decompose a combined
medicine total into boxes/strips. Show the reliable total base units at medicine
level and the physical decomposition inside each batch.

### 9.3 Receiving

The receive-delivery flow asks for physical invoice units and calculates the
base quantity:

```text
Medicine -> Batch/expiry -> Confirm package -> Enter boxes/strips/loose
         -> Enter MRP basis and purchase-price basis -> Review -> Receive
```

The review step says exactly what will be added. Barcode scan should identify
the medicine/package where known; an unknown barcode requires an explicit
mapping and confirmation.

### 9.4 Stock display and actions

Daily pharmacy rows show medicine, human-readable stock, next expiry, and one
status. Opening a row reveals batches and movement history. Admin receives
search, filters, costing, supplier, reorder, and audit detail.

Stock-take entry uses physical quantities such as boxes, strips, and loose
units while remaining blind to expected stock. Variance is revealed after
submit, high-value discrepancies require recount, and approval posts
compensating ledger movements.

### 9.5 Reordering, expiry, and returns

Reorder suggestions should be shown in supplier purchase units, not raw
tablets. Suggestions use consumption and lead time but never place an order
automatically. Expiry work remains grouped by return-window urgency, with
return notes, expected supplier credits, and write-offs recorded separately.

## 10. Billing, split payments, and dues

### 10.1 Charge only actual events

The prescription is not an invoice. Charge consultation when the encounter is
completed and medicines when they are actually dispensed. If 5 of 10 tablets
are supplied today, charge 5 today. Supplying the remaining 5 later creates a
new charge event attached to the same prescription/patient ledger.

The completed consultation creates exactly one consultation-fee line using a
snapshot of the fee or approved waiver/follow-up rule that applied to that
encounter. It appears in the pharmacy Counter immediately and remains payable
there even when the prescription is printed without clinic dispensing or the
patient takes no medicines. A later visit to collect remaining medicines must
not add the consultation fee again.

### 10.2 Bill and payment model

A bill contains line items and total. Separate payment rows record money
received. Bill status is derived from total successful payments:

- Unpaid
- Part-paid
- Paid
- Voided

Supported methods initially:

- Cash
- UPI, displayed as `GPay / UPI` in the clinic UI
- Card

Example:

```text
Bill total       Rs 800
Cash             Rs 300
GPay / UPI       Rs 250
Balance due      Rs 250
```

The remaining amount may be collected later in one or more payments. `Pay
later` creates a visible balance; it never marks a bill paid. Discounts,
waivers, unpaid balances, payments, reversals, and refunds are different events
and must not be represented by overwriting the bill total.

### 10.3 Payment UX

The pharmacy counter shows the consultation fee and medicines supplied today
as separate, understandable lines. It defaults to one full payment. `Split or
pay partly` reveals the additional amount fields. The interface prevents total
payments exceeding the balance and confirms the remaining due before posting.

A consultation-only patient still appears as a payment task at the pharmacy.
The pharmacist can collect it in full, split it between methods, record a part
payment, or mark the balance as `Pay later`, subject to the same permissions and
audit trail as a bill that includes medicines.

Every payment stores amount, method, timestamp, collecting staff member,
optional UPI/card reference, bill link, and reversal relationship if corrected.
The day book separates physical cash from UPI/card and shows later collections
against earlier bills.

### 10.4 Patient balance

Patient records and admin finance show total outstanding, individual bills,
payment history, and last reminder. Due-date and WhatsApp-reminder behaviour
requires owner approval and must respect the patient's communication consent.

## 11. Clinical before/progress/after images

### 11.1 Clinical workflow

Images are captured only from an open patient and encounter/condition:

```text
Add clinical photo -> Before / Progress / After -> body site and side
                   -> record consent -> capture -> confirm patient
                   -> optional note -> upload and save
```

The confirmation screen prominently repeats the patient name to reduce wrong-
record attachment. A series groups related photos for side-by-side comparison.
Show originals without beauty filters or colour alteration. Crops and
annotations are stored as derived views while the original remains immutable.

### 11.2 Metadata

Each image records:

- Patient, encounter, and optional image-series identifier
- Before/progress/after category
- Body site and side
- Capture timestamp and capturing staff member
- Consent method/time and any note
- Private object path, media type, size, dimensions, and integrity hash
- Thumbnail/derived-object references
- Clinical caption
- Superseded/deleted state, actor, time, and reason

### 11.3 Access and storage

Use a private object bucket. Because this application uses its own clinic
session rather than exposing a Supabase service credential in the static
client, the existing authenticated Edge Function boundary must authorize
upload and download. The browser must never receive a service-role/secret key.
Access should use short-lived, operation-specific URLs or authenticated proxy
responses.

Images and image bytes must not enter the whole-clinic snapshot. Load metadata
and thumbnails only when the patient record is opened. Do not cache image bytes
in localStorage or the tablet's public gallery. A failed upload is not shown as
saved; staff get a clear retry/discard choice.

Default access is doctor and explicitly authorized nurse. Pharmacy has no
clinical-image access. Admin access is a policy decision, not an automatic
consequence of being able to configure the system.

### 11.4 Go-live policy gate

Before release, the owner must approve written rules for consent, permitted
uses, who may capture/view/export, retention, patient-copy requests, deletion
or correction, device loss, and breach response. Photos are never sent through
WhatsApp automatically.

## 12. Proposed data-model changes

Exact SQL belongs to implementation after staging and migration rehearsal. The
target logical model is:

### Clinical

- `encounters`: retain header; add draft/signed lifecycle only if the owner
  needs draft recovery across devices.
- `prescriptions`: signed header, status/cancellation metadata, print number.
- `prescription_lines`: one queryable signed line per medicine.
- `follow_ups`: encounter, due date, status, note, completion metadata.
- `clinical_phrase_favourites`: owner/doctor, kind, normalized text, usage.
- `consultation_templates` and template lines: versioned drafts, never signed
  clinical records.
- `clinical_image_series`: patient, condition/site, lifecycle metadata.
- `clinical_images`: immutable object metadata, consent, caption, actor/time.
- `clinical_image_annotations`: separate overlays/notes referencing an image.

### Dispensing and inventory

- `medicine_pack_defaults`: medicine-level prefill definitions.
- `medicine_package_skus`: versioned package identity and net content.
- `package_components`: parent/child hierarchy, base-unit factor, and
  sellable/receivable flags.
- `batch_pack_levels`: immutable receiving snapshot of package conversions
  and price basis for the batch.
- `package_barcodes`: identifiers with symbology and exact packaging level;
  batch/expiry only when the scanned payload contains them.
- `dispenses`: one supply event, prescription/patient/pharmacist/time.
- `dispense_lines`: prescribed line and actual quantity supplied.
- `dispense_allocations`: dispense line to batch/base quantity/price.
- Existing stock movements remain the authoritative append-only quantity
  ledger and reference each dispense event.

### Finance

- `bills`: header, patient, status lifecycle, timestamps.
- `bill_lines`: consultation, dispense, OTC, adjustment, discount, or other
  typed source and exact amount.
- `payments`: amount, method, actor/time, reference, state.
- `payment_allocations`: payment amount applied to a bill.
- `payment_reversals` or a reversal link: reason and approving admin.

### Schema requirements

- Use exact decimal values (`numeric`, not floating point) for new money
  columns.
- Use timezone-aware timestamps for new event times.
- Use positive integer base quantities and database checks for non-negative
  balances, package factors, prescribed quantities, and payment allocations.
- Add foreign keys and explicitly index their referencing columns.
- Enforce idempotency keys/unique references for dispense and payment commands.
- Keep transactions short and lock stock/payment rows in a consistent order.
- Retain current text identifiers during this feature migration to avoid an
  unrelated whole-database ID conversion.
- Keep the `jmc` schema private and preserve role checks at the Edge Function
  boundary; use defense-in-depth controls for image objects.

## 13. Visual direction

### 13.1 Token system

Retain the distinctive `ink on clinic ledger` language already present, but
make it calmer and less typographically mechanical:

| Token | Value | Use |
|---|---|---|
| Paper | `#E7E6E0` | App workspace |
| Sheet | `#FCFCFB` | Active clinical document |
| Ink | `#191C1A` | Text and primary structure |
| Active saffron | `#C2620E` | The one current task/action |
| Safe green | `#2F6B4F` | Completed/available |
| Stop red | `#A11D22` | Blocking clinical/stock/payment issue |

Use Archivo for interface and clinical text. Reserve IBM Plex Mono for tokens,
batch numbers, dates, quantities, and money that benefits from tabular
alignment. Reduce tracked uppercase labels; use sentence case for navigation,
actions, form labels, and status explanations.

### 13.2 Layout

- Left-align operational content.
- Use one dominant work surface rather than many equal cards.
- Keep the selected patient/status bar visible.
- Keep one primary action visible; secondary details use disclosure or a side
  panel.
- Preserve at least 44 px touch targets and visible keyboard focus.
- Use status colour only for state, never decoration.
- Prefer stable layouts and action feedback over decorative animation.

### 13.3 Design critique before build

The current ledger concept is specific to a small clinic and worth retaining.
Its generic tendencies are the repeated card grid, all-caps tracked labels,
monospace metadata everywhere, and a long navigation rail. The redesign should
remove card boundaries that do not encode a real record, reduce typographic
labels, and make the active patient/work step the memorable element. This is a
workflow refinement, not a cosmetic re-skin.

## 14. Architecture and non-functional requirements

1. Preserve the static Next.js page plus Supabase Edge Function/Postgres split
   unless a separately approved architecture decision changes it.
2. Read the installed Next.js 16 documentation under `node_modules/next/dist/docs/`
   before implementing framework code, as required by `AGENTS.md`.
3. Do not add clinical history, images, full payment history, or stock ledger
   history to the 15-second clinic snapshot. Fetch by patient, prescription,
   bill, or inventory detail on demand.
4. Every mutating command requires authorization, server-side validation,
   audit, and an idempotency strategy.
5. Stock allocation and dispense creation occur atomically. Payment posting and
   balance calculation occur atomically. External calls and image transfer do
   not hold database locks.
6. Show connection and last-sync state. A timed-out command must be safely
   retryable without double dispensing or double payment.
7. Keep the app usable at 768 px portrait and 1024 px landscape, with pharmacy
   keyboard support and camera permission states.
8. Preserve reduced-motion, focus visibility, readable contrast, native
   semantics, and print accessibility.
9. Autosave unsigned consultation drafts if approved, but never autosign or
   silently submit a clinical record.
10. Establish monitoring for failed commands, image uploads, print failures
    reported by staff, stock conflicts, and payment reversals.
11. Treat the four-digit PIN as a fast staff-unlock secret, not as an
    unrestricted password. Keep server-side attempt throttling/temporary
    lockout, salted slow hashing, generic failure messages, per-staff PINs,
    short idle expiry, reset-driven session revocation, and audit events. Reject
    repeated digits and simple ascending/descending sequences; never store or
    log the raw PIN.

## 15. Delivery plan and gates

No production work begins until Phase 0 exits successfully.

### Phase 0 - Decisions, staging, and safety baseline

**Work**

- Observe at least one real consultation, one nurse intake, one prescription
  dispense, one mixed/due payment, and one supplier receipt.
- Collect anonymized examples of prescriptions, invoices, strip/box packaging,
  and existing printed documents.
- Resolve the owner decisions in section 18.
- Create a separate staging database and Edge Function environment with safe
  seed data; local UI must no longer point at live clinic data for testing.
- Produce and verify a database backup and restore rehearsal before migration.
- Add a smoke-test scaffold and document the staging/deployment path.

**Exit gate**

- Owner signs off workflow diagrams and terminology.
- Staging works without production records.
- Backup can be restored.
- Baseline tests run in CI.

### Phase 1 - Shared workflow foundation

**Work**

- Introduce capability-based server checks and role navigation.
- Allow doctor to create today's visit/token.
- Add selected-patient context shared across Queue, Vitals, and Consult.
- Add quick registration with duplicate suggestions.
- Support missing/not-measured vitals deliberately.
- Change staff creation, PIN reset, bootstrap, and unlock UI/API validation to
  an exact four-digit PIN while preserving the sign-in safeguards in section 14.
- Add command idempotency and last-sync/connection feedback.

**Exit gate**

- A doctor alone can find/register a patient, create the visit, record available
  vitals, and open consultation without an admin/nurse login.
- Nurse flow works without reselecting the patient.
- Staff can create, reset, and sign in with a four-digit PIN; wrong-PIN rate
  limiting and session revocation are verified.

### Phase 2 - Doctor workspace and prescription print

**Work**

- Build the single consultation work surface and last-visit summary.
- Add clinic dictionaries, autocomplete, structured dosage fields, favourites,
  templates-as-drafts, and follow-up records.
- Normalize prescriptions and prescription lines.
- Add save-draft recovery if approved.
- Build a dedicated A4 prescription document and reprint audit.

**Exit gate**

- The doctor completes a common visit without leaving Consult.
- Exact medicine strength/form remains visible through search, signing, record,
  and print.
- A prescription can print whether or not clinic pharmacy supplies it.
- Templates cannot bypass doctor review/signature.

### Phase 3 - Inventory unit and package foundation

**Work**

- Add base stock units, batch package levels, price bases, and barcode mappings.
- Replace raw receiving quantity with physical package entry and conversion.
- Update shelf, batch, stock-take, reorder, expiry, return, and order displays.
- Rehearse migration with copies of current inventory.
- Conduct a verified physical opening count for every active batch.

**Exit gate**

- No active medicine has an ambiguous stock unit or price basis.
- Receiving boxes/strips/loose units posts the correct base quantity.
- Package differences between batches do not corrupt historical stock.
- Existing raw quantities are reconciled by a person, never guessed by a
  migration.

### Phase 4 - Partial dispensing, billing, and payments

**Work**

- Add dispense events/lines/allocations and derived prescription status.
- Build `Give now` quantities, FEFO pick guidance, scan verification, remaining
  balances, and substitution request/approval.
- Create bill lines from actual consultation and dispense events.
- Put every completed consultation's fee into the pharmacy Counter exactly
  once, including consultation-only and no-clinic-medicine visits.
- Add payment entries, GPay/UPI, cash/card split, part payment, pay later,
  patient balances, reversal/refund, and day-book reconciliation.
- Build dedicated dispensing and payment receipts.

**Exit gate**

- Full, partial, multi-visit, declined, and out-of-stock dispensing paths work.
- Concurrent/retried commands cannot over-dispense or reduce stock below zero.
- Cash plus GPay/UPI and later payments reconcile exactly to bill and day book.
- The pharmacy can collect a consultation fee without dispensing a medicine,
  and later partial-dispense visits do not charge that fee again.
- The receipt distinguishes prescribed, supplied, paid, and due.

### Phase 5 - Clinical images

**Work**

- Approve consent/access/retention policy.
- Provision private object storage and metadata tables.
- Implement authorized capture, upload, thumbnail viewing, retry, audit,
  annotation, and side-by-side series comparison.
- Add device-loss and access-revocation tests.

**Exit gate**

- An image cannot be accessed by pharmacy or an unauthorized session.
- Every view/download/export is attributable.
- The original remains unchanged after annotation.
- Failed uploads never appear as saved clinical evidence.

### Phase 6 - Admin consolidation, reporting, and rollout

**Work**

- Replace the flat admin rail with grouped navigation.
- Add patient dues, payment reconciliation, inventory valuation, package audit,
  outstanding prescription, follow-up, and image-access reports.
- Complete copy review, accessibility review, performance checks, tablet and
  printer hardware testing, training, and go-live runbook.
- Run parallel clinic operation for an owner-approved period and reconcile
  daily before full cutover.

**Exit gate**

- Owner, doctor, nurse, and pharmacist each pass role-specific acceptance
  scenarios on clinic hardware.
- Inventory, cash, UPI, patient dues, and printed totals reconcile.
- Recovery, rollback, and support contacts are documented.

## 16. Test plan

### Unit tests

- Package conversion/decomposition for tablets, bottles, tubes, and pieces
- Mixed batch package sizes
- Price/MRP basis and decimal rounding
- Prescribed, dispensed, and remaining quantities
- Multi-batch FEFO allocation
- Bill total, split payment, part payment, balance, refund, and reversal
- Four-digit PIN validation and weak-pattern rejection
- Follow-up state and duplicate-patient normalization
- Permission/capability decisions

### Database and API integration tests

- Signed prescription immutability
- No over-dispensing or negative stock
- Concurrent dispensing against the same batch
- Retried dispense/payment request is idempotent
- Payment allocation cannot exceed bill balance
- Consultation fee is generated once and is not repeated by later dispensing
- Wrong-PIN throttling and PIN-reset session revocation
- Reversal retains the original event
- Doctor-alone check-in permissions
- Image metadata/object authorization
- Foreign-key, check-constraint, and audit completeness

### Browser workflow tests

- Nurse-present patient journey
- Doctor-alone registration, vitals, consultation, and print
- Full and partial dispensing over one or more visits
- Cash, GPay/UPI, split, partial, and pay-later collection
- Pharmacy collection of a consultation-only bill
- Four-digit sign-in, staff creation, and PIN reset
- Before/progress/after capture and comparison
- Session expiry during a draft, dispensing, payment, and image upload
- Offline/server-unreachable recovery without duplicate side effects
- Keyboard pharmacy flow and tablet camera permission refusal

### Visual and hardware tests

- 768 px portrait and 1024 px landscape
- Long patient/medicine names and English clinical content
- Large text/zoom, keyboard focus, screen-reader labels, reduced motion
- HP Smart Tank 580 A4 prescription/bill printing
- Future 80 mm receipt layout on the actual selected device
- Real clinic Wi-Fi interruption and reconnect

## 17. Rollout and migration rules

1. Never test mutating workflows against the clinic's live database.
2. Never infer whether an existing stock quantity means tablet, strip, box,
   bottle, or pack. Configure and physically recount each active batch.
3. Run forward-only migrations in staging, inspect constraints/indexes, and
   rehearse rollback through restore before production.
4. Migrate prescription JSON to line records with reconciliation reports;
   retain the original JSON during a verification window.
5. Convert financial records without rewriting historical meaning. Old fully
   paid bills may receive an opening payment event; unresolved bills require
   owner reconciliation.
6. Release by role/workflow behind admin-controlled flags where practical.
7. Keep paper/manual fallback available during rollout and reconcile every day.
8. Do not remove legacy read views until the owner signs off counts, balances,
   and documents.
9. Six-digit PIN hashes cannot be converted into four-digit PINs. Schedule an
   admin-controlled reset for every active staff member, verify each new PIN,
   revoke their old sessions, and do not truncate, reuse, or expose the former
   PIN.

## 18. Owner decisions required

> **Status update, 11 September 2026:** the owner has answered these product
> questions. Use [`OWNER_POLICY_REGISTER.md`](OWNER_POLICY_REGISTER.md) as the
> authoritative policy and remaining-evidence list. The questions below are
> retained as design provenance.

These are genuine product choices, not engineering details:

### Consultation

- Which complaints, diagnoses, instructions, and advice phrases are most
  common?

### Prescription and dispensing

- Can remaining medicine be collected on another day?
- When does an unfinished prescription expire?
- Should remaining stock ever be reserved?
- How should `patient chose not to take it` differ from doctor cancellation?
- Who may approve substitution when the doctor has left?

### Payment

- May the doctor collect payment when operating alone?
- If the pharmacy counter is closed or unattended, which authorized role may
  collect the consultation fee?
- Who may approve discounts, waived consultation fees, refunds, and reversals?
- Does pay-later need a due date, credit limit, or reminder?
- Is an optional UPI reference sufficient, or must staff always enter one?

### Inventory

- Are loose tablets/capsules normally sold?
- Which products may only be sold as a complete bottle, tube, vial, or pack?
- How do the clinic's supplier invoices express quantity and MRP?
- Which staff may create/edit pack definitions?
- Provide real examples where pack size changed between batches.

### Images

- Which conditions will be photographed?
- Are progress photos needed in addition to before/after?
- May nurses capture and view images?
- Does the patient receive a copy, and by what controlled method?
- What consent, retention, deletion, and export policy will the clinic adopt?

### Printing

- Which documents need A4 versus the future 80 mm printer?

## 19. Success criteria

The redesign is successful when:

- A doctor can operate the patient flow alone without borrowing a nurse/admin
  account.
- A normal consultation stays in one workspace and uses structured choices for
  repeated information.
- Search results always expose medicine strength and form before signing.
- A patient can take all, some, none, or the remainder later without changing
  the original prescription or corrupting stock.
- A patient can receive a physical prescription independently of purchase.
- Cash plus GPay/UPI plus a later payment reconciles exactly, with a visible
  balance throughout.
- Every completed consultation produces at most one consultation-fee charge,
  visible and collectible at pharmacy even when no medicine is supplied.
- Every active staff member can use an individual four-digit PIN without
  weakening attempt limits, session expiry, revocation, or audit attribution.
- Staff receive/count physical packages while the system maintains exact base
  units and batch history.
- Clinical photos are correctly attached, consented, private, auditable, and
  never distributed through the general snapshot.
- The pharmacist and nurse see only the next work that matters; the admin can
  still investigate the complete history.
- Every critical workflow has automated coverage and has passed on the
  clinic's actual tablets, network, and printer.

## 20. Explicit non-goals for this programme

- Autonomous diagnosis or treatment recommendation
- Automatic medicine substitution
- Automatic purchase-order placement
- Public clinical-image URLs
- Silent merging of patient records
- Negative-stock overrides
- Rewriting or deleting signed clinical/financial history
- A broad hosting rewrite unrelated to these workflows

These boundaries keep the programme focused on making the clinic faster and
safer without turning a small-clinic tool into a complicated hospital system.
