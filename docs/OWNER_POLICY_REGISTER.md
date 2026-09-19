# Owner policy register

**Jayamurugan Clinic**  
**Owner-supplied decisions recorded 11–19 September 2026**

This is the authoritative product-policy register for the current programme.
It supersedes the open-question status in `archive/docs/current-programme/OWNER_DECISIONS.md`, while retaining
that file as the historical explanation of why each question was raised.

These decisions authorize product behavior; they do not replace review by the
treating doctor, registered pharmacist, accountant, privacy adviser, or the
applicable regulator where their approval is required.

Status meanings:

- **Approved** — the owner supplied a complete product direction.
- **Partial** — the direction is known, but one named value or boundary remains.
- **Evidence** — policy is decided; real clinic material is still needed for
  validation.
- **Deferred** — the owner decided the capability is not in this release. This
  is a scope decision and not an open question: the release is complete without
  it, and what a later release would have to settle is written down beside it.

Section K was added on 13 September 2026 for item 64. Section L was added on
15 September 2026 for items 65–74 and gained item 75 on 16 September 2026.
Section M was added on 17 September 2026 for items 76–83, and the references
moved from M to N to keep the bibliography last. Section N was added on
19 September 2026 for items 84–88, and the references moved again, from N to O,
for the same reason. Nothing else was re-lettered; the earlier shift of old
H→I, I→J, J→K on 12 September still holds.

---

## A. Foundation, access, and doctor workflow

| # | Question | Approved policy | Status |
|---:|---|---|---|
| 1 | How do six-digit PINs become four digits? | Existing staff retain their six-digit PIN until reset. Every new/reset PIN uses four digits. Track the format explicitly per staff account and remove legacy compatibility only when the legacy count reaches zero. | Approved |
| 2 | Who resets PINs and who resets the resetter? | Two admins reset each other. With one admin, that admin resets everyone else first, verifies them in person, resets themselves last, is signed out, and immediately verifies their new PIN. | Approved |
| 3 | Can the doctor operate without a nurse? | Yes. A doctor may register patients, create visits/tokens, enter partial or complete vitals, and conduct consultations. Clinical signing remains doctor-only. | Approved |
| 4 | What language is used initially? | English only for staff UI, clinical search, templates, prescriptions, and receipts. No initial language selector or machine translation. | Approved |
| 5 | Which common clinical phrases are loaded? | The prepared complaint, assessment, dosage-direction, and advice starter lists are approved. Suggestions remain assistive and never diagnose, prescribe, or sign automatically. Doctors may add personal favourites/templates without changing the clinic-wide approved list. | Approved |
| 6 | Who controls consultation templates? | Each doctor controls their personal templates. The owner-doctor, or another explicitly authorized doctor, approves clinic-wide templates. Non-doctor admins manage access/metadata but not clinical content. | Approved |
| 7 | Do unsigned drafts survive sign-out/device change? | Yes. Store drafts server-side, mark them clearly as Draft, recover them for the responsible doctor, and keep them invisible to pharmacy until signed. | Approved |
| 8 | How does prescription printing work? | After signing, print only when requested. Provide physical-signature space and audit every print/reprint. | Approved |

Operational check: confirm Dr. Jayamurugan has the `admin` role before the PIN
reset session; otherwise establish another valid recovery administrator first.

---

## B. Medicines, packages, receiving, and stock

| # | Question | Approved policy | Status |
|---:|---|---|---|
| 9 | Which products may be sold loose? | Tablets and capsules may be sold individually. Other products use configured safe stock bases and package levels. At POS, the pharmacist chooses among configured sellable levels and quantities. | Approved, subject to pharmacist/regulatory validation |
| 10 | What supplier-invoice structure must receiving support? | Support batch, expiry, physical package quantity, free quantity, purchase price and its basis, MRP and its basis, tax, and unit conversion. Final field order/import behavior must be validated against actual clinic invoices/GRNs. | Evidence — real invoices pending |
| 11 | Can package size change between batches? | Yes. Package/conversion definitions are versioned. Existing batches retain immutable receipt-time configuration, MRP basis, and conversion history. | Approved; real changed-pack example requested for acceptance |
| 12 | Who manages medicine/package records? | Pharmacist and admin may create/edit them. A conversion change requires explicit verification against the physical pack before it can receive stock. | Approved |
| 13 | Are liquids decanted or opened containers divided? | No. Bottles, tubes, vials, inhalers, and similar products are handled as complete base units. Ordinary POS must not dispense arbitrary mL, g, drops, puffs, or fractions from them. Tablets/capsules may still be individual base units. | Approved |
| 14 | How is opening stock counted? | Pharmacist performs a blind physical count after closing. Admin/owner reviews discrepancies and recounts where needed before append-only opening adjustments post. | Approved |

Package hierarchy remains recursive and data-driven, for example tablet →
strip → box → case or bottle → carton → case. Receiving and POS preserve the
physical entry but the stock ledger moves an exact base-unit quantity.

---

## C. Consultation fees, dispensing, and patient balances

| # | Question | Approved policy | Status |
|---:|---|---|---|
| 15 | Who sets the consultation fee? | Initial default is ₹300. Admin may change the clinic default. The doctor may override the amount for one consultation only. Store the default snapshot, override amount, doctor, time, and reason in the audit trail. A later admin default change never rewrites old visits. | Approved |
| 16 | Are follow-ups automatically free? Who decides discount/waiver/refund/reversal? | No universal free-follow-up period. The doctor decides per consultation whether it is charged, discounted, or waived. A waived visit remains visible as ₹0/waived with reason and actor. For a completed non-OTC payment, staff may request correction/refund but an admin must authorize the append-only refund/reversal with a reason. | Approved by delegated recommendation |
| 17 | May the doctor collect the fee? Which roles may collect payment, dispense, and sell over the counter? | **Payment** — admin and pharmacy only. A doctor may not collect, and neither may a nurse. **Dispensing a prescription** — pharmacy only. **Over-the-counter sale** — pharmacy only. Medicine handover always requires pharmacist authorization. An admin may review transactions and carry out authorized void, refund, reversal and return workflows, but may not independently dispense or initiate an OTC sale. If no authorized payment-counter staff member is available, the balance remains pending. | Approved; role list extended 12 September 2026 |
| 18 | What happens when a prescribed product is unavailable or partially supplied? | Doctor sees live stock but may prescribe unavailable medicine. The signed prescription has an explicit `valid until` and `may be supplied in parts` direction. Initial clinic default is 7 calendar days from signing; the doctor may shorten or extend it for that prescription. Later supply is a completion, not a refill. After expiry, pharmacy cannot supply the remainder without a new/amended order. Schedule H/H1/X and other restricted medicines use any stricter applicable rule and do not allow later supply unless the prescription and pharmacy policy expressly permit it. | Approved by delegated recommendation |
| 19 | Is stock reserved when a prescription is written? | No automatic reservation. Prescribing never changes stock. Stock moves only when pharmacy completes an actual dispense/sale through POS. | Approved |
| 20 | How do Patient Declined and Doctor Cancelled differ? | Separate statuses. Patient Declined records the patient's choice. Doctor Cancelled records withdrawal by the doctor. Both store actor, time, and reason. | Approved |
| 21 | May a pharmacist change a prescription? | No pharmacist-only substitution in the initial release. A brand-specific prescription requires that product or a doctor-authorized amended/replacement order. For a genuinely generic prescription, the pharmacist may select an in-stock brand only when ingredient(s), strength, form, route, and release characteristics exactly match the signed generic clinical drug; record the actual product and batch. Any change to the prescribed clinical drug, dose, frequency, duration, or a specified brand requires doctor authorization. | Approved by delegated recommendation; pharmacist validates the formulary mapping |
| 22 | How does pay-later work? | Available only for registered patients. Maintain a running balance and immutable payment history. Support partial repayments. No mandatory credit limit or fixed due date initially. No automated reminder policy initially. | Approved |
| 23 | Are payment references required? | Payment method is required. UPI/card reference is optional. Support cash, UPI/GPay, card, and split payments. | Approved |
| 24 | How are receipt numbers handled? | Sequential and never reused. Cancelled/voided transactions retain their number and status; numbers are never silently deleted. | Approved |

The exact consultation-fee value is setup data, not a hard-coded browser
default. Every bill derives status from its line items, payments, allocations,
and reversals rather than one mutable paid/unpaid flag.

### Item 17 in full: who may do what at the counter

Recorded 12 September 2026. This table is the authority; the code below it is
where each line is enforced, and a change here is a change to those gates.

| Action | admin | doctor | nurse | pharmacy |
|---|:-:|:-:|:-:|:-:|
| Take payment (`take_payment`) | ● | | | ● |
| Dispense a prescription (`dispense_rx`) | | | | ● |
| Over-the-counter sale (`otc_sale`) | | | | ● |
| Open and close the till | ● | | | ● |
| Void an invoice (`void_invoice`) | ● | | | |
| Refund a payment (`refund_payment`) | ● | | | |
| Reverse a payment (`reverse_payment`) | ● | | | |
| Reverse a dispense (`reverse_dispense`) | ● | | | |
| Authorise a counter return (`otc_return`) | ● | | | ● |
| Payment reconciliation report | ● | | | ● |
| Patient dues and payment history report | ● | | | ● |

Three things this says that are easy to miss:

1. **An administrator cannot hand medicine over.** Not a prescription, not a
   counter sale. Medicine leaving the shelf always requires a pharmacist. What
   an administrator can do is correct a hand-over after the fact — void,
   refund, reverse, and authorise a return — because every one of those is a
   correction to something a pharmacist did, and corrections are exactly what
   the administrator is for.
2. **A nurse does not touch money.** The retired application allowed it; that
   was inherited, not decided. A nurse's rail no longer carries Billing or the
   Day book, the snapshot sends a nurse no invoices, no patient balances and no
   till, and the two money reports refuse a nurse.
3. **Pending is a correct outcome.** If no authorised counter staff member is
   on, the balance stays pending. Nothing routes around that, and nobody
   acquires the capability by being the only person in the building.

A person holding two roles holds the union of them, so the pharmacist who also
administers the clinic, or the nurse who covers the counter on a day off,
loses nothing — they simply have to hold the role that the action requires.

Enforced in `supabase/functions/_shared/counter.ts` (`take_payment`,
`dispense_rx`, `otc_sale`, `otc_return`, the four reversal commands),
`_shared/commands.ts` (`open_till`, `close_till`), `_shared/snapshot.ts`
(`cashDrawer`), and `functions/reports/index.ts` (the report role matrix).
`components/navigation.ts` and `components/checkout-workspace.tsx` mirror those
gates so the screen offers exactly what the server will accept — mirroring, not
enforcing; the refusal is at the command.

---

## D. Clinical images

| # | Question | Approved policy | Status |
|---:|---|---|---|
| 25 | When and why are images captured? | The doctor decides. Classify images as Before, Progress, After, or Other and associate them with the patient, encounter, series, body site/side where relevant, staff member, and time. | Approved |
| 26 | Who may access clinical images? | Doctor has full clinical access. A nurse may capture/view only while involved in that patient's care. Pharmacist has no access. Admin sees only required audit/technical metadata unless specifically authorized for image content. | Approved |
| 27 | Is consent required? | Yes. Record patient/guardian consent before capture, including consenting person, method, staff member, time, and permitted purpose. | Approved |
| 28 | Can the patient receive images? | Yes, through controlled download/export or print. Never send automatically through WhatsApp. Audit access/export/printing. | Approved |
| 29 | Can an image be edited/deleted, and how long is it retained? | Never silently alter or delete the original. If wrong, mark Captured/Entered in error with actor, time, and reason while retaining audit history. Derived crops/annotations remain separate. Initial retention is 3 years after the patient's last relevant clinical contact, or longer where treatment, complaint, legal hold, or an applicable rule requires it. At the retention boundary, create an admin review queue; do not automatically purge. Any approved deletion is a tombstoned, audited lifecycle event. | Approved by delegated recommendation |
| 30 | What happens after tablet loss/privacy incident? | Admin revokes device/session, forces authentication, disables affected credentials, and reviews audit logs. Patient data remains primarily server-side; image bytes are not placed in local storage or a public gallery. | Approved |

---

## E. Staging findings and production corrections

| # | Question | Approved policy | Status |
|---:|---|---|---|
| 31 | Was the historical consultation fee ever different from ₹300? | Unknown. Do not infer historical corrections. For the new system, use the admin default with visit-level doctor overrides. | Closed as unknown; production evidence may be reviewed later |
| 32 | Did two pharmacy staff historically dispense simultaneously? | No. | Answered; concurrency protection remains mandatory |
| 33 | Are free consultations allowed? | Yes, when the doctor decides. Record an explicit ₹0/waived charge state and reason. | Approved |
| 34 | May an applied migration be edited? | No. Applied migrations are immutable. Corrections use new migrations; clean-baseline work is separately reviewed. | Approved |
| 35 | May old mixed appointment timestamps be corrected? | Yes. Rehearse on a backup/restored copy, verify row-level results, review, and only then run the production correction. | Approved for rehearsed correction; deployment still requires its normal gate |

---

## F. Prescribing scope

| # | Question | Approved policy | Status |
|---:|---|---|---|
| 36 | What clinic work dominates? | Mixed practice: general medicine, paediatrics, diabetes, dermatology, procedures, and other applicable cases. The clinic-curated vocabulary must therefore remain extensible. | Approved |
| 37 | Which diagnosis verification states are needed? | Provisional, Differential, Confirmed, and Ruled Out. | Approved |
| 38 | Generic or brand prescribing? | Both. Search/select by either while always showing ingredient, strength, form, and brand/manufacturer distinctions. | Approved |
| 39 | Does the doctor see stock while prescribing? | Yes, show live availability and alternatives as information, but never prevent prescribing because stock is unavailable. | Approved |
| 40 | Are automatic paediatric/weight-based dose calculations included initially? | No. | Approved |
| 41 | Is a dedicated repeat/refill workflow included initially? | No. | Approved |
| 42 | How are scheduled/restricted medicines classified? | Pharmacist/admin selects a supported regulatory class when creating/editing a medicine, such as normal, H, H1, X, or other. Existing formulary items are classified during setup. Classification stores source/effective/version data and is pharmacist-verified before sale. | Evidence — actual controlled/special-register stock list pending |
| 43 | Which print formats are supported? | A4 prescriptions and configurable 80 mm thermal POS/payment receipts. | Approved |

Regulatory classification controls availability of workflows; it is not merely
a coloured label. Prescription-only/restricted products must be refused from
the anonymous OTC path.

---

## G. OTC and unified counter checkout

| # | Question | Approved policy | Status |
|---:|---|---|---|
| 44 | Who completes OTC sales? | Pharmacist completes the sale/dispensing. Admin may review, correct, or void authorized transactions but does not independently make pharmacy dispensing decisions. | Approved |
| 45 | Are anonymous OTC sales allowed? | Yes, for appropriately classified, fully paid OTC purchases. Normal anonymous sales do not require patient registration. | Approved |
| 46 | Can OTC be part-paid/pay-later? | Anonymous OTC must be fully paid. Part-payment/pay-later is available only when linked to a registered patient account. | Approved |
| 47 | How are OTC returns/refunds handled? | Pharmacist/admin authorization and a reason are required. Returned medicine enters returned/quarantine stock and never becomes automatically saleable. Refund/payment reversal retains the original sale and full audit history. | Approved |
| 48 | Is checkout unified? | Yes. Consultation fee, prescription dispense, and OTC products may be collected in one checkout and shown on one receipt. Every line retains its source, authorization, batch allocations, and audit trail. | Approved |

OTC and prescription lines share checkout/payment infrastructure but not
authorization semantics. An OTC line is an independent sale; a prescription
line is a dispense against an unchanged signed order and may retain a remaining
authorized quantity.

---

## H. Voiding, refunds, reversals, and the over-refunded bill

Items 49–57 were recorded on 12 September 2026, after the administrator-corrections
work met a bill against which more money had gone back out than ever came in.

Items 58–63 were recorded the same day, after the first attempt at enforcing
those left two holes in it: the correction path *out* of an over-refund was
refused by the rule meant to stop anybody entering one, and that same rule
watched only one direction, so a cancelled bill could be walked back *up* into
holding money. Neither reached the clinic.

| # | Question | Approved policy | Status |
|---:|---|---|---|
| 49 | When may a bill be voided? | Only when the net allocated payment against it is exactly ₹0. Above zero, the payment is refunded or reversed first — voiding a bill that has been paid against loses track of money the clinic is holding. Below zero, voiding is refused outright; see item 50. | Approved |
| 50 | What happens when more has gone back out than ever came in? | The bill takes an explicit over-refunded state, and every screen that meets one says the same words: *Over-refunded — financial correction required*. Nothing is changed, no correction is attempted, and the bill goes to the admin/accountant review queue. | Approved |
| 51 | How is a receipt reversed when it is allocated to more than one bill, and what if the refund was the error? | Reversing a receipt calculates the result for **every** invoice it is allocated to and refuses atomically if any of them would fall below zero, naming the refunds that have to be reversed first. An erroneous refund is reversed first; the original payment may then be reversed, and that reversal lands on zero. There is no partial reversal — a receipt is one event and it either happened or it did not. | Approved |
| 52 | What if both the incoming payment and the outgoing refund genuinely happened? | Both events are retained. The case goes to the admin/accountant review queue and a person decides what to do about the money. No automatic balancing transaction is invented. | Approved |
| 53 | May anything be removed to tidy one of these away? | No. No payment, refund, allocation, invoice line or document number is silently erased, mutated or detached. A reversed or refunded receipt keeps its number and its place in the series, as item 24 requires of every cancelled document. | Approved |
| 54 | How is a balance that may be negative read? | Derived balances are read with signed exact-money parsing. A ledger figure that can legitimately be below zero is never read by the validator that checks what a person typed at a counter, because that validator rejects negatives — and its refusal is a complaint about an input, printed at somebody who did not type one. | Approved |
| 55 | Is an over-refunded bill simply unpaid? | No. It is its own derived state, and it is tested before voided so that a voided over-refund cannot hide behind the void. An unpaid bill is resolved by taking payment; this one is not, and filing the two in the same queue is how it comes to be ignored. | Approved |
| 56 | How is an over-refunded bill finally cleared? | Any recovery from the patient, or any write-off, requires accountant approval and is recorded as an append-only event like every other correction. | Partial — the approval rule is decided; the recovery/write-off workflow itself is neither designed nor built, no command in this release closes a row on the review queue, and until it exists the reversals item 59 refuses on a voided bill have no approved way through either |
| 57 | What is the tax treatment where GST applies? | Where GST applies, the credit/debit-note behaviour of a refund that exceeds the payment it reverses must be validated by the clinic accountant before production. | Evidence — clinic accountant's confirmation pending; nothing in this release issues, reverses or adjusts a tax document |
| 58 | May the reversal of a refund be refused because the bill is still over-refunded afterwards? | No. Money going back OUT can only ever move a bill towards zero, so reversing an active refund is permitted even when the bill remains below zero after it. A bill at −₹80 carrying two ₹40 refunds is walked back one refund at a time and the first step lands on −₹40; refusing that step leaves the only exit from the state blocked by the rule that exists to stop anybody entering it. This is the correction path out of an over-refund and it stays open. | Approved |
| 59 | What may be done to a bill after it has been voided? | Nothing that moves its balance. No receipt allocated to a voided bill may be reversed — refunds included — and no refund may be taken against one. A cancelled bill stays at net ₹0. This closes the case where ₹100 was taken, ₹100 refunded, the bill voided at zero and the refund then reversed, leaving a cancelled bill holding ₹100 of the patient's money and no screen that would ever mention it. Putting one right is the accountant-approved correction of item 56. | Partial — the refusal is decided and enforced; the correction that would lift it is item 56's workflow, which is neither designed nor built |
| 60 | Does reversing an incoming payment stay refused when it would take a bill below zero? | Yes, unchanged from item 51. The result is computed for **every** invoice the receipt is allocated to, the whole reversal is refused atomically if any of them would fall below zero, and the refunds that have to be reversed first are named. Item 58's exception is for money going out and never for money coming in: reversing a payment is the one direction that can create an over-refund. | Approved |
| 61 | How is a voided bill that is already off zero in the carried-over history reported? | As its own derived state, `void_with_balance` — status void and net allocated payment not ₹0, in **either** direction — tested before over-refunded, because of the two true things about a voided bill at −₹40 the one that tells somebody what to do is that it was cancelled with money still against it. Money held against a cancelled bill and money refunded past one are different errors; neither is hidden behind the word `void`, and both are carried on the financial review queue with their receipts. | Approved |
| 62 | How do these refusals behave when two people act at once? | Row locks are taken in the order every other counter command takes them — the receipt, then its invoices in id order — and status and balance are read after the lock, so a void committing alongside a reversal is either already visible to it or waiting behind it. Every refusal is atomic and a refused command changes nothing at all: a receipt is one event and there is no partial reversal. | Approved |
| 63 | Does anything invent a balancing entry to tidy one of these away? | No, and item 52 holds identically for the voided case. No adjustment line, no ₹0 correcting receipt, no netting the two directions off against each other, no automatic write-off. Both events stand, the bill is named on the review queue, and what happens to the money is item 56's. | Approved |

An over-refund is not a mess to be swept up. It is two true statements about
real money — a refund went out, and the receipt it was taken against turned out
never to have settled — and the clinic is genuinely down the difference. What
the system owes is that a new one cannot be created silently, an old one cannot
hide behind a void, and neither can be mistaken for an ordinary debt. What to do
about the money is the accountant's, and items 56 and 57 say plainly that nobody
has answered that yet.

A cancelled bill that is not at zero is the same obligation read the other way.
The document says nothing was owed and the ledger says money changed hands, and
whichever direction it went in, that disagreement is not resolved by picking one
of them. So it is refused rather than repaired: no receipt on it is reversed,
nothing further is refunded against it, and it is named on the review queue in
the direction it is actually out. The one refusal that is never added is the one
that would close the way back — item 58 — because a rule that blocks the exit
from a bad state is not caution, it is a trap.

---

## I. Remaining facts, evidence, and hardware validation

All owner-policy choices recorded here for the implemented application and
backend Slice 2 are answered. Backend Slice 3's messaging-policy gate is also
answered by items 76–83, although that slice has not started. Later backend
slices retain their own explicit decision gates in
`reference/BACKEND_PROGRAMME_REGISTER.md`. The following cannot be
invented by recommendation and remain clinic setup/acceptance tasks:

1. Provide two or three redacted supplier invoices/GRNs so receiving, free
   quantity, tax, MRP basis, and purchase-price basis can be validated.
2. Provide real package examples, including a changed-size/MRP example and
   available package-level barcodes.
3. Classify every existing medicine during setup and provide/confirm the actual
   controlled or special-register stock list. Until reviewed, an existing item
   remains `Unknown / pharmacist review required` and is blocked from anonymous
   OTC sale.
4. Confirm Dr. Jayamurugan's production admin role before PIN resets. Never
   infer or automatically grant the role.
5. Test the actual A4 and 80 mm printers, including margins, long medicine
   names, page breaks, duplicate/reprint marking, and offline/retry behavior.
6. The clinic accountant must define how an over-refunded bill is finally
   cleared (item 56): who approves a recovery or a write-off, what document it
   produces, and how it is recorded. Until then a bill stays on the financial
   review queue and no command in the application closes it. The same missing
   workflow is what item 59 refuses against — a receipt on a voided bill cannot
   be reversed and nothing further can be refunded against one — so a cancelled
   bill carried across off zero also waits on this.
7. The clinic accountant must confirm the GST treatment of a refund that
   exceeds the payment it reverses (item 57): whether a credit or debit note is
   required, against which original document, and in whose name.

Items 1–3 gate Slice 3 production acceptance. Item 4 gates the PIN-reset
appointment. Item 5 gates print rollout. Items 6 and 7 gate *clearing* a bill
under financial review in production — over-refunded, or cancelled and not at
zero; they do not block the review queue itself, which only reports what the
ledger already says. None of them block schema/UI work with guarded staging
fixtures.

Medicine administration on the nurse's round was carried here briefly as an
eighth item. It is not an evidence gate and it is no longer open: the owner
deferred it from this release on 13 September 2026, and it is recorded as
item 64 in section K.

---

## J. Standing safe defaults

- No automatic diagnosis, cause, medicine, or dose selection.
- No automatic substitution.
- No stock reservation at prescription time.
- No stock movement until a completed receipt, dispense, sale, return,
  write-off, stock-take adjustment, or explicit reversal.
- No negative stock.
- No expired, recalled, quarantined, or blocked batch allocation.
- No anonymous credit/pay-later.
- No pharmacy access to clinical images.
- No automatic WhatsApp delivery outside the purposes and controls in items
  76–83. Until backend Slice 3 is implemented and accepted, no automatic
  WhatsApp delivery exists at all.
- No silent edit/delete of signed clinical, stock, payment, receipt, or image
  history.
- No automatic balancing entry for an over-refunded bill, or for a cancelled
  bill that is not at ₹0 in either direction. Both events stand, the bill goes
  to the review queue, and the correction is an accountant's decision rather
  than one the system makes for them.
- No reversal of any receipt allocated to a voided bill, and no refund taken
  against one, until an accountant-approved correction workflow exists. A
  cancelled bill stays at net ₹0.
- No voided bill left holding money quietly. A cancelled bill off zero is
  detected and carried on the financial review queue whichever side of zero it
  is on, and the word `void` is not allowed to stand in for the arithmetic.
- No refusal of the reversal of a refund on the ground that the bill is still
  below zero afterwards. That reversal only ever moves a bill towards zero and
  it is the way back out; a rule that blocks the exit from a bad state is not a
  safe default.

---

## K. Nursing observation and medicine administration

| # | Question | Approved policy | Status |
|---:|---|---|---|
| 64 | Does this release record medicine given to, or skipped for, a patient under observation? | **No. Deferred to a future release.** The clinic continues to work the way it works today: the doctor writes what the patient is to be given as a free-text observation instruction on the bed, the nurse reads it there, and what happened is recorded as an observation note in the same timeline. The nurse's **Due now** round therefore carries the queue, the readings, the observation checks and the handoffs, and carries no dose list. Nothing in the application schedules a dose, marks one due, or records one as given or skipped. | **Approved — deferred 13 September 2026** |

This is a decision about clinical scope, not an unfinished screen. The Due-now
workspace is complete against it: every task it shows has an authoritative
record behind it, which is the property that makes it worth trusting. A dose
list with nothing behind it would have been worse than no dose list at all, on
the one screen whose whole job is to be the authority on what is still
outstanding.

### Item 64 in full: what a later release must answer first

Medicine administration is a clinical subsystem, not a panel. Building it means
answering all of the following, and section J's standing safe defaults and item
62's concurrency rule apply to whatever is decided:

1. **Who orders a dose?** Only the doctor who admitted the patient, any doctor,
   or may a nurse enter a standing instruction the doctor later countersigns?
2. **What makes a dose due?** A fixed clock time, an interval from the previous
   dose, or a frequency like a prescription's `twice_daily` resolved against the
   clinic's own hours? What is the window before it counts as overdue, and does
   an overdue dose escalate to the doctor the way an observation check does?
3. **What is recorded when one is given?** Actor, time, medicine, dose and route
   are obvious. Is a second person's check required for any class — Schedule H1,
   injections, paediatric doses — and is the route recorded per administration
   or inherited from the order?
4. **What is a skip?** Patient refused, asleep, nil by mouth, vomited it back,
   not available on the trolley, clinically withheld by the nurse. Do these share
   one reason list, and which of them must reach the doctor rather than sitting
   in the shift record? Item 20 draws the Patient Declined and Doctor Cancelled
   distinction for prescriptions; does the same wording apply here?
5. **Does giving a dose move stock?** If the medicine comes off the pharmacy
   shelf, administration is a dispense and everything in section C and the FEFO
   rules applies to it. If the observation room holds its own trolley, that is a
   second stock location the application does not have, and it needs receiving,
   counting and expiry of its own.
6. **Who pays for it, and when?** A dose given in observation is either billed as
   a medicine line on the visit's invoice, included in an observation charge, or
   not billed. Item 48's one-checkout rule decides where the line appears once
   this is answered.
7. **What happens to an unfinished round at handover or discharge?** Does an
   undue dose follow the patient out, is the order closed, and who is
   accountable for a dose that was due while nobody was on the ward?

Until these are answered, `set_observation_instructions` and `record_observation`
are the clinic's medicine-administration record, and they are the doctor's
words and the nurse's note rather than a structured order and a structured
administration. That is a real limitation and it is stated here rather than
papered over on a screen.

---

## L. Appointments and consultation-attempt reconciliation

Items 65–74 were approved on 15 September 2026. Items 65–71 govern the future
appointment domain. Items 72–74 are one reconciliation policy: a lost response,
an immutable signed encounter, and a later queue row must never become a second
consultation or fee through an automatic release or mint.

| # | Question | Approved policy | Status |
|---:|---|---|---|
| 65 | How long is an appointment, and may it vary? | The default appointment duration is **15 minutes**. An appointment type may define a different duration, managed by a doctor or admin. A type change does not rewrite the duration already recorded for an existing booking. | Approved |
| 66 | How far ahead may an appointment be booked or rescheduled? | Up to **90 calendar days** ahead, measured using the clinic's local day. The same horizon applies to booking and rescheduling. | Approved |
| 67 | Is overbooking permitted? | Overbooking is off by default. A doctor or admin may override a conflict only through an explicit action that records actor, time, and a required reason. A nurse cannot overbook. | Approved |
| 68 | Who may cancel or reschedule, and when? | There is no minimum notice period initially. Before check-in, nurse, doctor, or admin may cancel or reschedule. After check-in, only doctor or admin may do so, with a required reason. No appointment is silently deleted: the prior state, actor, time, and reason remain in append-only history. | Approved |
| 69 | What is a no-show, and who marks it? | An appointment becomes eligible for no-show review **30 minutes after its scheduled start**. Nothing marks it automatically. Nurse, doctor, or admin confirms the no-show, and the actor and time are recorded. | Approved |
| 70 | Where do booked patients and walk-ins sit in the queue? | A future booking does not enter the live queue until check-in. At check-in, booked patients and walk-ins converge into the same arrival/queue workflow and are ordered by actual arrival/check-in time. A doctor may explicitly prioritize an urgent patient, with a required reason and audit event. | Approved |
| 71 | Who may edit availability? | Doctor and admin may create or edit provider availability. A nurse may book, reschedule, or cancel within published availability but may not change the availability itself. An availability change never silently cancels or moves an existing booking. | Approved |
| 72 | What happens to a visit left waiting when its consultation was signed before the visit existed? | Never rewrite the signed encounter and never automatically cancel the visit. A doctor resolves it explicitly as **Same attendance** or **New attendance**. Same attendance creates an append-only audited reconciliation link and closes the leftover visit without another encounter or fee. New attendance keeps the visit available for a fresh consultation. Record actor, time, reason, the encounter, and the visit. | Approved |
| 73 | When may an attempt be released after a non-rotating refusal? | Never release it merely because a refusal was shown, dismissed, or time elapsed. The server first establishes the prior key's outcome. The doctor then explicitly resolves whether the work is the same attendance, a genuinely new attendance, or an abandoned attempt whose opened visit is no longer active. Only that audited resolution, or an already-confirmed successful replay, may release the attempt. If the outcome cannot be established, fail closed. | Approved |
| 74 | What happens when an unresolved attempt opened on visit A meets a different live visit B? | Do not automatically mint a new attempt. First establish the old key's outcome. If A committed, the doctor chooses **Same attendance**—reconcile and close B without another encounter or fee—or **New attendance**—explicitly settle the old attempt, then mint for B. If A did not commit, the doctor explicitly chooses which active attendance continues; the abandoned path is preserved in audit. If the outcome is unknown, fail closed. Reception creating B is not, by itself, proof of a second consultation. | Approved |

These policies authorize backend commands and contracts in Slice 2. They do not
authorize a visual redesign in the backend programme. The later frontend
programme must expose the doctor-owned resolution clearly, without reducing it
to an automatic retry, a timeout, or a text-message dismissal.

Implementation status, 17 September 2026: the bounded consultation safety
cutover now exposes that doctor-owned resolution in the existing workspace. It
holds the original attempt across visit changes and releases it only after the
backend-confirmed or durably audited outcomes permitted above. This records
implementation status only; it changes no policy and does not mark the wider
appointment UI or frontend programme complete.

**Implemented 15 September 2026 and corrected 16 September 2026 after an
acceptance review reproduced six faults**, including a nurse booking at three in
the morning where item 71 says "within published availability", and a signing
that wrote an encounter and a fee against the wrong visit where item 74 says the
doctor chooses. After six bounded correction rounds, the slice was **accepted
on 17 September 2026**. Backend only —
`docs/reference/BACKEND_PROGRAMME_REGISTER.md` §12 records what each item
became and
`docs/reference/SLICE2_FRONTEND_CONTRACT.md` is the contract for the screens.
One reading had to be chosen where the text did not decide, and it is recorded
as a technical default rather than as policy: **a doctor booking outside their
own published hours is allowed**, through the same recorded override item 67
defines for a conflict. Item 71 constrains the nurse and is silent about the
doctor, who owns the hours. The owner may narrow it.

A second reading was chosen and was wrong. The first implementation decided
that a day with nothing published constrained nobody, so a nurse could book any
hour of it; item 71 says *within* published availability and admits no
exception, and the acceptance review reproduced a nurse booking a patient for
three in the morning. A day with no open window is now a day a nurse cannot
book, and the clinic is not locked out because a doctor or an admin books it
with the override above.

Nothing here was promoted to policy that the owner did not decide. In
particular the 480-minute ceiling on an appointment type is an implementation
safety bound and **not** part of item 65, which the first implementation
wrongly cited for it.

**One thing items 72–74 ask for is not yet in front of anybody.** The
doctor-facing resolution is a screen, and until the frontend programme builds
it the tablet still starts a fresh reference when a patient is re-queued — so
the second fee those items exist to prevent is still reachable from the build
the clinic is running. The backend refuses it; the tablet does not yet ask.

---

### 75. Linking a same attendance to a visit already finished

**Decided 16 September 2026, during the fourth acceptance review of Slice 2.**

> A doctor may retrospectively link `same_attendance` to a same-patient visit
> already marked done. Record whether the resolution closed it now or found it
> already done; never claim the resolution performed a closure it did not
> perform. A cancelled visit remains ineligible until separately corrected.
> Other open visits remain untouched.

Item 72 was written for the ordinary shape — the leftover queue row is still
waiting and the determination closes it. The shape this answers is the one a
busy queue produces: somebody tidies the queue, or the visit is closed by
another hand, and the doctor comes to reconcile afterwards. Before this, the
only honest answers were to refuse (leaving item 72's link unrecordable) or to
accept and record a closure that never happened.

**What it means in the records.** `consultation_attempt_resolutions` carries
`subject_visit_disposition`, one of:

| Value | Meaning |
|---|---|
| `closed_now` | this determination closed the visit it named |
| `already_done` | the visit was already finished; the link is retrospective and no closure is claimed |
| `not_applicable` | no visit was named, or this determination does not close visits |

It is a field of its own rather than a second meaning for
`subject_visit_closed`, because a boolean cannot hold three answers and the
attempt to make it do so is what produced the false sentence. The boolean is
kept in step by a check constraint so that anything reading it reads what it
always meant.

**A cancelled visit stays ineligible.** It was not an attendance, so a
consultation cannot be the same attendance as it. If the cancellation was the
mistake, that is its own correction and comes first.

**Nothing else moves.** Other open visits are untouched, no encounter and no
fee is written, and a visit reconciled as the same attendance never returns to
the queue — enforced by `appointments_reconciled_visits_stay_closed`, because
without it the closure could be undone and the attendance consulted and charged
a second time.

---

## M. Patient messaging, reminders, and clinical recalls

Items 76–83 were approved on 17 September 2026. They close backend decision
register entries D8–D12c. They authorize Slice 3's backend contracts and
workers; they do not provision a provider, send a live message, or authorize a
frontend redesign.

> **Implementation note, 18 September 2026.** Slice 3A turned these eight items
> into schema and code — `docs/SCHEMA_AND_TYPES.md` §15. It has sent nothing
> and provisioned nothing. Two numbers in it have no owner decision behind them
> and say so where they are defined: the retry spacing inside item 79's ceiling,
> and the moment a clinical recall stops being worth sending on its due date.
> One phrase was interpreted: item 79's “four clinic hours” is read as four
> elapsed hours moved forward to the next dispatch opening if that would land
> outside clinic hours, so a failure at seven in the evening reaches the
> owner-doctor at eight the next morning rather than at eleven at night. If
> that is not what was meant, one expression changes.

> **Implementation note, 18 September 2026 (Slice 3B).** The adapter, the
> signed statuses webhook and the protected worker contract are built —
> `docs/SCHEMA_AND_TYPES.md` §16. **Nothing has been sent and no scheduler is
> provisioned**, and the release gates in the closing paragraph below are
> untouched and unwaived.
>
> Three things in it are worth the owner's attention rather than being buried:
>
> 1. **Item 79's clock now starts on an outcome nobody knows.** A message whose
>    provider reply was lost is recorded as `outcome_unknown` — not sent, not
>    failed — and is never retried, because Meta documents no idempotency
>    mechanism on its send endpoint and a blind retry is how one reminder
>    becomes two. Slice 3B starts the four-clinic-hour escalation clock on that
>    state, so it can reach the owner-doctor's queue. Without it such a message
>    would sit in the admin's queue for ever. It is still not called a failure.
> 2. **A defect Slice 3A shipped is fixed.** A queued message whose usefulness
>    deadline passed was silently dropped from the worker's candidate list and
>    left at `queued`, which is not a status the failure queue reads — so the
>    clinic would never have learned that a patient had not been told. It is
>    now suppressed with `past_useful_by` and appears in the admin's queue.
> 3. **Two numbers and one payload shape have no owner decision and no live
>    validation behind them**, and say so where they are defined: a thirty-second
>    provider timeout, a fifteen-minute age before an abandoned call is written
>    off, and whether the clinic's approved Meta templates take named or
>    positional parameters. The third is one constant, to be confirmed against
>    the real account before the first send.

| # | Question | Approved policy | Status |
|---:|---|---|---|
| 76 | Which channel is used for patient messaging? | Use **both**, for different jobs. Automated clinic-initiated patient messages use only the official WhatsApp Cloud API. Patient-initiated conversations and a staff-confirmed fallback may start through a `wa.me` deep link or QR code. A deep link never masquerades as an automated delivery, and no unofficial WhatsApp library or QR-paired automation is permitted. If the official channel is unavailable or not approved, suppress the automated send and put the work in a staff queue. | Approved |
| 77 | When are reminders sent, and what are the quiet hours? | Use the clinic's configured local time. Business-initiated messages may be dispatched from **08:00 inclusive until 20:00 exclusive**. Send at most one appointment reminder, at **18:00 on the previous clinic-local day**; if the booking or reschedule occurs after that point, its confirmation replaces the reminder. Send one clinician-selected follow-up recall at **09:00 on its due date**. Do not send automatic repeat/chase messages. A delivery retry is not a new reminder, may not cross the message's usefulness deadline, and must still obey quiet hours. A patient-initiated conversation may receive its direct service reply inside the provider's permitted conversation window. | Approved |
| 78 | Is registration consent sufficient? | Consent is **per channel and per purpose**, not a blanket registration flag. At minimum, appointment operations and reminders, clinician follow-up/recall, ready-for-collection notices, and clinic service-interruption notices are separate purposes. Consent evidence records the clinic name, WhatsApp as the channel, purpose, wording/version, source, actor where applicable, and time. A registration choice is valid only for the purposes it names. A patient initiating one conversation permits replies to that conversation; it is not standing consent for unrelated future pushes. | Approved |
| 79 | Who owns a failed delivery, and when does it escalate? | The admin owns the delivery-failure queue from the first failed attempt. Appointment-contact failures are also visible to nurse/admin; follow-up or recall failures are also visible to the responsible doctor. Retryable failures may make at most **three provider attempts within two hours**, subject to quiet hours and the usefulness deadline. A terminal failure or exhausted retry escalates immediately; any unresolved failure older than **four clinic hours** escalates to the owner-doctor's queue. A manual call or other fallback is recorded explicitly and never inferred from a provider response. | Approved |
| 80 | What may a recall cohort be, and who releases it? | A recall cohort is a saved, reviewable set of **individual doctor-authored recall instructions** sharing a named purpose and due window. It is never the whole patient register, an ad-hoc search result, a diagnosis/medicine list, or a marketing audience. An admin may prepare and dry-run it, but only an authorized doctor may release it. Release freezes the recipient set and template version; consent, eligibility, completion/cancellation, and opt-out are rechecked for each patient immediately before queueing. | Approved |
| 81 | Who approves a message template, and what requires a new version? | The owner-doctor or another explicitly authorized doctor approves patient-facing wording, purpose, allowed variables, and link destination. An admin may manage metadata and provider submission but may not approve clinical wording. Any change to wording, purpose, variables, locale, destination, or provider category creates a new immutable version and requires clinic approval plus any provider approval. Queued messages retain their pinned version. Templates are English-only initially, defensibly utility, contain the fact and a controlled link rather than clinical detail, and never include medicine names, diagnoses, or balances. | Approved |
| 82 | How does a patient opt out? | A patient may opt out in the chat or through a staff-recorded, verified request. A purpose-specific request withdraws only that purpose; an unqualified request such as “stop WhatsApp” withdraws **all clinic-initiated WhatsApp purposes**. Withdrawal suppresses every unsent scheduled/queued message immediately and has no staff override. A later patient-initiated conversation does not silently restore standing consent; re-enrolment requires a new explicit opt-in record. | Approved |
| 83 | What makes a patient eligible for clinical recall? | Eligibility begins only when a doctor explicitly records **recall/follow-up required**, a purpose, due date, and responsible doctor for that patient. A query result, diagnosis, medicine, missed appointment, unpaid balance, or elapsed time cannot create eligibility. Completing, cancelling, or superseding that instruction removes eligibility before release. Appointment reminders derive from the booking state and are not clinical recall eligibility. | Approved |

These policies preserve the existing boundaries: item 22 still forbids automated
pay-later/debt reminders, item 28 still forbids automatically sending clinical
images, and a message carries no clinical record. Every attempted send must be
a durable row with an idempotency key before provider contact, and delivery
state comes from authenticated provider evidence rather than a successful HTTP
response. Provider terms, Meta policy, Indian privacy requirements, credentials,
templates, and the clinic privacy notice must be revalidated before production
release; this approval does not waive that release gate.

---

## N. Investigations, referrals, results, review and result notification

Items 84–88 were approved on 19 September 2026. They close backend decision
register entries D13–D17. They authorize Slice 4's backend contracts — the
catalogue, the order, the received result, the clinical review and the
notification authorization — and they do not provision a provider, send a live
message, contact an external laboratory, or authorize a frontend.

The through-line in all five is the same sentence written five ways: **a
clinical judgment has a clinician's name on it, or it does not exist.** A flag
the application inferred, a review the laboratory performed, a release the
clock granted and a delivery an HTTP 200 implied are all the same mistake — a
fact with no author — and each of the five items below refuses one of them.

| # | Question | Approved policy | Status |
|---:|---|---|---|
| 84 | Who owns the investigation and referral catalogue? | The **owner-doctor** owns it. Another **explicitly authorized registered doctor** may approve, publish, version, retire, or replace clinical catalogue content. An administrator may prepare non-clinical metadata — external facility details, codes, operational labels — but may not approve clinical content. Nurses and pharmacy users may not approve or alter clinical catalogue content. "Doctor-level" never means a non-doctor holding an elevated software permission: the actor must hold the doctor role, and explicit authorization is an additional requirement on top of it, never a substitute for it. | Approved |
| 85 | Where may an abnormal, urgent or critical flag come from? | From exactly three places: an **explicit flag on the received external report**, with its source and provenance recorded; an **imported structured flag** from an identified source; or an **authorized doctor's manual clinical flag**, with actor, time, classification and reason. Never inferred from free text, a reference range, OCR, a diagnosis, an AI model, or a threshold the application authored. A nurse or administrator may accurately transcribe a source-provided flag together with its provenance; they may not originate a clinical judgment. Pharmacy has no access. | Approved |
| 86 | Who must review a result before the patient may be told? | The **responsible or ordering doctor, or an explicitly delegated doctor**, must clinically review every received or corrected result before the patient may be told that it is ready. External-laboratory technical validation and signatory evidence are retained as evidence, and do **not** replace the clinic doctor's clinical review. Nurses and administrators may attach, transcribe and operationally track results within minimum-necessary access; they may not mark a result clinically reviewed and may not authorize clinical release. Pharmacy users must not see result content or invoke result workflows. | Approved |
| 87 | How long before an unreviewed result escalates, and to whom? | A **source-identified or doctor-identified critical result** raises an immediate internal alert to both the responsible doctor and the owner-doctor, and requires a doctor acknowledgement. If it is unacknowledged after **15 minutes** it remains visibly escalated to the owner-doctor and any explicitly configured backup doctor, carrying a manual-escalation obligation. Other unreviewed results escalate to the owner-doctor after **four clinic hours or at clinic closing, whichever is earlier**. Elapsed time never releases a result to the patient and never notifies one. | Approved, with the closing-time interpretation recorded below |
| 88 | May a patient-facing notification contain clinical detail? | No. An automated notification may say only: **"Your investigation result has been reviewed and is ready. Please contact the clinic."** It must carry no result value, no abnormal or critical status, no diagnosis, no medicine, no clinical advice, no attachment, no report image and no download link. Critical-result communication is **clinician-led direct contact**, not an automated generic message. Notification requires completed doctor review **plus a separate doctor authorization**. Authorization, provider acceptance, delivery and manual patient contact are four distinct facts; the patient is never reported as notified on the strength of an authorization, a queue entry, an HTTP success response or provider acceptance. The final outcome comes from authenticated provider evidence or from an explicit audited manual-contact event. | Approved |

### Item 87's closing time, which the clinic has not configured

Item 87 names two boundaries — four clinic hours, and clinic closing — and
takes whichever falls first. The first is a duration and needs nothing. The
second is a daily clinic-local time, and **this application does not hold
one.**

What it holds is `provider_availability`, which is one doctor's published
consulting windows and is optional, per-doctor and per-weekday; a clinic that
has published none would have no closing time at all. What it also holds is
the 20:00 clinic-local end of owner item 77's **messaging dispatch window**,
which is a rule about when it is decent to send a patient a WhatsApp message
and is not a statement about when the clinic's doors shut.

So the implementation uses 20:00 clinic-local as a **conservative technical
ceiling** on the unreviewed-result escalation, and says so where it is defined
rather than describing it as the clinic's closing time. It is a separate named
constant from the dispatch cutoff, so that setting the real one is a one-line
change and not an archaeology exercise. The effect is that an unreviewed
result never waits past 20:00 for the owner-doctor to be told about it, and
reaches them earlier if four hours have passed.

**If the clinic closes before 20:00 — and a clinic that starts at 09:00
usually does — this ceiling is later than item 87 intends.** It is not a
different rule; it is the same rule with the only boundary this application
can prove. One owner value closes it: the clinic's local closing time. Until
then the four-hour half of item 87 is exact and the closing-time half is an
upper bound that never escalates later than the messaging day ends.

### What these five items do not authorize

They do not make this application a laboratory system. There is no analyzer
integration, no structured result vocabulary, no patient portal and no screen.
A result arrives here as the report the laboratory actually sent, preserved as
it was sent, with whatever flag the laboratory itself put on it.

They do not claim the application verifies anybody's professional
registration. Item 84 requires a registered doctor, and what the application
can prove is the doctor role plus the explicit authorization flag an
administrator sets. **Whether that person holds a current medical registration
is an onboarding and governance obligation the clinic owns**, recorded here as
a dependency rather than implied by a permission check.

They do not waive the release gates in section M's closing paragraph. A
result-ready notification is a clinic-initiated WhatsApp message and needs the
same approved template, credential, privacy notice and provider validation
every other one needs, and needs its own purpose-specific consent on top.

---

## O. Policy rationale references

- CDSCO, [Drugs Rules, 1945](https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/drug_rules/Drugs%20Rules%201945_2024%2009.pdf), Rule 65: scheduled prescription dispensing, repeat directions, substitution restrictions, records, expiry segregation, and registered-pharmacist supervision of supply outside the manufacturer's container.
- Pharmacy Council of India, [FAQ on registered-pharmacist responsibility](https://pci.gov.in/en/faqs/), including dispensing only the medicine prescribed and not substituting the prescription.
- National Medical Commission, [Code of Medical Ethics Regulations, 2002](https://www.nmc.org.in/rules-regulations/code-of-medical-ethics-regulations-2002/), including the three-year medical-record baseline cited when choosing the initial image-retention review point. Local/applicable requirements may require longer retention.
