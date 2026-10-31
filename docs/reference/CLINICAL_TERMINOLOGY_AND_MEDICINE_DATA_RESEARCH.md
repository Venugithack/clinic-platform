# Clinical terminology and medicine-data research

**Jayamurugan Clinic · research and implementation recommendation**  
**Evidence reviewed through 10 September 2026**

This report answers the question raised in the clinic-owner session: how far the
platform should go in preloading complaints, diagnoses, causes, medicines,
dosage forms, and physical medicine packages without making the doctor's or
pharmacist's work unsafe or complicated.

It is written for the clinic owner, the implementing team, and the clinician or
pharmacist who will approve the final dictionaries. It is a product and data
architecture recommendation, not medical, prescribing, pharmacy, or legal
advice. Clinical content must be approved by the doctor. Pharmacy workflow and
regulatory classifications must be approved by a registered pharmacist and
checked against the rules applicable to the clinic.

---

## Executive conclusion

This is deep-water territory, but it is manageable if the product is divided
into three deliberately different layers:

1. **Authoritative reference terminology** supplies stable identities and
   meanings: SNOMED CT for clinical terms, CDCI for Indian medicines, LOINC for
   observations and laboratory tests, UCUM for measurable units, and ICD for
   classification and reporting.
2. **A clinic-curated working set** contains the complaints, findings,
   diagnoses, instructions, and medicines Jayamurugan Clinic actually uses,
   ranked using the doctor's favourites and recent selections.
3. **Local operational records** describe the things on this clinic's shelf:
   package SKU, pack hierarchy, barcode, batch, expiry, MRP, purchase price,
   quantity, and supplier.

The platform should preload names, synonyms, codes, strengths, forms, routes,
and reusable wording. It should not preload an automatic chain of
“symptom → diagnosis → cause → medicine.” A terminology can help the doctor
find and record a concept; it does not decide that the concept is true for a
patient. The same separation applies to medicines: a coded match can identify
the same ingredients, strength, and form, but it does not by itself authorize
therapeutic substitution.

The recommended product behavior is therefore:

- fast search and autocomplete constrained to the correct type of information;
- common clinic terms and products shown first, with the wider terminology
  available as a fallback;
- explicit clinical status such as provisional, differential, or confirmed;
- an optional, qualified aetiology/relationship rather than a universal
  “cause” dropdown;
- structured medicine identity separated from dosage instructions;
- package SKU separated from batch/lot;
- every prescription line retaining a signed human-readable snapshot;
- every partial supply recorded as a new dispense event against that unchanged
  prescription line;
- no automatic diagnosis, treatment recommendation, or pharmacist substitution.

The current application cannot support this safely with its present
single-text diagnosis, JSON-only prescription lines, free-text medicine unit,
single barcode, and binary dispensed timestamp. Those fields are useful
migration sources, but they should not remain the target model.[1]

---

## 1. What “preloaded clinical information” should mean

### 1.1 It is not one giant diagnosis dropdown

Clinical documentation contains different kinds of statements. Combining them
into one list makes search noisy and destroys meaning.

| What the clinician is recording | Example | Recommended representation |
|---|---|---|
| Presenting complaint | “fever for two days” | complaint/finding plus duration and patient wording |
| Symptom or sign | “cough”, “wheeze” | coded clinical finding where possible |
| Objective observation | temperature, SpO2, blood pressure | observation type, value, unit, time, performer |
| Assessment/diagnosis | “viral upper respiratory infection” | condition assertion with verification status |
| Aetiology | “due to…”, “caused by…” | a more specific diagnosis or an explicit qualified relationship |
| Risk factor | smoking, exposure, family history | separate observation/history item; not labelled as proven cause |
| Plan | test, medicine, referral, review | separate orders and plan records |
| Patient instruction | “after food”, “return in five days” | structured instruction plus printable text |

India's EHR Standards identify SNOMED CT as the primary clinical terminology,
LOINC for tests and observations, and WHO classifications such as ICD primarily
for reporting and aggregated analysis.[2] This supports separate, typed
clinical fields rather than treating an ICD list as the consultation interface.

### 1.2 The correct answer to “diagnosis and its cause”

There is no safe universal table in which every diagnosis has one cause.
Conditions may be infectious, genetic, traumatic, iatrogenic, environmental,
multifactorial, idiopathic, or still uncertain. A patient's presentation may
support several differential diagnoses before one is confirmed. A risk factor
is not automatically a cause, and a temporal relationship is not automatically
causal.

SNOMED CT can express clinically meaningful relationships such as **due to**
and **causative agent**. It also distinguishes a broad association from an
asserted causal relationship.[8] That capability is useful for coding a
clinician's conclusion; it must not be used to manufacture that conclusion.
FHIR's Condition model likewise records the condition, verification status,
clinical status, severity, body site, onset, evidence, and asserter, but it does
not provide a universal mandatory “cause” property.[9]

For Jayamurugan Clinic:

- prefer a sufficiently specific diagnosis when the aetiology is known;
- allow verification status: unconfirmed, provisional, differential,
  confirmed, refuted, and entered in error;
- provide an optional relationship editor only after a diagnosis is selected;
- use relationship types such as due to, caused by agent, associated with,
  after, exposure to, and risk factor;
- require certainty and author for a causal assertion;
- keep a free-text clinical explanation for nuance;
- never copy a general textbook cause into the patient's record as fact.

A compact example:

| Field | Example value |
|---|---|
| Recorded condition | acute pharyngitis |
| Verification | provisional |
| Aetiology relationship | suspected due to viral infection |
| Evidence/note | household contact; no confirmatory test |
| Asserted by | treating doctor |
| Time | encounter timestamp |

The words **suspected** and **provisional** materially change the clinical
meaning and must survive display, printing, history, and export.

### 1.3 What is safe to preload

The following content is useful and low enough risk when it is versioned and
clinician-reviewed:

- active clinical concepts and synonyms;
- a general-practice or clinic-specific subset;
- common complaints, symptoms, findings, and diagnoses;
- laterality, site, severity, duration, and verification-status choices;
- the doctor's own favourite phrases and recent selections;
- advice, follow-up, and patient-instruction phrases;
- reusable encounter and prescription templates that load as drafts;
- mappings for reporting, kept separate from the selected clinical term.

The following must not be treated as ordinary autocomplete content:

- a predicted diagnosis generated from symptoms, vitals, age, or history;
- a “most likely cause” inserted without the doctor's choice;
- a medicine recommended because a diagnosis was selected;
- dose calculations without an approved clinical rule and independent
  validation;
- interaction, allergy, pregnancy, renal, paediatric, or antimicrobial advice
  assembled from unvalidated data;
- a template that silently signs, replaces, or dispenses a medicine.

Those are clinical decision-support functions. They require separate evidence,
clinical governance, validation, change control, monitoring, and
medico-legal review. They are outside the proposed convenience-autocomplete
scope.

---

## 2. Which terminology sources fit the clinic

### 2.1 Recommended source hierarchy

| Need | Preferred source | How the clinic should use it |
|---|---|---|
| Complaints, findings, diagnoses, procedures | SNOMED CT with Indian releases/refsets | point-of-care search and stored concept identity |
| Clinic's common options | clinic-curated subset layered over SNOMED CT | favourites, recent terms, ranked results |
| Disease reporting/classification | ICD mapping when required | derived/reporting field, not the main doctor picker |
| Vitals and laboratory observations | LOINC/CLCI plus units | observation identity and interoperable result |
| Generic and branded Indian medicines | CDCI plus SNOMED CT medicine model | reference medicine identity |
| Dose form, route, patient instructions | CDCI/SNOMED and India Patient Instructions | structured directions and bilingual printing |
| Measurable units | UCUM | canonical strength, volume, and rate units |
| Exchange | ABDM FHIR R4 profiles | mapping/export boundary, not the internal UI |
| Package identities/barcodes | manufacturer label and GS1 where present | package SKU lookup and scan verification |
| Batch, expiry, MRP, cost, local stock | physical pack, invoice, and clinic records | authoritative operational inventory |
| Price-limit cross-check | NPPA sources | compliance/reference check, not stock truth |

### 2.2 SNOMED CT and Indian infrastructure

The Ministry's EHR guidance says SNOMED CT should be the primary internal
encoding for clinically relevant information. It positions ICD as a
classification/reporting system rather than the main vocabulary used while the
doctor documents care.[2]

NRCeS publishes Indian national resources, including clinical reference sets,
CDCI, common laboratory codes, and patient-instruction language content.[3]
The Bharat Health Terminology Service (BHTS), launched in 2026, now presents
these through a centralized FHIR R4 terminology infrastructure.[4] Its
September 2026 release reports the August 2026 SNOMED CT edition, updated Indian
extensions, and FHIR endpoints for lookup, value-set expansion, validation, and
concept translation.[5]

This does not mean the consultation screen should query the whole national
terminology on every keystroke. SNOMED International's own implementation
guidance recommends constraining search and data entry with reference sets and
using priority order for contextually useful results.[7] The clinic should:

1. keep a small, fast local search index of its approved subset and active
   medicine formulary;
2. rank favourites and recent selections before other subset members;
3. offer a deliberate “search more terms” route to BHTS or a synchronized
   terminology service;
4. store the selected code, code-system URI, release/version, display text used,
   and original clinician text;
5. refresh through an administrator-reviewed release process, never a silent
   production overwrite.

This arrangement gives the doctor a fast interface during an internet outage
while preserving the ability to code uncommon conditions.

### 2.3 Licensing is a go-live requirement

SNOMED CT is available without a usage fee within India, but it is not
licence-free. NRCeS says an Affiliate Licence is still required, usage must be
reported, and deployments need the appropriate sublicense arrangement.[6]
CDCI packages also carry their own licence terms. Therefore:

- obtain and record the applicable Affiliate Licence before importing SNOMED
  content into production;
- read and retain the License.txt shipped with the exact CDCI release;
- record which deployment and organization the licence covers;
- do not copy a commercial medicine database or internet pharmacy catalogue;
- do not expose a licensed full terminology download through an unauthenticated
  endpoint;
- review licence implications before allowing users outside India.

Licensing belongs in Phase 0, not in a backlog item discovered after the UI is
built.

### 2.4 Versioning and inactive concepts

Terminologies change. A concept or description may become inactive, be replaced,
gain a preferred synonym, or acquire a better mapping. Historical records must
remain intelligible.

Every coded clinical record should retain:

- code-system identifier;
- concept code;
- terminology release/version;
- displayed term at the moment of signing;
- original clinician-entered text where it adds meaning;
- current active/inactive state in the reference catalogue;
- replacement or association metadata, if published.

An inactive code must not disappear from old visits. It should be excluded from
new autocomplete results and displayed in history with its signed snapshot.

---

## 3. Doctor autocomplete and predictive text

### 3.1 Predict typing, not clinical truth

The safe meaning of “predictive text” in this product is:

- complete words the doctor has begun typing;
- search known synonyms;
- rank the doctor's favourites and recent choices;
- suggest the rest of a previously approved phrase;
- load a saved template as a visible draft.

It is not:

- infer a diagnosis from a complaint;
- infer a cause from a diagnosis;
- choose a medicine or dose;
- change a signed prescription;
- optimize treatment without a separately governed decision-support system.

The UI should label these controls **Search diagnosis**, **Recent**, or
**Favourites**, not **AI diagnosis** or **Recommended treatment**.

### 3.2 Search behavior

Search should be constrained by the field:

- the complaint field searches symptoms and findings;
- the diagnosis field searches disorders/conditions;
- the medicine field searches active generic and branded medicine concepts;
- the instruction field searches approved dosage and patient instructions;
- the investigation field searches the appropriate procedure or observation
  subset.

Within each field, ranking should be:

1. exact favourite or template match;
2. exact normalized phrase;
3. prefix match on preferred terms;
4. prefix match on approved synonyms;
5. whole-word and substring match;
6. cautiously weighted fuzzy match;
7. wider terminology results after the local subset.

Fuzzy matching must never hide meaningful differences such as left/right,
acute/chronic, type 1/type 2, 250 mg/500 mg, tablet/capsule, or
immediate/modified release. Search results should show the distinguishing
words, not truncate them.

### 3.3 Free-text escape hatch

A doctor must never be blocked because the exact term is absent. “Use my own
wording” should remain available. When used:

- preserve the text exactly in the signed encounter;
- mark the item as locally entered/unencoded;
- optionally place it in an administrator review queue;
- let the doctor or terminology curator map it later;
- never rewrite the signed wording retroactively.

The curator may make a mapped term available for future visits. Historical data
can gain a separate mapping annotation, but the original assertion remains.

### 3.4 Structured context after selection

The autocomplete should select the core concept. A small secondary row can then
capture only relevant context:

- onset and duration;
- laterality/body site;
- severity;
- clinical course;
- verification status;
- recurrence;
- aetiology or causative agent where explicitly asserted.

This avoids presenting hundreds of very specific pre-coordinated terms in the
first dropdown while still retaining clinically important detail.

### 3.5 Multilingual instructions

The 31 August 2026 India Patient Instructions release covers frequency, route,
dose units, dose forms, and common dosage instructions in Hindi, Marathi,
Tamil, Urdu, Gujarati, Bengali, and Kannada.[16] This is directly useful to
Jayamurugan Clinic.

The recommended workflow is:

- the doctor selects an approved structured instruction in the working
  language;
- the system stores the instruction code and both displayed strings;
- the prescription prints in English, Tamil, or both according to clinic and
  patient preference;
- the doctor sees the complete rendered patient sentence before signing;
- free text remains available for instructions not represented in the set.

Translation should be code-based and release-versioned. Do not send clinical
directions through a generic machine-translation service at print time.

---

## 4. What a medicine actually is

### 4.1 The six identities currently being conflated

A medicine name in a clinical note is not the same entity as a box on a shelf.
The target model needs the following layers:

    Substance / active ingredient
        ↓
    Clinical drug: ingredient(s) + strength + dose form
        ↓
    Branded/real clinical drug: brand + supplier/manufacturer + clinical drug
        ↓
    Package SKU/version: a saleable package and its contained quantities
        ↓
    Batch/lot: batch number + manufacture/expiry + batch price/cost
        ↓
    Stock and dispense events: what moved, for whom, when, and why

This hierarchy is consistent with the direction of ISO Identification of
Medicinal Products (IDMP), the SNOMED medicinal product model, FHIR Medication,
and GS1 package-level product identification.[12][13][17][28]

### 4.2 The current CDCI release

The most relevant national starting point is the **Common Drug Codes for India
(CDCI)**. The current flat-files package reviewed for this report is dated
31 August 2026. It contains:

| CDCI master | Published count |
|---|---:|
| Active substances | 3,283 |
| Generic medicines | 10,305 |
| Branded medicines | 93,911 |
| Product/marketed names | 72,284 |
| Suppliers | 8,213 |
| Drug forms | 423 |
| Routes of administration | 160 |

The release covers items assembled from NLEM 2015 and 2022, Jan Aushadhi,
AMRIT, telemedicine, HIV, and COVID programme sources; it excludes devices,
surgical implants, and combi packs. NLEM is a list of essential medicines, not
a complete catalogue of every package marketed in India. NRCeS states that
implementers must assess the package's suitability for their own
environment.[11][27]

The corresponding August 2026 terminology-integrated release contains 10,305
generic and 93,911 branded medicines when combined with the SNOMED CT
International Edition.[12]

These numbers demonstrate why the doctor must not receive a 93,911-row
dropdown. CDCI should seed a reference catalogue. The clinic's active formulary
and frequently prescribed products should be the working set.

### 4.3 CDCI is necessary but not the complete pharmacy master

NRCeS explicitly says systems using the flat files should add their own package,
batch, price, purchase/sale, and patient information.[3] The current August
2026 integrated release defines the concepts of Packaged Clinical Drug and Real
Packaged Clinical Drug but says those package concepts are not included in the
release.[12]

Therefore CDCI can help identify:

- ingredients;
- generic medicines;
- branded medicines;
- suppliers;
- drug forms;
- routes;
- structured strengths.

It cannot be assumed to supply the clinic's:

- exact box/strip/blister/bottle configuration;
- every package-level barcode;
- current batch and expiry;
- MRP printed on the received stock;
- invoice price and discounts;
- current shelf quantity;
- location/rack;
- local sale restrictions or pack-only rules;
- every device, implant, kit, or combi pack.

Those are locally governed operational data.

Here, **combi pack** means a marketed package containing separate component
products; it is not the same as one fixed-dose, multi-ingredient medicine.
The August 2026 integrated release supports clinical drugs with multiple active
ingredients, while package-level PCD/RPCD concepts remain absent.[12]

### 4.4 Strength is structured, not a suffix in the name

Strength must support one or more ingredients and both presentation and
concentration forms:

- paracetamol 500 mg per tablet;
- amoxicillin 250 mg per 5 mL after reconstitution;
- solution 10 mg per mL;
- combination products with multiple ingredient-strength pairs;
- an inhaler with strength per actuation and total metered doses.

FHIR Medication represents form, package amount, ingredients, ingredient
strength, batch number, and expiration date as separate data elements.[13]
UCUM provides canonical units such as mg, g, mL, and compound expressions.[14]

Recommended storage for each ingredient:

- substance code and display name;
- numerator value and UCUM unit;
- denominator value and unit of presentation or volume;
- basis-of-strength substance when supplied by the source;
- ingredient order;
- active/inactive ingredient flag where needed.

The UI can render a familiar phrase, but it should not have to parse the phrase
later to discover what was prescribed.

### 4.5 Dose form, route, and release behavior are separate

Tablet, capsule, oral solution, cream, drops, injection, inhaler, and patch are
not interchangeable packaging labels. They describe the medicinal form. Route
describes how it enters or is applied to the body. Release behavior such as
immediate, delayed, sustained, or prolonged release can be clinically
significant and must remain visible.

At minimum, medicine search results should show:

**name · ingredient/strength · dose form · release characteristic · route when
needed · brand/manufacturer when selected**

Never default a hidden strength or form merely because a brand name matched.

---

## 5. Clinical dose, prescribed quantity, and stock unit

These quantities answer different questions and must not share one ambiguous
field.

| Quantity | Question answered | Example |
|---|---|---|
| Ingredient strength | what medicine is this? | 500 mg per tablet |
| Dose amount | what does the patient take each time? | 1 tablet |
| Frequency/timing | when/how often? | twice daily after food |
| Duration | for how long? | 5 days |
| Prescribed quantity | how much is authorized? | 10 tablets |
| Package content | what is inside this pack? | 15 tablets per strip |
| Dispensed quantity | how much was supplied now? | 6 tablets |
| Remaining authorized quantity | what may still be supplied? | 4 tablets |
| Stock balance | what is physically available? | 47 tablets in this batch |

FHIR's Dosage model separates human-readable text, timing, as-needed status,
site, route, method, dose, rate, and maximum dose.[15] The product does not need
to expose all of FHIR in the doctor's UI, but the internal prescription line
should retain the distinctions that the clinic uses.

The printed direction must always be a human-readable sentence reviewed by the
doctor. Structured fields support calculations, search, and interoperability;
they do not replace readable instructions.

---

## 6. Package and inventory model

### 6.1 Package SKU belongs between medicine and batch

The earlier product plan was directionally correct that a conversion must never
be a single mutable field on the generic medicine. This research refines the
model:

- the **package SKU/version** defines the physical hierarchy and identifiers;
- the **batch** references the exact package SKU/version received;
- the batch keeps an immutable receiving snapshot of the confirmed conversions;
- batch-specific commercial values such as batch/lot, expiry, MRP, and actual
  purchase cost remain on the batch/receipt.

GS1's healthcare allocation rules assign distinct GTINs to packaging hierarchy
levels when those levels are trade items.[17] If a manufacturer's saleable pack
changes materially, the package identity or version should change. Mutating a
global medicine-level “15 tablets per strip” value would corrupt old stock;
duplicating the entire package model independently for every batch would make
catalogue management unnecessarily repetitive. Package version plus batch
snapshot handles both concerns.

### 6.2 Base stock unit rule

Use one smallest countable stock unit per clinic formulary item, and store batch
balances in that unit.

For tablets and capsules that may be supplied loose, the base is one tablet or
capsule. If the clinic supplies only complete strips, the base can still be one
tablet while a **minimum dispense multiple** enforces strip-only supply. This
keeps prescriptions and stock arithmetic exact.

For sealed liquids, creams, and drops normally sold as a complete container,
the base stock unit should usually be one bottle or tube, while fill volume or
weight remains a product/package attribute. Do not deduct “5 mL” from a sealed
60 mL bottle merely because the patient's dose is 5 mL.

If the clinic actually decants bulk liquids or administers from multi-dose
containers, that is a separate measured-dispensing/administration workflow. It
requires decimal quantities, calibrated measurement, opened-container state,
beyond-use rules, and waste recording. It should not be accidentally enabled
by choosing mL as a free-text stock unit.

### 6.3 Examples by product type

| Product | Clinical dose unit | Recommended stock base | Package metadata |
|---|---|---|---|
| Tablet | tablet or ingredient mass | tablet | blister/strip count, box count |
| Capsule | capsule | capsule | strip/blister and box |
| Syrup/oral solution sold sealed | mL per dose | bottle | fill volume, bottle, carton |
| Cream/ointment/gel | g or application | tube | net fill weight and carton |
| Eye/ear/nasal drops | drops | bottle | fill volume and dropper container |
| Vial | mg, mL, or vial per administration | vial | single/multi-dose, carton count |
| Ampoule | mL or ampoule | ampoule | carton/tray count |
| Sachet | sachet or contained dose | sachet | box count |
| Inhaler | actuation/puff | inhaler | strength per actuation, total doses |
| Patch | patch | patch | pouch and carton count |
| Device/consumable | piece | piece | inner pack and case; separate catalogue |

### 6.4 Nested package example

For a tablet product:

| Level | Contains | Base-unit factor | May have its own identifier |
|---|---|---:|---|
| tablet | one tablet | 1 | often not physically marked |
| strip | 15 tablets | 15 | sometimes |
| box | 10 strips | 150 | commonly |
| case | 20 boxes | 3,000 | supply-chain level |

Receiving two boxes, three strips, and four loose tablets posts:

**(2 × 150) + (3 × 15) + 4 = 349 tablets**

The system should show that calculation before posting. The stored ledger
movement is +349 base units, while the receipt preserves the physical
quantities entered and the package version used.

Package depth should be data-driven. The everyday clinic UI can limit entry to
the two or three levels the clinic uses without hard-coding the database to the
words strip and box.

### 6.5 Package and batch fields

**Package SKU/version**

- formulary/brand product reference;
- package name and hierarchy;
- contained quantity at each level;
- base-unit factor;
- sellable and receivable flags;
- minimum dispense multiple;
- net content and unit;
- manufacturer-labelled product code;
- GTIN or other identifiers where available;
- validity dates/version and source;
- local verification state.

**Batch/lot**

- package SKU/version reference;
- batch/lot number;
- manufacture date when available;
- expiry month/date with explicit precision;
- received quantity in physical packs and base units;
- remaining quantity in base units;
- MRP amount and the labelled package to which it applies;
- actual purchase price basis, discounts, and derived cost per base unit;
- supplier and receipt/invoice;
- storage location;
- quarantine/available/expired/returned/recalled state;
- immutable conversion snapshot.

Money should use exact decimal storage, not floating point. Quantity should use
integers for countable units and constrained decimals only in an explicitly
approved measured-stock workflow.

### 6.6 MRP and loose-unit pricing

The application must store **MRP amount plus MRP package basis**, not a naked
number. “₹30” is ambiguous; “₹30 for one strip of 15 tablets from batch B123”
is meaningful.

If loose sale is allowed, calculate the line amount from the labelled pack
basis and quantity, with a clinic-approved rounding rule that does not create an
overcharge. Perform rounding on the final line amount rather than repeatedly
rounding an artificial per-tablet price. NPPA's Pharma Sahi Daam can be used as
a price-compliance cross-check, but the physical batch label and received
invoice remain the operational evidence for the clinic's stock.[26]

Any implementation involving MRP ceilings, GST, discounts, controlled
medicines, or repacking should receive professional regulatory/accounting
review.

---

## 7. Barcode and QR-code reality

### 7.1 Barcode coverage is not universal

The statement that every Indian medicine strip carries a barcode is not
supported by the current rules. Under G.S.R. 823(E), barcode or QR-code
requirements took effect on 1 August 2023 for the 300 brands listed in Schedule
H2. The code may be placed on primary packaging or, when space is inadequate,
on secondary packaging.[19] CDSCO's implementation FAQ explicitly says the
requirement is mandatory for those listed 300 brands and voluntary for other
brands.[20]

The Drugs (Seventh Amendment) Rules, 2026 expand Schedule H2 to all vaccines,
all antimicrobials, covered narcotic/psychotropic substances, and all
anticancer drugs. Most of that expansion takes effect on 1 July 2027;
antimicrobials take effect on 1 July 2028.[21] As of this report's date, those
future dates do not justify assuming every item on today's shelf is scannable.

The workflow must therefore support:

- camera or scanner when a usable identifier exists;
- fast text search when it does not;
- manual package mapping with two-person or pharmacist verification;
- human confirmation of name, strength, form, and package after every unknown
  scan.

### 7.2 A barcode does not always identify a batch

A static EAN/GTIN usually identifies a trade item at a package level. A
structured healthcare DataMatrix or QR payload may also carry batch, expiry,
and other attributes. The Indian rule requires stored information including
product identifier, proper/generic and brand names, manufacturer, batch,
manufacture date, expiry, and manufacturing-licence number, but lets the
manufacturer determine its unique product identification code.[19][20]
Implementations must therefore expect more than one payload format.

Recommended identifier record:

- raw scanned value;
- symbology: EAN-13, GTIN-14, GS1 DataMatrix, QR, Code 128, or unknown;
- normalized GTIN when applicable;
- package SKU/version;
- packaging level;
- parsed batch and expiry when present;
- issuer/source and verification state;
- first-seen and last-verified times;
- active/inactive status.

A plain package barcode should map to the package SKU, not to every batch of the
medicine. The batch is chosen from the QR payload, a second scan, or explicit
receipt entry. At dispensing, scanning verifies the selected physical package
and then the pharmacist confirms the batch allocation.

GS1 India supports separate identifiers for secondary and tertiary packaging,
which reinforces the need to record packaging level rather than keeping one
barcode column on the medicine.[18]

### 7.3 Scan safety rule

A scan is a lookup aid, not unquestionable truth. The application must display:

- exact medicine/brand;
- strength and form;
- package quantity;
- batch and expiry if known;
- expected prescription line;
- a strong mismatch message.

An unknown, ambiguous, inactive, expired, or mismatched scan must stop the
automatic action and request explicit review.

---

## 8. Prescribing, partial dispensing, and substitution

### 8.1 Prescription line structure

Each signed line should contain:

- reference medicine identity and code/version;
- whether the doctor selected generic or branded medicine;
- exact signed display snapshot;
- ingredient/strength/form snapshot;
- dose amount and unit;
- frequency/timing;
- route and method where relevant;
- as-needed condition and maximum, where used;
- duration;
- prescribed dispense quantity and unit;
- repeats/refills if the clinic supports them;
- substitution permission only if legally and clinically defined;
- patient-facing instruction text;
- clinical reason/diagnosis reference where appropriate;
- line status and doctor signature metadata.

FHIR MedicationRequest separates authorized quantity, supply duration, repeats,
and substitution intent.[24] ABDM's current R4 profile allows SNOMED clinical
drug and real clinical drug codes and points Indian branded coding to CDCI.[10]

### 8.2 Partial dispensing is an event, not an edit

The signed prescription remains unchanged. Every supply creates a dispense
event:

| Prescription line | Prescribed | First supply | Second supply | Remaining |
|---|---:|---:|---:|---:|
| Medicine A | 10 tablets | 6 | 4 | 0 |
| Medicine B | 1 bottle | 0 | 1 | 0 |

The invariant is:

**sum of completed, non-reversed dispense quantities ≤ prescribed authorized
quantity**

Each dispense line records actual product, quantity, batch allocations,
pharmacist, prepared/handed-over time, price, and any reason for supplying less.
FHIR MedicationDispense explicitly supports partial-fill event type, actual
quantity, days supply, prescription linkage, and substitution details.[25]

The patient may take all, some, none, or return for the remainder according to
clinic policy. The system should distinguish:

- not supplied because out of stock;
- patient declined;
- patient will collect later;
- doctor stopped/cancelled;
- prescription expired;
- supplied externally/unknown;
- data-entry correction or reversal.

### 8.3 Substitution requires a stricter workflow than “same salt”

Matching active ingredients, strengths, dose form, route, and release
characteristics can identify a **candidate equivalent product**. It does not
prove that substitution is permitted or clinically appropriate.

The Pharmacy Practice Regulations state that a registered pharmacist should
dispense the medicine prescribed by the registered medical practitioner and
should not substitute the prescription.[23] For this clinic, the safest product
workflow is:

1. pharmacist marks the prescribed item unavailable and proposes an exact
   candidate for the doctor's attention;
2. the system does not dispense the candidate;
3. the doctor reviews the complete product identity;
4. if accepted, the doctor issues a signed amendment/replacement line or a new
   prescription according to the approved clinic policy;
5. the pharmacy dispenses against that doctor-authorized order;
6. the audit trail retains the original request, proposed product, decision,
   and resulting prescription.

The feature should be named **Request prescription change**, not **Substitute**.
Before implementation, a registered pharmacist or qualified legal adviser
should confirm the workflow for the clinic's exact licence and jurisdiction.

---

## 9. Target logical data architecture

The internal schema does not need to reproduce FHIR resource tables. It should
represent clinic operations cleanly and map to ABDM FHIR at the exchange
boundary.

### 9.1 Terminology catalogue

**terminology_releases**

- source system, edition, release date, import time;
- licence reference and checksum;
- current/staged/retired state;
- import and review audit.

**clinical_concepts**

- code system, concept code, release;
- semantic type/hierarchy;
- preferred display;
- active state and replacement metadata.

**clinical_descriptions**

- concept, language/dialect, term;
- preferred/acceptable status;
- normalized search text.

**clinic_concept_subset**

- concept and intended field: complaint, finding, diagnosis, advice, etc.;
- active/approved state;
- priority, specialty, age context where appropriate;
- approved by and review date.

**condition_assertions**

- patient, encounter, concept and signed display snapshot;
- original text;
- verification and clinical status;
- site/laterality, severity, onset/duration;
- asserter, timestamp, lifecycle/correction metadata.

**condition_relationships**

- source condition;
- relationship type;
- target coded condition/agent or text;
- certainty/status;
- evidence/note, asserter, timestamp.

**clinical_phrases_and_templates**

- owner/clinic scope;
- field/type, language, version;
- template content and visible line items;
- favourite/recent usage separately;
- approval and retirement history.

### 9.2 Reference medicine catalogue

**medicine_catalog_releases**

- CDCI/source release, date, checksum, licence;
- staged/current/retired state.

**substances**

- source code, preferred name, synonyms, active state.

**clinical_drugs**

- generic concept code;
- dose form, route/release metadata;
- display and active state.

**drug_ingredients**

- clinical drug, substance, order;
- strength numerator/denominator and UCUM units;
- basis-of-strength details where available.

**branded_drugs**

- CDCI real clinical drug/product code;
- generic clinical-drug reference;
- brand/product name;
- supplier/marketing entity;
- active state and source release.

**clinic_formulary_items**

- clinic code;
- generic or branded reference;
- working display/search aliases;
- base stock unit;
- loose/pack-only policy and minimum dispense multiple;
- sale/regulatory flags with source and effective dates;
- active and locally verified state.

CDCI imports should land in staging and be compared with the current release.
They must not silently overwrite locally verified formulary data.

### 9.3 Package and stock

**package_sku_versions**

- formulary item;
- version/source;
- package-level identity;
- net content;
- active dates and verification.

**package_components**

- parent package SKU/version;
- child package or base unit;
- quantity per parent;
- hierarchy order;
- receivable/sellable flags.

**package_identifiers**

- package version, packaging level;
- raw identifier, symbology, normalized GTIN;
- issuer/source and verification state.

**batches**

- package version and receipt conversion snapshot;
- batch/lot, manufacture and expiry;
- MRP and basis;
- cost and basis;
- supplier/receipt;
- available state and quantity.

**stock_movements**

- immutable movement in base units;
- medicine, package/batch;
- movement type and reference;
- actor, timestamp, reversal relationship.

The batch balance can be cached for speed, but the append-only ledger is the
reconstructable source of movement history.

### 9.4 Prescription and dispense

**prescriptions**

- signed header, patient, encounter, doctor;
- lifecycle, print and correction metadata.

**prescription_lines**

- the structured and signed fields described in section 8.1;
- stable line identifier and display snapshot.

**dispenses**

- event header, prescription, patient, pharmacist;
- status, timestamps, partial/completion type.

**dispense_lines**

- prescribed line, actual product and quantity;
- remaining calculation and reason.

**dispense_allocations**

- dispense line, batch, base-unit quantity;
- price/cost snapshot.

Reversals create compensating records. They do not delete the clinical or stock
history.

---

## 10. Gap analysis against the current application

The repository currently has sound foundations—an append-only stock movement
table, batches, FEFO-oriented allocation, and a role-aware workflow—but the
following fields are insufficient for this design:[1]

| Current state | Limitation | Target |
|---|---|---|
| encounters.diagnosis is one required text value | no multiple diagnoses, coding, status, or uncertainty | condition assertions plus display snapshot |
| prescription items exist only in items_json | cannot reliably query, partially dispense, amend, or map lines | normalized signed prescription lines |
| prescriptions.dispensed_at is one timestamp | treats dispensing as all-or-nothing | multiple dispense events and line quantities |
| medicine strength and form are text | cannot safely match ingredients or distinguish structured products | coded product plus structured ingredients/strength/form |
| medicines.unit is free text | quantity meaning can change or remain ambiguous | verified base stock unit and policy |
| medicines.barcode is one text field | no package level, symbology, or multiple identifiers | package identifier table |
| batch price fields lack explicit basis | ₹ value may refer to unit, strip, bottle, or box | price amount plus package basis |
| batch has no package reference | conversion cannot be versioned or audited | package SKU/version and received snapshot |
| stock quantities are integers | good for countable bases, unsafe for accidental bulk liquid | keep integer default; add decimals only for governed measured stock |
| schedule is a single local value | regulations change and H2 traceability is different from H/H1/X sale class | versioned regulatory assertions/effective dates |

### 10.1 Migration rules

Migration must preserve history and avoid guessing:

1. Keep every existing encounter diagnosis as its signed display text.
2. Map a historical diagnosis to a code only when a clinician or approved
   curator confirms it; record mapping as an annotation.
3. Expand each prescription JSON line into a normalized line while retaining
   the original JSON payload for reconciliation.
4. Do not infer whether an old quantity means tablet, strip, box, bottle, or
   pack.
5. For every active stock item, perform a physical package and batch review with
   the pharmacist.
6. Map existing medicines to CDCI where a confident exact product match exists;
   preserve unmatched items as local records for later review.
7. Create package versions from the physical label and supplier invoice.
8. Reconcile an opening count in base units for every active batch.
9. Preserve old barcodes as unverified identifiers until package level is
   confirmed.
10. Run migration in staging, produce an exception report, and obtain signed
    clinic approval before production cutover.

No automated name parser should decide a strength, ingredient, package
conversion, or regulatory schedule for production stock.

---

## 11. Data ingestion and maintenance

### 11.1 Clinical terminology release workflow

1. Download or synchronize an approved release under the applicable licence.
2. Verify file checksum and release metadata.
3. Import into isolated staging tables.
4. validate concept identifiers, descriptions, hierarchy, and active status;
5. calculate additions, inactivations, replacements, and changed descriptions;
6. test the clinic subset and top search queries;
7. have the terminology/clinical owner review material changes;
8. activate the release atomically;
9. retain old releases needed to interpret signed records;
10. monitor failed searches and unencoded free-text entries for curation.

The BHTS API is appropriate for wider lookup, validation, and mapping, subject
to licence, documented access terms, performance, and availability checks.[4][5]
The common consultation path should continue to work from the locally approved
subset if BHTS is unavailable.

### 11.2 CDCI release workflow

1. Import the exact flat-file release into versioned staging.
2. Validate counts and referential integrity against its release notes.
3. compare generic, brand, supplier, dose-form, and route changes;
4. never overwrite signed prescription snapshots;
5. flag inactive or changed formulary mappings;
6. let the pharmacist resolve local package and brand exceptions;
7. promote reviewed changes to the clinic reference catalogue;
8. retain provenance for local additions and overrides.

The clinic should not attempt to maintain all 93,911 brands manually. It should
maintain the small active formulary, with CDCI as a lookup and interoperability
source.

### 11.3 Local catalogue governance

| Content | Owner | Review trigger |
|---|---|---|
| complaint/diagnosis subset | doctor/clinical owner | new recurring free text, release change |
| prescription templates | doctor who uses them | medicine/status change, periodic review |
| patient instructions/translations | doctor plus approved national release | language release/change |
| medicine-to-CDCI mapping | pharmacist with doctor support | new item or CDCI change |
| package hierarchy/barcode | pharmacist/inventory administrator | first receipt or pack change |
| batch/MRP/expiry | receiving pharmacist/staff | every receipt |
| H/H1/X/H2 and other flags | pharmacist/compliance owner | rule or product-status change under current Drugs Rules and later gazettes[22] |
| price cross-check | admin/pharmacist | receipt and relevant price notification |

Every local override needs a reason, author, date, and review status.

---

## 12. Risk analysis

| Risk | Consequence | Required control |
|---|---|---|
| whole terminology shown as one dropdown | slow, confusing documentation | field-specific subset and ranked search |
| symptom autocomplete presented as diagnosis | automation bias and wrong record | clear field semantics; no inferred clinical selection |
| “cause” copied as fact | false causal assertion | optional relationship with certainty and doctor authorship |
| inactive code removed | unreadable historical record | signed display snapshot and release retention |
| wrong strength/form hidden in search | prescribing error | always show distinguishing attributes |
| CDCI treated as complete local inventory | missing package, batch, price, device data | separate local operational layer |
| one barcode stored per medicine | wrong packaging level or batch | many package identifiers with symbology and scope |
| barcode assumed universal | blocked workflow or unsafe manual workaround | text/manual fallback and verification |
| static GTIN mapped directly to a batch | wrong expiry/lot allocation | package mapping plus explicit batch identification |
| package conversion edited globally | corrupt historical stock | versioned package SKU and batch snapshot |
| clinical dose used as stock deduction | impossible shelf balance | separate dose, dispense, and stock units |
| same-salt match treated as substitution authority | unauthorized dispensing | doctor-authorized prescription change |
| partial supply edits prescription quantity | lost clinical intent and audit | immutable prescription plus dispense events |
| remote terminology required per keystroke | consultation failure during outage | local subset/cache and asynchronous sync |
| automatic release activation | unexpected search or mapping changes | staged diff, clinical review, atomic promotion |

The highest-risk proposed additions are automated diagnosis, treatment
recommendation, dose calculation, drug-interaction checking, and substitution.
They should remain explicit non-goals for this programme unless the clinic later
starts a separately governed clinical decision-support project.

---

## 13. Phased implementation plan

### Phase 0 — governance, licensing, and clinic decisions

**Work**

- appoint a clinical terminology owner and a pharmacy catalogue owner;
- obtain/confirm SNOMED and CDCI licence terms;
- confirm whether prescriptions use generic, brand, or either;
- confirm Tamil/English print and instruction needs;
- confirm loose-sale rules by product type;
- inventory current packages, barcodes, batches, and ambiguous units;
- agree that autocomplete is assistive and templates remain unsigned drafts;
- obtain pharmacist/legal review of prescription-change and controlled-drug
  workflows.

**Exit gate**

- named owners, written scope, applicable licences, and approved safety rules.

### Phase 1 — terminology foundation and clinic subset

**Work**

- add terminology release, concept, description, and subset structures;
- load a licensed release in staging;
- build field-constrained local search;
- start the clinic subset from historical usage, the doctor's top phrases, and
  appropriate general-practice reference content;
- add multiple condition assertions and verification status;
- retain free-text fallback and signed display snapshots;
- add administrator curation queues.

**Exit gate**

- doctor can complete common visits faster without seeing irrelevant concepts;
- uncommon free text remains possible;
- no selection is inserted without an explicit user action;
- old diagnosis text remains unchanged and readable.

### Phase 2 — structured medicine catalogue and prescription composer

**Work**

- import the August 2026 CDCI flat files into versioned staging;
- map the clinic's active formulary first;
- model substances, ingredients, strength, form, route, generic, and brand;
- implement exact medicine search with strength/form always visible;
- add structured dosage and patient instructions;
- load approved multilingual instruction content;
- normalize prescription lines and keep JSON source during migration;
- preserve every signed line as an immutable snapshot.

**Exit gate**

- pharmacist and doctor validate every active formulary mapping;
- combination products and release forms display correctly;
- search cannot silently change strength or dose form;
- printed directions match the doctor's signed preview.

### Phase 3 — package SKU, barcode, and batch foundation

**Work**

- add package versions, components, and multiple identifiers;
- add batch reference plus immutable conversion snapshot;
- make receiving accept boxes, strips, bottles, tubes, and loose count as
  configured;
- capture MRP and purchase-price basis explicitly;
- implement scan parsing with manual fallback;
- physically verify and reconcile opening stock;
- keep stock ledger movements in base units.

**Exit gate**

- every active batch has an unambiguous base unit, package conversion, price
  basis, batch number, and expiry;
- scanning identifies a package level and never silently selects a wrong batch;
- mixed old/new package sizes coexist without altering history;
- expected and physical opening stock reconcile.

### Phase 4 — partial dispensing and doctor-authorized changes

**Work**

- add dispense events, lines, and batch allocations;
- calculate remaining authorized quantity transactionally;
- support full, partial, none-now, and later collection;
- implement request-prescription-change rather than direct substitution;
- bill only the quantity actually supplied;
- print the original prescription independently from dispense receipts.

**Exit gate**

- concurrent dispensing cannot over-supply or drive stock negative;
- the signed prescription never changes when stock is supplied;
- each supplied unit is traceable to a batch;
- an alternative product cannot be dispensed without a valid doctor-authorized
  order.

### Phase 5 — release operations and controlled rollout

**Work**

- add staged terminology/CDCI update jobs and diff reports;
- add inactive-code and unmatched-formulary queues;
- train doctor, pharmacist, nurse, and admin on their small role-specific
  workflows;
- run a supervised pilot with real packaging and printer hardware;
- audit search misses, corrections, stock variances, and partial supplies;
- approve go-live and rollback runbooks.

**Exit gate**

- clinical owner and pharmacist sign off;
- no unresolved high-risk catalogue exceptions;
- backup, restore, audit, and rollback rehearsals pass.

---

## 14. Verification plan

### 14.1 Terminology tests

- synonym, abbreviation, prefix, typo, and fuzzy-result ordering;
- field constraints prevent procedures or non-human concepts in diagnosis;
- active/inactive concept behavior across releases;
- favourites and recency do not suppress exact safer matches;
- free-text fallback and later mapping preserve original wording;
- provisional/differential/confirmed status survives print and history;
- English/Tamil instruction rendering from the same code.

### 14.2 Medicine tests

- single and multi-ingredient products;
- same brand with different strength or form;
- immediate versus prolonged/modified release;
- presentation versus concentration strength;
- generic and brand search;
- inactive/unmapped CDCI product;
- local product not represented in the release;
- device/combi-pack exception.

### 14.3 Package and stock tests

- tablet → strip → box and capsule → strip → box;
- bottle, tube, vial, ampoule, sachet, inhaler, and piece;
- same clinical drug with several package SKUs;
- separate package-level GTINs;
- static barcode without batch;
- structured QR/DataMatrix with batch/expiry;
- unknown and ambiguous scan;
- two batches with different package versions and MRP;
- FEFO split across batches;
- pack-only minimum multiples;
- return, recall, expiry, write-off, reversal, and stock-take;
- exact arithmetic and final-line rounding.

### 14.4 Prescription/dispense tests

- all supplied now;
- some lines supplied and others declined;
- one line partially supplied over several visits;
- concurrent attempts against the same remaining quantity;
- prescription expiry before remainder collection;
- external supply noted without local stock deduction;
- proposed alternative rejected or accepted through a new doctor order;
- reprint preserves the original signed content;
- dispense receipt shows supplied-now and remaining quantities.

### 14.5 Safety acceptance

The final user acceptance session should use the clinic's real top diagnoses,
real packs, real barcodes, actual printer, and both normal and nurse-absent
workflows. Synthetic catalogue examples alone cannot validate the package
model.

---

## 15. Decisions required from the clinic owner

> **Status update, 11 September 2026:** owner decisions are now recorded in
> [`../OWNER_POLICY_REGISTER.md`](../OWNER_POLICY_REGISTER.md). The questions below
> remain as the research-derived checklist and evidence trail; consult the
> register for current approved and unresolved status.

### Clinical

- What type of clinic work dominates: general practice, dermatology, diabetes,
  paediatrics, procedures, or another mix?
- Which complaints and diagnoses occur most frequently?
- Which verification words does the doctor naturally use?
- Does the doctor want English, Tamil, or bilingual search and printing?
- Which phrases and templates are genuinely repeated?
- Who may create, approve, change, and retire clinic templates?

### Medicines and prescribing

- Does the doctor prescribe generic, brand, or either?
- Should stock availability be visible while prescribing?
- Which dosage shortcuts are common, and how should each render in full words?
- Are paediatric weight-based or other calculated doses intentionally out of
  the first release?
- Are repeats/refills used?

### Pharmacy and packages

- Which products may be supplied loose?
- Which must be supplied as a complete strip, bottle, tube, vial, or pack?
- Are any bulk liquids decanted or multi-dose containers administered?
- Which packages have usable 1D barcodes versus QR/DataMatrix codes?
- Who verifies an unknown code or changed package?
- Which controlled or special-register products are stocked?

### Partial supply

- May a remainder be collected on a later day?
- When does the uncollected remainder expire?
- Is stock reserved for the remainder or only promised when available?
- How should patient declined, unavailable, and externally purchased differ?

These decisions change data and safety rules. They should be captured in a
signed clinic policy, not buried in UI assumptions.

---

## 16. Final recommendation

Proceed with this capability, but do it in the following order:

1. **clinic-curated clinical autocomplete;**
2. **structured medicine identity and prescription lines;**
3. **package SKU/version and verified batch conversion;**
4. **partial dispense events;**
5. **controlled terminology and CDCI release maintenance.**

Do not start by importing every diagnosis and every Indian brand into visible
dropdowns. Do not build a diagnosis-to-cause-to-medicine graph. Do not let a
barcode bypass human verification. Do not implement “same salt” as pharmacist
substitution.

The correct product is a small, calm doctor experience backed by a deeper
administrator-maintained data system. The complexity belongs in governed
catalogues, package definitions, audit history, and release management—not in
the doctor's or pharmacist's common path.

---

## Sources

1. Jayamurugan Clinic repository inspection: **docs/reference/PRODUCT_UX_DISCOVERY.md**,
   **docs/reference/INVENTORY.md**,
   **supabase/migrations/20260831000000_clinic_schema.sql**, and
   **supabase/functions/_shared/commands.ts**, accessed 10 September 2026.
2. Ministry of Health & Family Welfare / NRCeS,
   [EHR Standards for India, 2016](https://www.nrces.in/standards/ehr-standards-for-india),
   especially Medical Terminology and Coding Standards.
3. NRCeS,
   [National Releases](https://www.nrces.in/services/national-releases),
   including CDCI, reference sets, common laboratory codes, and patient
   instructions.
4. NRCeS,
   [About Bharat Health Terminology Service](https://www.nrces.in/bhts/resources/documentation/),
   updated 28 August 2026.
5. NRCeS,
   [BHTS September 2026 Service Release](https://nrces.in/bhts/resources/updates/),
   1 September 2026.
6. NRCeS,
   [Frequently Asked Questions: SNOMED CT licensing](https://www.nrces.in/faqs),
   accessed 10 September 2026.
7. SNOMED International,
   [Search and Data Entry with Reference Sets](https://docs.snomed.org/snomed-ct-practical-guides/snomed-ct-reference-set-guide/3-requirements-and-use-cases/3.2-use-cases/3.2.1-search-and-data-entry).
8. SNOMED International,
   [SNOMED CT Concept Model](https://docs.snomed.org/snomed-ct-practical-guides/snomed-ct-starter-guide/6-snomed-ct-concept-model),
   including associated with, due to, and causative agent.
9. HL7 International,
   [FHIR R4 Condition](https://hl7.org/fhir/R4/condition.html).
10. NRCeS,
    [FHIR Implementation Guide for ABDM v7.0.0: MedicationRequest](https://nrces.in/preview/ndhm/fhir/r4/StructureDefinition-MedicationRequest-definitions.html),
    current preview reviewed 10 September 2026.
11. NRCeS,
    [Common Drug Codes for India, Flat Files Package release notes](https://www.nrces.in/download/files/pdf/CommonDrugCodesForIndia_ReleaseNotes_20260831.pdf),
    31 August 2026.
12. NRCeS,
    [Common Drug Codes for India, Terminology Integrated Package release notes](https://www.nrces.in/download/files/pdf/doc_SnomedCT-IndiaDrugExtension-PRODUCTION-ReleaseNotes_Current-en-US_IN1000189_20260831.pdf),
    31 August 2026.
13. HL7 International,
    [FHIR R4 Medication definitions](https://hl7.org/fhir/R4/medication-definitions.html).
14. Regenstrief Institute,
    [Unified Code for Units of Measure](https://ucum.org/).
15. HL7 International,
    [FHIR R4 Dosage definitions](https://hl7.org/fhir/R4/dosage-definitions.html).
16. NRCeS,
    [India Patient Instructions Language Extension release notice](https://www.nrces.in/news),
    31 August 2026.
17. GS1,
    [Healthcare GTIN Allocation Rules](https://www.gs1.org/standards/gs1-healthcare-gtin-allocation-rules-standard/current-standard).
18. GS1 India,
    [DataKart for Brand Owners](https://www.gs1india.org/datakart/datakart-for-brand-owners),
    including identifiers for secondary and tertiary packaging.
19. Central Drugs Standard Control Organization,
    [G.S.R. 823(E), Drugs (Eighth Amendment) Rules, 2022](https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2018/UploadGazette_NotificationsFiles/2022.11.17_Final%20GSR%20823%28E%29_Amendment%20in%20rule%2096%20for%20mandating.pdf).
20. Central Drugs Standard Control Organization,
    [FAQs on implementation of G.S.R. 823(E)](https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2018/UploadPublic_NoticesFiles/Final%20FAQs%20on%20QR%20code%2021.07.2023.pdf),
    21 July 2023.
21. Central Drugs Standard Control Organization,
    [Gazette Notifications listing for G.S.R. 506(E)](https://cdsco.gov.in/opencms/opencms/en/Notifications/Gazette-Notifications)
    and Gazette of India record **CG-DL-E-25062026-273811**, Drugs (Seventh
    Amendment) Rules, 2026.
22. Central Drugs Standard Control Organization,
    [Drugs Rules, 1945](https://cdsco.gov.in/opencms/opencms/en/Acts-and-rules/Drugs-Rules/),
    consolidated publication and later gazette amendments as applicable.
23. Pharmacy Council of India,
    [Pharmacy Practice Regulations, 2015](https://www.pci.gov.in/documents/25/Pharmacy-Practice-Regulations.pdf),
    regulation 4.3; the 2025 amendment reviewed for this report changes a
    clinical-pharmacist qualification provision, not regulation 4.3.
24. HL7 International,
    [FHIR R4 MedicationRequest definitions](https://hl7.org/fhir/R4/medicationrequest-definitions.html).
25. HL7 International,
    [FHIR R4 MedicationDispense definitions](https://hl7.org/fhir/R4/medicationdispense-definitions.html).
26. National Pharmaceutical Pricing Authority,
    [Pharma Sahi Daam](https://www.nppaindia.nic.in/pharma_sahi_daam),
    reviewed 10 September 2026.
27. Central Drugs Standard Control Organization,
    [National List of Essential Medicines 2022](https://cdsco.mohfw.gov.in/opencms/opencms/en/consumer/Essential-Medicines/).
28. International Organization for Standardization,
    [Identification of Medicinal Products, ISO 11616 overview](https://www.iso.org/obp/ui?_escaped_fragment_=iso%3Astd%3Aiso%3A11616%3Adis%3Aed-3%3Av1%3Aen).
