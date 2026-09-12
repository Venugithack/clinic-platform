# Owner policy register

**Jayamurugan Clinic**  
**Owner-supplied decisions recorded 11 September 2026**

This is the authoritative product-policy register for the current programme.
It supersedes the open-question status in `OWNER_DECISIONS.md`, while retaining
that file as the historical explanation of why each question was raised.

These decisions authorize product behavior; they do not replace review by the
treating doctor, registered pharmacist, accountant, privacy adviser, or the
applicable regulator where their approval is required.

Status meanings:

- **Approved** — the owner supplied a complete product direction.
- **Partial** — the direction is known, but one named value or boundary remains.
- **Evidence** — policy is decided; real clinic material is still needed for
  validation.

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

All known owner-policy choices are now answered. The following cannot be
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
- No automatic WhatsApp delivery.
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

## K. Policy rationale references

- CDSCO, [Drugs Rules, 1945](https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/drug_rules/Drugs%20Rules%201945_2024%2009.pdf), Rule 65: scheduled prescription dispensing, repeat directions, substitution restrictions, records, expiry segregation, and registered-pharmacist supervision of supply outside the manufacturer's container.
- Pharmacy Council of India, [FAQ on registered-pharmacist responsibility](https://pci.gov.in/en/faqs/), including dispensing only the medicine prescribed and not substituting the prescription.
- National Medical Commission, [Code of Medical Ethics Regulations, 2002](https://www.nmc.org.in/rules-regulations/code-of-medical-ethics-regulations-2002/), including the three-year medical-record baseline cited when choosing the initial image-retention review point. Local/applicable requirements may require longer retention.
