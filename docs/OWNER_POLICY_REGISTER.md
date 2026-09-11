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
| 17 | May the doctor collect the fee? | No. Payment is collected at pharmacy/payment counter. If that counter is unavailable, the charge remains pending. | Approved |
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

## H. Remaining facts, evidence, and hardware validation

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

Items 1–3 gate Slice 3 production acceptance. Item 4 gates the PIN-reset
appointment. Item 5 gates print rollout. They do not block schema/UI work with
guarded staging fixtures.

---

## I. Standing safe defaults

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

---

## J. Policy rationale references

- CDSCO, [Drugs Rules, 1945](https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/drug_rules/Drugs%20Rules%201945_2024%2009.pdf), Rule 65: scheduled prescription dispensing, repeat directions, substitution restrictions, records, expiry segregation, and registered-pharmacist supervision of supply outside the manufacturer's container.
- Pharmacy Council of India, [FAQ on registered-pharmacist responsibility](https://pci.gov.in/en/faqs/), including dispensing only the medicine prescribed and not substituting the prescription.
- National Medical Commission, [Code of Medical Ethics Regulations, 2002](https://www.nmc.org.in/rules-regulations/code-of-medical-ethics-regulations-2002/), including the three-year medical-record baseline cited when choosing the initial image-retention review point. Local/applicable requirements may require longer retention.
