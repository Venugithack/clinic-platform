# Slice 3 clinic approval pack

**Jayamurugan Clinic — clinical starter vocabulary and medicine-package rules**  
**Prepared 11 September 2026**

This is the short approval companion to
`CLINICAL_TERMINOLOGY_AND_MEDICINE_DATA_RESEARCH.md`. It converts the owner's
answers into implementation rules and gives the doctor a proposed English
starter vocabulary to approve, edit, or reject.

This document is a product and data-design recommendation. The doctor must
approve clinical wording. A registered pharmacist must approve dispensing and
break-pack policy. Applicable Indian and state pharmacy requirements still
govern what may actually be supplied.

---

## 1. Decision status

| Item | Owner answer | Implementation decision | Status |
|---|---|---|---|
| Working language | English for the first release | English UI and clinical phrases; no language selector or machine translation | Approved |
| Common clinical content | Prepared starter vocabulary approved | Load the approved English starter set as clinic-wide content; doctors may add personal favourites/templates without silently changing the shared set | Approved |
| Tablets and capsules | Every tablet/capsule may be sold individually; counter decides the quantity | One tablet/capsule is the stock base unit. POS may sell any positive integer or an enabled strip/box level | Approved, subject to pharmacist/regulatory validation |
| Other presentations | Counter may sell the base unit or a whole higher package | POS may choose any configured **sellable** package level. The base unit is the smallest safe physical stock item, not automatically mL, g, puff, or dose | Approved with safety definition below |
| Breadth | The system must be ready for everything | Use a recursive, data-driven package hierarchy and allow custom package types. Do not hard-code only tablet → strip → box | Approved |
| Package changes | Yes, the same medicine can arrive in changed pack sizes | Create a new package version. Never edit the conversion used by an existing batch | Approved |
| Catalogue editors | Pharmacist and admin | Both may create/edit drafts. A changed conversion must be explicitly verified against the physical pack before stock is received | Approved |
| Decanted liquids / multi-dose administration | No | Bottles, tubes, vials, inhalers, and similar products remain complete stock units. Measured dispensing is outside initial scope | Approved |
| Supplier paperwork and real packs | Not yet provided | Validate receiving, MRP basis, purchase-price basis, barcodes, and changed-pack behavior using redacted real examples | Evidence pending; does not block the generic schema |
| Opening stock count | Use the recommendation | Pharmacist performs a blind physical count; admin/owner verifies variances after closing; only then post opening adjustments | Recommended default |

---

## 2. Direct answer: is tablet → strip → box already in the plan?

**Yes. It is already a core Slice 3 requirement.** The plan already says:

- stock is stored in the smallest countable base unit;
- packaging is a nested hierarchy, not a single `pack_size` field;
- the package definition is versioned below the medicine;
- each batch retains the conversion that was confirmed when it arrived;
- receiving accepts a mixture such as boxes, strips, and loose units and shows
  the base-unit calculation before posting;
- package levels can have separate barcodes and separate receivable/sellable
  settings;
- price is stored with the package level to which the printed MRP applies.

The example already specified in the plan is:

| Level | Contains | Factor in tablets |
|---|---:|---:|
| Tablet | 1 tablet | 1 |
| Strip | 15 tablets | 15 |
| Box | 10 strips | 150 |
| Case | 20 boxes | 3,000 |

If the clinic receives 2 boxes + 3 strips + 4 loose tablets, the system previews
and posts:

`(2 × 150) + (3 × 15) + 4 = 349 tablets`

What today's answer adds is an explicit POS rule: the counter chooses the
quantity and any enabled sale level at the time of sale. The database still
deducts one exact base-unit total.

---

## 3. The important definition of “basic unit”

The **stock base unit** is the smallest safe, countable physical item the clinic
stocks and can trace. It is not necessarily the unit used to describe a
patient's dose.

| Product presentation | Dose may be expressed as | Recommended stock base unit | Higher package examples | POS may split to |
|---|---|---|---|---|
| Tablet | tablet or mg | tablet | strip, box, case | any integer number of tablets; enabled higher levels |
| Capsule | capsule or mg | capsule | blister/strip, box, case | any integer number of capsules; enabled higher levels |
| Sachet | sachet or contained dose | sachet | box, case | sachet; enabled higher levels |
| Patch | patch | patch | pouch, box | patch if individually identifiable; enabled higher levels |
| Suppository/pessary | unit | one wrapped unit | strip, box | wrapped unit if approved; enabled higher levels |
| Sealed syrup/solution | mL per dose | bottle | carton, case | bottle or higher level; **not arbitrary mL** unless measured dispensing is approved |
| Eye/ear/nasal drops | drops | bottle | carton | bottle or higher level; not individual drops |
| Cream/ointment/gel | g or application | tube/jar | carton, case | tube/jar or higher level; not arbitrary grams |
| Ampoule | mL or dose | ampoule | tray, carton | whole ampoule; no fraction |
| Single-dose vial | mg, mL, or vial | vial | tray, carton | whole vial; no fraction |
| Multi-dose vial | mg or mL per administration | vial | tray, carton | vial at retail; dose administrations require a separate workflow |
| Prefilled syringe | dose | syringe | tray, carton | whole syringe |
| Inhaler | puff/actuation | inhaler/device | carton | inhaler/device; not individual puffs |
| Powder for reconstitution | mL after preparation | bottle/vial | carton | unopened bottle/vial unless a governed preparation workflow exists |
| Kit/combi-pack | component dose | kit, unless components are independently catalogued | carton/case | whole kit by default |
| Dressing/device/consumable | piece, roll, pair, etc. | smallest separately supplied item | inner pack, box, case | configured base or higher level |

This lets the clinic sell a single tablet and a whole box through the same POS
without pretending that ten millilitres can be removed from a sealed bottle or
one puff can be removed from an inhaler.

### Safety boundary

The counter decides **among configured sellable levels**. It does not create a
new conversion or break a protected container during the sale.

This distinction is necessary because package opening may affect identity,
batch/expiry traceability, sterility, stability, storage, or labelling. Indian
rules prescribe retail pack sizes for several dose forms and prohibit altering
or defacing manufacturer inscriptions; current QR requirements may also place
the code on the secondary pack where primary-pack space is inadequate.[4][5]
The software therefore cannot declare every mathematical fraction legally or
clinically saleable.

---

## 4. How the medicine-add screen should work

The form should be a short guided builder, with complexity disclosed only when
needed.

### Step A — identify the medicine

- Generic/ingredient name
- Brand name, if applicable
- Strength, with numerator and denominator units
- Dose form
- Route and release type when clinically relevant
- Manufacturer/supplier identity where available

Clinical identity must remain separate from the physical pack. Paracetamol 500
mg tablet is the clinical drug; a box containing ten strips of fifteen tablets
is one package version of a product.

### Step B — choose the stock base

The UI suggests a safe default from the dose form but lets the pharmacist/admin
choose another valid countable unit.

Examples:

- tablet → `tablet`
- capsule → `capsule`
- oral liquid sold sealed → `bottle`
- cream → `tube` or `jar`
- ampoule → `ampoule`
- inhaler → `inhaler`
- device → `piece`, `pair`, `roll`, or another configured unit

The form must distinguish:

- **stock base:** one bottle;
- **net content:** 100 mL;
- **dose expression:** for example, 5 mL.

Those three values must not share one `unit` field.

### Step C — build the package ladder

The user adds any number of containing levels:

1. `Strip contains 15 tablets`
2. `Box contains 10 strips`
3. `Case contains 20 boxes`

For each level store:

- level name/type, including a custom type;
- direct child level;
- count of children per parent;
- calculated factor in base units;
- may receive at this level;
- may sell at this level;
- may open/break this level;
- minimum sale multiple;
- barcode/GTIN and symbology when present;
- printed MRP basis when applicable.

The UI must show the expanded result in plain language:

> 1 box = 10 strips = 150 tablets

The **Save** action should be disabled when the hierarchy has a cycle, a zero or
fractional count for countable items, two parents for the same level, or an
unresolved base unit.

### Step D — verify against the physical pack

Because both pharmacist and admin can edit, permission alone is not enough.
The final package version records:

- entered by;
- verified by;
- verification time;
- source: physical pack, supplier invoice, manufacturer data, or another named
  source;
- optional pack photographs for catalogue verification, kept separate from
  patient clinical images.

A user may prepare a draft alone. A changed conversion becomes receivable only
after explicit verification against the pack. Requiring a second person for
every ordinary product would slow a small clinic; require a second approval for
changed conversions that already have live stock, or let the owner configure
that stricter policy.

### Step E — receive the batch

The package version prefills the receipt. Staff confirm, rather than silently
inherit:

- quantity by package level;
- total base-unit preview;
- batch/lot;
- expiry;
- MRP **and its labelled package basis**;
- purchase price **and its invoice basis**;
- supplier and invoice.

The batch retains an immutable snapshot of the confirmed conversion. This is
why a later pack-size change cannot rewrite history.

---

## 5. POS behavior

The counter flow should remain fast:

1. Scan or search the exact medicine/package.
2. Show available batches in FEFO order.
3. Offer large touch choices generated from configured levels, such as
   `Tablet`, `Strip`, and `Box`.
4. Let the counter enter a mixed quantity when useful, for example `1 strip + 4
   tablets`.
5. Show `19 tablets will leave stock` and the exact line price before adding.
6. Allocate from eligible batches, prevent negative stock, and record the
   package choice plus the base quantity.

Example:

| Counter entry | Conversion | Ledger movement |
|---|---:|---:|
| 4 tablets | 4 × 1 | -4 tablets |
| 2 strips | 2 × 15 | -30 tablets |
| 1 box | 1 × 150 | -150 tablets |
| 1 strip + 4 tablets | 15 + 4 | -19 tablets |

The POS choice must not mutate the medicine master. If a package is unfamiliar
or the conversion differs from the saved version, the sale pauses for a
pharmacist/admin quick verification and creates a new package version when
appropriate.

### Price rule

Store MRP as `amount + labelled package basis`, not as a naked number. For
example, `₹30 per strip of 15`, not merely `₹30`.

For an approved loose sale, calculate the proportional line amount using exact
decimal arithmetic and round once at the final line according to the clinic's
approved accounting rule. Keep the actual batch and price basis on the sale
line. Tax, MRP, discount, and controlled-medicine behavior require separate
accounting/pharmacy validation before go-live.

---

## 6. Why the hierarchy must be generic and versioned

GS1 assigns identifiers to trade-item hierarchy levels when a level is priced,
ordered, or invoiced; examples include unit of use, each, inner pack, case, and
pallet.[1] HL7 FHIR likewise models packages recursively, permits a package to
contain items or entire packages, and treats different pack sizes as distinct
package definitions.[2]

Therefore the schema should represent:

`medicine → package version → nested package levels → batch → stock movements`

It should not contain fixed columns such as only:

`tablets_per_strip`, `strips_per_box`

Those two fields are useful UI shortcuts for tablets, but cannot represent a
tray of vials, a carton of bottles, a pouch of patches, a box containing a
device and consumables, or an unexpected new package type.

When a manufacturer changes `15 tablets per strip` to `10 tablets per strip`:

- old package version stays active for old batches;
- a new package version is created for new stock;
- each receipt confirms its version and stores a snapshot;
- both batches can coexist and be sold correctly;
- historical receipts, sales, MRP, and stock movements never change.

This is what “ready for everything” should mean: a general structure that can
represent new forms and package depths, while each real product still has a
small, verified configuration.

---

## 7. English starter vocabulary for doctor approval

### Research conclusion

There is no list that is common to **all** doctors. A general physician,
paediatrician, dermatologist, surgeon, and diabetologist see different mixes.
However, Indian primary-care research gives a sound general-medicine starting
point.

In a national one-day study covering 204,912 patients, fever was the leading
presenting symptom; respiratory symptoms appeared in more than half of
patients, followed by digestive, circulatory, skin, and endocrine
presentations. Hypertension, obstructive airway disease, and upper respiratory
infection were the most frequently reported diagnoses.[6] A newer Indian
public-facility study found fever, hypertension, abdominal pain, chest pain,
arthritis, skin disease, cough, diabetes, and injury among common reasons for
encounter.[7] South Indian and Odisha primary-care studies also highlight
chronic follow-up, diabetes, hypertension, respiratory complaints, digestive
complaints, musculoskeletal problems, urinary conditions, and common skin
conditions.[8][9]

The following is therefore a **starter approval list**, not a diagnostic or
treatment protocol. After go-live, rank it using the clinic's own usage. The
doctor should add or remove terms based on Jayamurugan Clinic's last 50–100
visits.

### A. Proposed common complaints

| # | Proposed display phrase | Doctor action |
|---:|---|---|
| 1 | Fever | Approve / edit / remove |
| 2 | Cough | Approve / edit / remove |
| 3 | Runny or blocked nose | Approve / edit / remove |
| 4 | Sore throat | Approve / edit / remove |
| 5 | Headache | Approve / edit / remove |
| 6 | Body pain | Approve / edit / remove |
| 7 | Weakness or fatigue | Approve / edit / remove |
| 8 | Dizziness or giddiness | Approve / edit / remove |
| 9 | Breathlessness | Approve / edit / remove |
| 10 | Wheezing | Approve / edit / remove |
| 11 | Chest pain | Approve / edit / remove |
| 12 | Abdominal pain | Approve / edit / remove |
| 13 | Nausea or vomiting | Approve / edit / remove |
| 14 | Loose stools or diarrhoea | Approve / edit / remove |
| 15 | Heartburn or acidity | Approve / edit / remove |
| 16 | Back pain | Approve / edit / remove |
| 17 | Joint pain or swelling | Approve / edit / remove |
| 18 | Skin rash or itching | Approve / edit / remove |
| 19 | Burning urination or urinary frequency | Approve / edit / remove |
| 20 | Ear pain or discharge | Approve / edit / remove |

Possible replacements/additions: eye redness/discharge, injury/wound, leg pain,
constipation, palpitations, swelling of feet, menstrual complaint, and routine
chronic follow-up.

### B. Proposed common assessment/diagnosis choices

| # | Proposed display phrase | Doctor action |
|---:|---|---|
| 1 | Acute upper respiratory tract infection | Approve / edit / remove |
| 2 | Acute viral febrile illness | Approve / edit / remove |
| 3 | Acute pharyngitis or tonsillitis | Approve / edit / remove |
| 4 | Allergic rhinitis | Approve / edit / remove |
| 5 | Acute bronchitis | Approve / edit / remove |
| 6 | Asthma | Approve / edit / remove |
| 7 | Chronic obstructive pulmonary disease | Approve / edit / remove |
| 8 | Hypertension | Approve / edit / remove |
| 9 | Type 2 diabetes mellitus | Approve / edit / remove |
| 10 | Dyspepsia or gastritis | Approve / edit / remove |
| 11 | Gastro-oesophageal reflux disease | Approve / edit / remove |
| 12 | Acute gastroenteritis | Approve / edit / remove |
| 13 | Urinary tract infection | Approve / edit / remove |
| 14 | Anaemia | Approve / edit / remove |
| 15 | Migraine | Approve / edit / remove |
| 16 | Peripheral vertigo | Approve / edit / remove |
| 17 | Non-specific low back or musculoskeletal pain | Approve / edit / remove |
| 18 | Osteoarthritis | Approve / edit / remove |
| 19 | Dermatitis | Approve / edit / remove |
| 20 | Superficial fungal infection | Approve / edit / remove |

Possible replacements/additions: conjunctivitis, otitis, sinusitis, pneumonia,
thyroid disorder, constipation, depressive/anxiety disorder, injury/wound,
pregnancy-related encounter, and preventive/routine follow-up.

Important rules for the doctor to approve:

- complaints and diagnoses remain separate fields;
- more than one complaint and assessment may be recorded;
- when a disease is not established, the doctor may record a symptom-based
  assessment instead of being forced to select a disease;
- diagnosis status can be provisional, differential, confirmed, or ruled out;
- autocomplete helps find wording but never selects or signs it automatically.

### C. Proposed dosage-direction chips

These are reusable pieces. The prescription preview combines them into a full,
readable sentence that the doctor reviews before signing.

| # | Proposed phrase | Doctor action |
|---:|---|---|
| 1 | Once daily | Approve / edit / remove |
| 2 | Twice daily | Approve / edit / remove |
| 3 | Three times daily | Approve / edit / remove |
| 4 | Four times daily | Approve / edit / remove |
| 5 | At bedtime | Approve / edit / remove |
| 6 | When required | Approve / edit / remove |
| 7 | Before food | Approve / edit / remove |
| 8 | With food | Approve / edit / remove |
| 9 | After food | Approve / edit / remove |
| 10 | Swallow whole | Approve / edit / remove |
| 11 | Do not crush or chew | Approve / edit / remove |
| 12 | Chew before swallowing | Approve / edit / remove |
| 13 | Dissolve or disperse in water before taking | Approve / edit / remove |
| 14 | Shake well before use | Approve / edit / remove |
| 15 | Measure with the supplied cup or syringe | Approve / edit / remove |
| 16 | Apply a thin layer to the affected area | Approve / edit / remove |
| 17 | For external use only | Approve / edit / remove |
| 18 | Avoid contact with the eyes and mouth | Approve / edit / remove |
| 19 | Rinse the mouth after inhalation | Approve / edit / remove |
| 20 | Complete the prescribed course | Approve / edit / remove |

The system must show only direction chips compatible with the selected dose
form/route. It must never attach one because a diagnosis was selected.

### D. Proposed advice/follow-up phrases

| # | Proposed phrase | Doctor action |
|---:|---|---|
| 1 | Drink adequate fluids | Approve / edit / remove |
| 2 | Rest and avoid strenuous activity until better | Approve / edit / remove |
| 3 | Take a light diet as tolerated | Approve / edit / remove |
| 4 | Avoid spicy or oily food until symptoms settle | Approve / edit / remove |
| 5 | Monitor and record temperature | Approve / edit / remove |
| 6 | Monitor blood pressure and bring the readings | Approve / edit / remove |
| 7 | Monitor blood glucose and bring the readings | Approve / edit / remove |
| 8 | Continue regular medicines unless specifically advised otherwise | Approve / edit / remove |
| 9 | Complete the requested tests before review | Approve / edit / remove |
| 10 | Bring previous reports and current medicines at review | Approve / edit / remove |
| 11 | Return for review in ___ days | Approve / edit / remove |
| 12 | Return earlier if symptoms worsen | Approve / edit / remove |
| 13 | Seek urgent care for difficulty breathing | Approve / edit / remove |
| 14 | Seek urgent care for severe or persistent chest pain | Approve / edit / remove |
| 15 | Seek urgent care for fainting, confusion, or unusual drowsiness | Approve / edit / remove |
| 16 | Seek urgent care if unable to keep fluids down | Approve / edit / remove |
| 17 | Seek urgent care for signs of dehydration or reduced urine | Approve / edit / remove |
| 18 | Seek urgent care for blood in vomit, stool, or urine | Approve / edit / remove |
| 19 | Keep the wound or affected area clean and dry | Approve / edit / remove |
| 20 | Follow the diet and activity plan discussed | Approve / edit / remove |

These are optional phrases chosen by the doctor. They must not appear on every
prescription and must not replace patient-specific counselling.

### E. Recommendation about “diagnosis and its cause”

Do **not** preload a universal `diagnosis → cause → medicine` chain. Many
conditions are multifactorial, uncertain, or only provisional during a visit.
The application should instead provide:

- diagnosis/assessment;
- status: provisional, differential, confirmed, ruled out;
- optional relation: suspected due to, associated with, exposure to, or risk
  factor;
- optional cause/agent search or free text;
- doctor's explicit confirmation.

The system may remember the doctor's phrases and favourites. It may not infer a
cause, diagnosis, medicine, or dose as clinical truth.

---

## 8. Remaining clinic validation inputs

### A. Opened-container policy — answered

The clinic answered the following question **No**:

> Does the clinic ever open a bottle, bulk container, or multi-dose vial and
> give or sell only a measured amount from it—for example 30 mL from a larger
> liquid container—or is every bottle, tube, vial, inhaler, and similar
> container supplied whole?

Therefore Slice 3 uses integer, countable stock units. A bottle, tube, vial,
inhaler, or similar container is supplied as a complete unit. Measured
dispensing, opened-container balances, preparation/reconstitution,
beyond-use/discard times, and administration waste are outside initial scope.
They must not be accidentally enabled through a free `mL` or `g` conversion in
ordinary POS.

### B. Real package and invoice evidence

Before the receiving and price screens receive production approval, collect:

- two or three supplier invoices/GRNs with patient-irrelevant private details
  redacted;
- one real tablet/capsule package showing every physical level used by the
  clinic;
- one real non-tablet example such as a bottle, tube, vial, inhaler, or kit;
- one example where the same medicine arrived with a changed pack size or MRP;
- photographs or transcriptions of the batch, expiry, MRP basis, and every
  usable barcode/QR code on those levels.

These are not needed to invent the generic hierarchy. They are needed to prove
that receiving and pricing match the clinic's actual paperwork rather than a
synthetic example.

### C. Doctor vocabulary sign-off — complete

The prepared four starter lists in section 7 were approved on 11 September
2026. They may seed clinic-wide English autocomplete. Doctors can add personal
favourites/templates; later changes to the shared clinic set still require
owner-doctor approval and versioned retirement rather than historical rewrite.

---

## 9. Recommended opening-count procedure

1. Pharmacist and admin export/print the active-batch count sheet after the
   pharmacy counter closes.
2. Pharmacist counts physical stock by exact medicine, package version, batch,
   and expiry. The expected software quantity stays hidden during the first
   count.
3. System converts entered boxes/strips/loose units to base units but retains
   the physical entry.
4. Admin/owner reviews expected-versus-counted variances and requests a recount
   for material differences.
5. Both record names and timestamps. No guessed migration conversion is used.
6. Approved opening adjustments post as append-only ledger movements with a
   reason; the source import remains auditable.

If counting cannot happen after closing, record a count cutoff time and
reconcile all sales/receipts after that time before approval.

---

## 10. Slice 3 acceptance checks added by these decisions

- Create tablet → strip → box → case and show every exact conversion.
- Create bottle → carton and ensure the UI never offers arbitrary mL at POS.
- Create ampoule → tray → carton and ensure a fraction of an ampoule is
  impossible.
- Create a custom package type without a database change.
- Receive mixed package levels and verify the base-unit preview and ledger.
- Sell one tablet, one strip, one box, and a mixed strip-plus-loose quantity.
- Ensure POS can choose only configured sellable levels.
- Change a strip from 15 to 10 tablets by creating a new version; verify old and
  new batches coexist with correct history.
- Map separate package-level barcodes and require manual fallback when no code
  exists.
- Record MRP and purchase price with their package bases.
- Prevent unverified package conversions from receiving stock.
- Complete the blind pharmacist count, admin variance review, and append-only
  opening adjustment.
- Keep measured liquid dispensing disabled; the clinic confirmed that opened
  containers are not divided in the initial workflow.

---

## Sources

1. GS1, [Healthcare GTIN Allocation Rules](https://www.gs1.org/standards/gs1-healthcare-gtin-allocation-rules-standard/current-standard), especially package-hierarchy levels and identification of trade items.
2. HL7 International, [FHIR R5 PackagedProductDefinition](https://hl7.org/fhir/R5/packagedproductdefinition.html) and [package examples](https://hl7.org/fhir/R5/packagedproductdefinition-examples.html), including nested packages and contained-item quantities.
3. Ministry of Health and Family Welfare, [EHR Standards for India, 2016](https://www.mohfw.gov.in/sites/default/files/EMR-EHR_Standards_for_India_as_notified_by_MOHFW_2016_0.pdf), for typed clinical terminology and interoperability direction.
4. CDSCO, [Drugs and Cosmetics Rules, 1945](https://cdsco.gov.in/opencms/export/sites/CDSCO_WEB/Pdf-documents/acts_rules/2016DrugsandCosmeticsAct1940Rules1945.pdf), especially Rules 104A and 105 on inscriptions and retail pack sizes. Later amendments must also be checked.
5. CDSCO, [Final FAQs on QR-code implementation, 21 July 2023](https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2018/UploadPublic_NoticesFiles/Final%20FAQs%20on%20QR%20code%2021.07.2023.pdf), including product, batch, manufacture, and expiry data and primary/secondary label placement.
6. Salvi et al., [POSEIDON study: symptoms and medical conditions in 204,912 Indian primary-care patients](https://pubmed.ncbi.nlm.nih.gov/26566749/), *The Lancet Global Health* (2015). Funding disclosures in the paper include Cipla Ltd.
7. Kujur et al., [Self-reported symptom burden among patients attending public healthcare facilities in India](https://pmc.ncbi.nlm.nih.gov/articles/PMC11073677/), using ICPC-3 categories (2024).
8. Ramesh et al., [International Classification of Primary Care: An Indian Experience](https://pmc.ncbi.nlm.nih.gov/articles/PMC4311343/), South Indian urban primary care (2014).
9. Kanungo et al., [Morbidity patterns among adult patients in an urban Odisha primary-care setting](https://pmc.ncbi.nlm.nih.gov/articles/PMC5749079/) (2018).
10. Government of India Clinical Establishments, [Standard Treatment Guidelines](https://clinicalestablishments.mohfw.gov.in/en/standard-treatment-guidelines). These guidelines support governance and clinical review; they are not an automatic diagnosis-to-treatment table for this application.
