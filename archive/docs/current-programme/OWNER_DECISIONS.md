# Historical owner-decision questions

> **Superseded 11 September 2026:** the owner has now answered this checklist.
> The authoritative approved/partial/evidence status is recorded in
> [`../../../docs/OWNER_POLICY_REGISTER.md`](../../../docs/OWNER_POLICY_REGISTER.md). The detail below is
> retained to explain why each question existed and to preserve staging-findings
> history; its “blocking” labels are no longer the current status.

Slice 0's last work item is "obtain owner sign-off for unresolved choices that
block a later slice". This is the list, consolidated from
`docs/AGENT_IMPLEMENTATION_BRIEF.md` §10,
`docs/reference/PRODUCT_UX_DISCOVERY.md` §18 and
`docs/reference/CLINICAL_TERMINOLOGY_AND_MEDICINE_DATA_RESEARCH.md` §15, plus four questions
that only appeared once staging was built.

It is ordered by **when the answer is needed**, not by importance. A decision
in the Slice 1 table stops work; one in the Slice 5 table can be answered over
the next few weeks.

Nothing here is a question about implementation. Each one changes what the
software does to a patient's record, a shelf or somebody's money, and a wrong
default is worse than a delay.

---

## Answered decisions

### 1. The PIN migration stays two-stage, and the format is tracked explicitly — RESOLVED

Existing staff keep six-digit access until they are individually reset. Every
new or reset PIN is four digits. **The stored format is recorded explicitly per
staff member**, not inferred from the hash — a scrypt hash reveals nothing
about what was hashed, so "how many legacy PINs are left" has to be a column
somebody can count, not a guess.

Six-digit compatibility is removed only when that count reaches zero.

*Implementation consequence for Slice 1:* a PIN-format marker on `staff`, and
`createSession` accepting whichever length that row declares. Not "accept 4 or
6 from anyone" — that would halve the search space for every account at once
and quietly weaken the accounts that have already been migrated.

### 2. Two administrators who reset each other, with a named single-admin fallback — RESOLVED

Preferred: **two admins reset each other.** Dr. Jayamurugan is the recovery
administrator **if he holds the admin role** — see the open action below.

If only one admin exists, that admin:

1. resets everyone else first, verifying each new PIN with that person present;
2. resets themselves last;
3. is signed out by their own reset (`set_staff_pin` revokes sessions — this is
   existing, tested behaviour, not something Slice 1 adds);
4. immediately signs in again to verify the new PIN before leaving the clinic.

Six-digit compatibility is not removed until the legacy count is zero, so a
failure at any step above leaves everyone still able to work.

> **Open action, not a decision:** whether Dr. Jayamurugan currently holds the
> `admin` role is a fact about production data and has not been checked —
> nothing in this programme reads the live database. Confirm it on the Staff
> screen before the reset appointment. If he holds only `doctor`, grant `admin`
> first, or the recovery path in this decision does not exist.

### 3. The doctor may run the visit alone — RESOLVED

Yes. When the nurse is absent the doctor may register a patient, create today's
visit and token, and record vitals.

Two of those three already work. `create_appointment` refuses the doctor role
today, which `tests/characterization/roles-and-snapshot.test.mjs` pins as
current behaviour — Slice 1 changes the code and that test together.

Signing a consultation stays doctor-only, and an admin who is not a doctor
still cannot sign. Authority follows the clinical role, not the level of
access.

### 4. English only for the first release — RESOLVED

The first release uses English only for the staff interface, autocomplete,
templates, clinical phrases, and printed prescriptions. Tamil and bilingual
display/printing are deferred. Slice 2 must not add a language selector,
machine translation, or Tamil content that the clinic has not reviewed.

Source terminology may retain its language/provenance metadata where required,
but the application does not need translation infrastructure solely for a
hypothetical later release.

### 6. Doctors control clinical templates — RESOLVED

Each doctor may create, edit, use, and retire their own personal templates.
Only Dr. Jayamurugan as owner-doctor, or another explicitly authorized doctor,
may approve and publish a clinic-wide template. A non-doctor admin may manage
access and operational metadata but cannot edit clinical template content.

Templates are versioned and retired rather than historically overwritten. They
always load as visible, editable drafts and never bypass doctor review or
signature.

### 7. Unsigned drafts survive sign-out and tablet changes — RESOLVED

Unsigned consultation drafts are stored server-side and may be recovered by
the responsible doctor after sign-out or on another authorized clinic tablet.
They remain clearly marked `Draft`, stay invisible to pharmacy, and cannot be
dispensed or printed as signed prescriptions. After seven days they receive a
stale-draft warning for doctor review; they are not silently signed or deleted.

### 8. Prescription printing is on request with a physical signature area — RESOLVED

Signing does not automatically open the printer. After signing, the doctor sees
a prominent `Print prescription` action. The first release leaves an area for a
physical signature and does not store or place a digital signature image.
Every reprint remains auditable.

---

## Blocking now — nothing

No decision currently blocks Slice 2 coding. Decision 5 below blocks production
clinical content and the final Slice 2 acceptance gate, not implementation;
Claude may build and test the structure with synthetic staging terms.

---

## Required before Slice 2 production content is accepted

| # | Decision | Why it matters |
|---|---|---|
| 5 | **Which complaints, diagnoses, instructions and advice phrases are actually common?** Twenty of each is enough to start. | The clinic-curated subset is what makes autocomplete fast. Without it the doctor gets either a blank box or an irrelevant national terminology. |

---

## Blocking Slice 3 — packages and stock

| # | Decision | Why it matters |
|---|---|---|
| 9 | **Which products may be sold loose, and which only as a complete strip, bottle, tube, vial or pack?** | Sets the base stock unit and the minimum dispense multiple per product. Guessing corrupts every quantity. |
| 10 | **How do the clinic's supplier invoices express quantity and MRP?** Two or three real invoices would settle it. | The receiving screen is built around the shape of the paperwork, not the other way round. |
| 11 | **Provide real examples where the pack size changed between batches.** | Confirms the package-version model earns its complexity before it is built. |
| 12 | **Who may create and edit pack definitions and medicine records?** Pharmacy, admin, or both? | Currently `add_medicine` allows admin and pharmacy. Worth confirming rather than inheriting. |
| 13 | **Are any bulk liquids decanted, or multi-dose containers administered?** | If yes, that is a separate measured-dispensing workflow with decimal quantities and beyond-use dates. If no, integers hold everywhere and the model stays simple. |
| 14 | **A physical opening count is required for every active batch.** Who does it, and when? | Slice 3's gate. A migration must never guess whether an existing quantity meant tablets, strips or boxes. |

---

## Blocking Slice 4 — dispensing, fees and payment

| # | Decision | Why it matters |
|---|---|---|
| 15 | **What is the consultation fee, and where does it live?** See §"Found while building staging" below — the configured fee is currently ignored. | Slice 4 charges a snapshot of the fee that applied to the encounter. It needs a fee that means something. |
| 16 | **Follow-up and waiver rules.** Is a follow-up within N days free? Who may approve a waiver, a discount, a refund or a reversal? | These are separate events from the bill total. Without a rule the system either charges everybody or trusts anybody. |
| 17 | **If the pharmacy counter is closed or unattended, which role may collect the consultation fee?** May the doctor collect when operating alone? | The fee is routed to the counter by design. This decides whether it can be collected anywhere else. |
| 18 | **May a remainder be collected on another day, and when does an unfinished prescription expire?** | Decides whether "Expired" is a real prescription status. |
| 19 | **Is stock ever reserved for an uncollected remainder?** | Default is no. Reserving stock the patient may never collect makes it unavailable to a patient who is standing there. |
| 20 | **How should "patient declined" differ from a doctor's cancellation?** | Two different clinical meanings that currently share one null timestamp. |
| 21 | **Who may approve a prescription change when the doctor has left for the day?** | The pharmacist may request; only a doctor-authorized order permits a different product. If nobody can approve after hours, the patient waits — which may be the right answer. |
| 22 | **Does pay-later need a due date, a credit limit or a reminder?** | Decides whether patient balances need a schedule or only a total. |
| 23 | **Is a UPI or card reference optional or mandatory?** | Affects day-book reconciliation. |
| 24 | **Must the OTC receipt series be gapless?** A rolled-back sale currently burns a number, which is correct against duplicates but leaves gaps. GST generally expects a consecutive invoice series. | If gapless is required, the number must come from a counter row taken with `select ... for update` rather than a sequence, which costs concurrency. |

---

## Blocking Slice 5 — clinical images

Slice 5 does not start until all of these are answered in writing.

| # | Decision |
|---|---|
| 25 | Which conditions will be photographed, and are progress photos needed as well as before/after? |
| 26 | May nurses capture images? May nurses view them? Is admin access automatic, or not? |
| 27 | How is patient consent taken and recorded, and what is it consent for? |
| 28 | Does the patient receive a copy, and by what controlled method? Not WhatsApp by default. |
| 29 | Retention, correction, deletion and export policy. |
| 30 | Device-loss and breach-response procedure. |

---

## Found while building staging — four new items

These were not in any of the three source documents. They came out of running
the code against a real database for the first time.

### 31. The configured consultation fee is not the fee that is charged

`clinic_settings.consultation_fee` is written by the admin Clinic screen, sent
to every tablet in the snapshot, and read back by that same screen as its own
default. **Nothing else reads it.**

What actually reaches the bill is `payload.consultationFee` from the doctor's
browser, and the form field that supplies it hardcodes `defaultValue="300"`
(`components/care-workspaces.tsx:381`). So an admin who changes the fee on the
Clinic screen changes nothing that is billed, and the amount charged is
whatever the client sends — a value with no server-side check at all.

Recorded as a passing test in
`tests/characterization/consultation-and-billing.test.mjs`.

**Owner question:** what *is* the consultation fee today, and has it ever
differed from ₹300? If it has, some bills are wrong and the correction is a
data question, not a code question.

### 32. A concurrent dispense could hand over twice the prescribed quantity — FIXED in code 2026-09-10, one question still open

Two tablets dispensing the same prescription in the same moment both allocated.
Reproduced against staging: a prescription for 10 tablets moved **20** off the
shelf. `dispense_rx` guarded completion with `dispensed_at is null` inside the
UPDATE but never checked that the update changed a row.

Fixed in Slice 0.1: the prescription row is taken `for update` before any stock
moves, and the completing UPDATE's row count is checked. Two simultaneous
submissions now produce one dispense, one rejection reading "already
dispensed", and exactly ten tablets deducted — asserted in
`tests/characterization/concurrency.test.mjs`, which no longer carries a `todo`.

**Not yet deployed.** The fix is committed and needs approval before it reaches
the clinic.

**Owner question, still open:** has the pharmacy ever had two people dispensing
at once? If so, the stock ledger may already contain a double allocation from
before this fix, and it is worth looking **before** Slice 3's physical opening
count rather than explaining a variance afterwards. The query is cheap: any
`prescription`-type movement whose total for one prescription exceeds the
quantity in that prescription's `items_json`.

### 35. The queue could call a patient out of turn — FIXED in code 2026-09-11, existing rows still mixed

`appointments.scheduled_at` is a text column and the queue is sorted by it, so
the ordering is a string comparison. Two different shapes were being written
into it: the desk form's `datetime-local` value (`2026-09-11T10:30`, local, no
timezone) and, from anything written in code, `toISOString()`
(`2026-09-11T05:30:00.000Z`, UTC). Sorted as text, `2026-09-11T0…` sorts before
`2026-09-11T1…` — so an 11:00 walk-in appeared **above** a 09:15 appointment
and the wrong patient was called in. Nothing errored; the queue simply looked
wrong, which is the kind of fault that gets blamed on the nurse.

Slice 1 made it likelier rather than causing it: the new doctor-alone path
books from Consult, in code, in ISO. Fixed by normalising every value to ISO
UTC on the way in, with a naive time read as clinic time — the person typing
into a tablet in Chennai means Chennai. Covered by
`tests/characterization/queue-order.test.mjs`.

**Owner question:** rows written before today still hold both shapes, so a
historical queue can still read out of order. Correcting them is a one-off
UPDATE against production data and therefore needs your approval and a
rehearsal on a restored copy first. It affects only how old appointments sort
in a report; it changes no clinical or financial record. Worth doing, not
urgent.

### 33. A zero fee and no fee are the same thing

`save_consultation` writes no bill at all when the fee is zero. A deliberately
free follow-up and a consultation where somebody left the field blank are
indistinguishable afterwards — there is no waiver, no approver and no
zero-value line.

**Owner question:** are free consultations given, and should they be visible as
such?

### 34. Applying migrations outside a transaction builds the clinic in the wrong schema — RESOLVED 2026-09-10

**Decision: do not edit the already-applied migration. History is frozen.**

The staging legacy stubs stay for now, as the temporary measure they are. The
durable fix is a **separately reviewed clean baseline**, prepared and approved
on its own rather than smuggled into a feature slice. Its requirements, as
stated by the owner:

- every object explicitly `jmc.`-qualified, so nothing depends on
  `search_path` being set and nothing depends on a tool wrapping the file in a
  transaction;
- no dependency on the retired application's `public` views or `app.*`
  functions;
- the DML restored — the `clinic_revision` and `clinic_settings` singleton
  rows, and the five document-number sequences wound to their correct
  starting values;
- verified by building it on a fresh PostgreSQL, not only by reading it.

**`supabase migration repair` is not to be run against production yet.** That
is a separate, later step and needs its own approval.

Until the baseline lands, two things remain true and are written down here so
nobody rediscovers them the hard way: the committed migration set cannot build
a fresh clinic without the staging stubs, and disaster recovery onto a new
Supabase project must restore a backup first rather than migrating from
scratch. The backup carries `public`, `app` and `jmc`, so that path works.

---

## Safe defaults being used until these are answered

From `docs/AGENT_IMPLEMENTATION_BRIEF.md` §10, unchanged:

- no automatic stock reservation
- no automatic substitution
- no autonomous diagnosis or treatment
- no automated WhatsApp
- no pharmacy access to clinical images
- no image release to anyone
