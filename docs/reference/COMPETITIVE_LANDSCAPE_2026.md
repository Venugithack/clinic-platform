# Clinic and Hospital Software Competitive Landscape

**Research date:** 14 September 2026  
**Decision context:** an India-based, doctor-owned outpatient clinic with a small observation area and an in-house dispensary/pharmacy  
**Products examined:** 25 named platforms, from enterprise EHR leaders to low-cost public and open-source systems

## Contents

1. [Executive conclusion](#executive-conclusion)
2. [Evidence method](#how-to-read-this-report)
3. [Market structure](#the-market-is-not-one-market)
4. [Product-by-product scan](#product-by-product-scan)
5. [Feature coverage comparison](#feature-coverage-comparison)
6. [Current workflow](#the-current-platforms-actual-workflow)
7. [UI/UX workflow comparison](#uiux-workflow-comparison)
8. [Frontend, icons, and easy-access audit](#frontend-appearance-icons-and-easy-access-audit)
9. [Inventory, supplier, and reordering deep dive](#inventory-supplier-and-reordering-deep-dive)
10. [Where the platform leads](#where-the-current-platform-leads)
11. [Where the market leads](#where-the-market-leads)
12. [Recommended product sequence](#recommended-product-sequence)
13. [Competitive positioning](#competitive-positioning)
14. [Validation plan](#evidence-and-validation-gaps)
15. [Decisions for review](#decisions-for-review)
16. [Sources](#sources)

## Executive conclusion

The current Clinic Platform should not try to become a miniature Epic or a generic hospital ERP.

Its strongest defensible position is narrower and more useful: **the operating system for a high-throughput, doctor-owned clinic with an in-house dispensary**. The platform already connects clinical intent, actual medicine supply, batch stock, money, compliance, and staff handoffs more coherently than most public clinic-software descriptions show. Its best capabilities are not the number of modules; they are the operational distinctions competitors often flatten:

- what the doctor prescribed versus what the counter actually supplied;
- partial fulfilment, controlled substitution, and traceable dispense state;
- clinical drug identity versus physical product/package/batch identity;
- batch expiry, package conversion, receiving, procurement, blind counts, and stock corrections;
- one counter for prescription dispensing, OTC sale, and outstanding payment;
- role-specific work queues with explicit unfinished and exception states;
- Schedule H1 and audit-sensitive pharmacy operations.

The major weakness is the journey around that strong visit core. Most credible ambulatory products now cover some combination of future appointments, online booking, automated reminders, digital intake, record sharing, patient access, teleconsultation, online payment, recalls, lab result exchange, and interoperability. Indian products increasingly advertise ABDM/ABHA connectivity, while the government-backed eSushrut@Clinic entered the small-clinic market in June 2026 at an effective published price of ₹299 per month for five users.[^17]

The strategic answer is therefore:

1. **Keep the pharmacy and same-day operational depth.** That is the clearest differentiation.
2. **Close the patient-continuity and India-connectivity gaps.** Add scheduling/reminders, simple digital sharing, ABDM, and lab handoff before chasing more hospital modules.
3. **Preserve the walk-in queue.** Add a calendar alongside it; do not replace a workflow that matches a busy Indian clinic with a schedule-only model.
4. **Do not build full IPD, OT, LIMS, RIS/PACS, TPA claims, HR/payroll, or hospital asset management unless the target customer changes.** Those features define a different product and operating model.

The focused inventory audit found a similar pattern inside the product. The stock ledger, package-version, batch, expiry, FEFO, quarantine, GRN, and blind-count foundations are unusually strong. The daily purchasing experience is not yet equally coherent. Two receiving paths implement different rules, supplier return windows cannot be entered on the supplier screen, an order's WhatsApp text can be edited without editing its recorded lines, and reordering is still a static minimum/target calculation that ignores stock already on order. These are consolidation problems before they are feature gaps.

## How to read this report

This comparison uses three evidence levels:

- **Implemented evidence:** the current repository, its product documentation, schema, navigation, and workflow plan.
- **Verified public capability:** an official product page, help centre, technical documentation, government publication, or public product brochure.
- **Vendor claim or analytical inference:** adoption counts, speed claims, usability claims, and inferred screen/workflow character. These are identified as such and should be validated in a structured trial before a buying or parity decision.

An unavailable interactive browser session prevented a true hands-on, side-by-side usability test. UI/UX conclusions below are therefore based on published workflows, screenshots, help structures, demos described by vendors, and information architecture—not measured task times.

In the matrices:

- **Deep** means the reviewed material documents a multi-step operational workflow, not merely a module name.
- **Yes** means a capability is publicly documented.
- **Partial** means the capability is limited, integration-dependent, or its depth is unclear.
- **No evidence** means no reliable evidence was found in the reviewed material; it does not prove the feature is absent.

## The market is not one market

“All-in-one healthcare software” covers products with very different jobs.

| Market layer | Representative products | What the product is really optimizing |
|---|---|---|
| Enterprise health system EHR | Epic, Oracle Health, MEDITECH Expanse | Cross-department clinical record, inpatient safety, order fulfilment, capacity, revenue cycle, interoperability, and patient access |
| Independent ambulatory suite | athenaOne, eClinicalWorks/healow, NextGen Office, Tebra, DrChrono | Provider calendar, charting, e-prescribing/labs, insurance revenue cycle, patient portal, digital intake, reminders, and telehealth |
| India doctor-first clinic software | Practo Ray, HealthPlix, Eka Care | Fast prescription, appointment/queue, billing, patient messaging/retention, mobile use, specialty templates, and increasingly ABDM |
| India clinic/hospital suite | Insta by Practo, Healthray, DocPulse, MocDoc, Clinicea, HODO, PappyJoe, SoftClinic, Clinicia | Modular OPD-to-IPD workflow, pharmacy, lab, billing, inventory, hospital departments, and multi-site administration |
| Public/open ecosystem | NIC eHospital/ORS, eSushrut@Clinic, Bahmni, OpenMRS, OpenEMR | Affordable digitization, configurable clinical records, public-health interoperability, local deployment, and extensibility |
| Current Clinic Platform | This repository | Same-day outpatient flow, observation, in-house dispensing and inventory truth, cash/payment truth, and accountable role handoffs |

KLAS's 2025 ambulatory mindshare study, based on more than 1,200 respondents at 689 organizations, reinforces this segmentation: Epic held the majority of ambulatory mindshare; small practices most often considered athenahealth, Epic Community Connect, and eClinicalWorks; and small practices emphasized usability and specialty content while larger organizations prioritized interoperability and breadth.[^1] This is a US-oriented sample, not a direct India buying guide, but it is useful evidence that “best” changes with practice size and operating model.

## Product-by-product scan

### 1. Enterprise benchmarks

#### Epic

Epic is the breadth benchmark rather than a direct competitor. Its public health-system material spans acute and inpatient care, primary and specialty care, access and revenue, analytics/population health, capacity, and patient experience. MyChart shows how far the patient-facing journey can extend: provider search and open scheduling, wait lists, eCheck-In, questionnaires, document signing, video and e-visits, results, messages, record sharing, medication refills, estimates, payments and payment plans, proxy/family access, linked organizations, and device/app connections.[^2]

**Published workflow shape:** patient self-service and intake → enterprise registration and scheduling → clinician and department worklists → orders and closed-loop fulfilment → discharge/after-visit instructions → results, communication, billing, and continuing care in MyChart.

**What matters here:** not feature parity. Epic illustrates that the patient journey is part of the clinical system, not a marketing website bolted onto it. The relevant lesson for a small clinic is a lightweight post-visit record, follow-up, result, and payment channel.

#### Oracle Health

Oracle Health documents an enterprise workflow across scheduling/registration, EHR, clinician communication, nursing mobility, medication administration, specimen collection, device integration, lab result routing, document capture, and electronic signatures. Its patient-administration layer specifically combines patient self-service with guided front-desk workflows integrated into the EHR.[^3][^4]

**Published workflow shape:** self-service or guided registration → encounter context → orders, documentation, and care-team coordination → barcode/device-supported nursing and specimen workflows → financial/document routing.

**What matters here:** Oracle's “guided workflow” and automatic context movement are relevant design patterns. Its device, infusion, and inpatient scope is not relevant to the current target.

#### MEDITECH Expanse

MEDITECH remains an important acute-care benchmark and appears alongside Epic and Oracle in hospital EHR evaluations. Its public product set covers acute/ambulatory clinical care and hospital departmental systems.[^5] It is included to keep the “top dog” view complete, but the public evidence reviewed here was not detailed enough for a screen-level comparison.

**What matters here:** enterprise breadth comes with implementation, governance, terminology, and change-management requirements. It is a poor template for the information architecture of a four-tablet clinic.

### 2. Global ambulatory suites

#### athenaOne

athenaOne combines EHR, medical billing/practice management, patient engagement, network integrations, and service teams. Public material describes tailored web/mobile/voice charting, integrated histories/orders/results, care-gap insights in the encounter, claims and authorization workflows, patient portal/mobile access, telehealth, appointment management, online payment, and automated wellness outreach. Pricing is described as a percentage-of-collections model rather than a simple seat fee.[^6]

**Workflow:** schedule/intake → integrated chart and care prompts → orders/results → claim and authorization workflow → portal/payment/outreach.

**Strength:** a network-and-services model removes administrative work, not just screens.  
**Weak fit for this product:** US payer workflows dominate; public material does not show the current platform's depth of owned-pharmacy physical operations.

#### eClinicalWorks and healow

eClinicalWorks has one of the clearest public descriptions of the pre-visit workflow. healow Open Access supports online booking. healow CHECK-IN lets a patient confirm demographics and insurance, sign consents, complete questionnaires, pay balances, and review medication/allergy/history data. A kiosk brings the same flow into the clinic. The suite also includes automated reminders/campaigns, telehealth, portal access, results, refills, messages, and a no-show prediction module.[^7]

**Workflow:** self-book → digital check-in or kiosk → EHR encounter → results/refills/messages → automated recall and payment.

**Strength:** reducing front-desk re-entry and making the patient complete routine intake.  
**Lesson:** the current platform should eventually let patients prepare and confirm data, but a link-based flow is more proportionate than building a large patient app first.

#### NextGen Office

NextGen Office explicitly targets independent practices with fewer than ten providers. It packages cloud EHR, practice management, billing, portal, appointment reminders, eligibility, RCM, telehealth, online payment, and refill requests. It now also markets an ambient clinical AI feature that converts conversations into structured SOAP notes for clinician review.[^8]

**Workflow:** provider calendar → patient intake → structured chart → eligibility/billing/claims → portal follow-up.

**Strength:** close target-size match and broad front-to-back practice operation.  
**Gap relative to this platform:** little public evidence of deep batch/package/expiry and prescribed-versus-supplied pharmacy truth.

#### Tebra

Tebra combines practice operations with patient acquisition and reputation. Its published packages cover provider calendar, portal, reminders, document/message management, charting, flowsheets, intake, eLabs/eRx, treatment plans, eligibility, charge capture, claim rejection/denial workflows, A/R reconciliation, statements, online payments, online scheduling, broadcasts, reviews, web profiles, and telehealth.[^9]

**Workflow:** patient discovers/books → digital intake → provider chart → claim/payment automation → reviews, broadcasts, and retention.

**Strength:** the commercial lifecycle around care.  
**Lesson:** “all-in-one” can include acquisition and retention, not only clinical modules. This is a future productization consideration, not a reason to add marketing CRM to the first clinic release.

#### DrChrono

DrChrono is mobile-first and integrates EHR, scheduling, billing, patient engagement, e-prescribing, labs, telehealth, customization, and an integration marketplace. The vendor describes a 30–60 day implementation with a specialist and ongoing account support.[^10]

**Workflow:** mobile/provider schedule → customizable chart → eRx/lab orders → billing and patient communication.

**Strength:** tablet/mobile clinical experience and flexible templates.  
**Lesson:** deployment, migration, training, and support are product features. A technically complete clinic app without repeatable onboarding is not commercially complete.

### 3. India doctor-first clinic products

#### Practo Ray

Ray is the closest recognizable clinic-management benchmark. It is calendar-led and connects appointment reminders, patient rescheduling/cancellation, directions, online payments, patient charting/templates, billing, digital record sharing, post-consult chat, follow-up communication, reports, Practo discovery, and ABDM/UHI-related capabilities. Practo's September 2026 public plan page showed ₹999/month for the one-year Atom plan and ₹1,499/month for a one-year clinic plan at the displayed promotional prices; inclusions and payment percentages vary by plan.[^11][^12]

**Workflow:** calendar/booking → reminder and arrival → patient chart/consult → bill/pay → automatic record sharing → timed follow-up and repeat booking.

**Strength:** the before-and-after visit experience, discoverability, and lightweight clinic administration.  
**Where the current platform is deeper:** dispensary fulfilment, batch/package truth, controlled partial supply, stocktake, purchasing, and compliance workflows.  
**Where Ray is ahead:** real appointment calendar, automated communications, online patient actions, record sharing, and ABDM/UHI positioning.

#### HealthPlix

HealthPlix presents a doctor-first, online/offline EMR with fast prescription creation, specialty-specific modules, teleconsultation, patient retention tools, a patient app, ABHA, and a newly highlighted CRM. Its scale figures—14,000+ doctors, 60 million+ patients, 370+ cities, and prescriptions in 14 languages—are vendor claims.[^13]

**Workflow:** appointment/queue → rapid specialty prescription → share/teleconsult → longitudinal patient engagement and recall.

**Strength:** prescription speed, specialty depth, language support, offline positioning, and an installed doctor network.  
**Where the current platform is deeper:** the business and physical truth after prescribing when the clinic itself supplies medicine.

#### Eka Care

Eka positions EKA DOC as a 360-degree practice tool: a single queue for walk-ins and appointments, billing and dues, specialty digital prescriptions with SNOMED CT/ICD-10 support, reminders, broadcasts, patient app, analytics, teleconsultation, multi-doctor/staff access, and ABDM. Its integration catalogue includes AI note/Rx generation, lab booking/result sync, medication adherence, payments/accounting, ABDM, webhooks, and custom integrations.[^14][^15]

**Workflow:** online or walk-in queue → digital prescription → bill → share by WhatsApp/patient app → follow-up reminder → optional lab, pharmacy, payment, and accounting integrations.

**Strength:** modular ecosystem, coding/ABDM story, and patient communication.  
**Where the current platform is deeper:** owned in-clinic dispensing and inventory.  
**Lesson:** an integration surface can provide breadth without turning every adjacent service into an internal module.

### 4. India hospital and multi-department suites

#### Insta by Practo

Insta is the strongest India-based “full hospital” reference in this review. Its public material covers complex billing, TPA/insurance/corporate/government rates, A/R and A/P, doctor payouts, packages, bed billing, OPD and IPD EMR, MAR, ward activities, IV fluids, discharge, hub-and-spoke lab, PACS/radiology, pharmacy, central inventory, GRN, supplier returns, transfers, indents, reordering, stock adjustment/counting, access control, audit, pending orders, referrals, recalls, multi-centre operations, integrations, and a patient portal.[^16]

**Workflow:** resource schedule/registration/token → billing/deposit/triage → consultation and orders → pharmacy/lab/radiology/service queues → inpatient admission/bed/nursing if required → discharge/claim/receivables → recall and analytics.

**Strength:** department-to-department orchestration and revenue capture.  
**Why not copy it:** a hospital suite's module depth, setup, and navigation burden are inappropriate for a single-doctor clinic. Copy its order-to-fulfilment visibility and exception tracking, not its organizational footprint.

#### Healthray

Healthray markets one shared record across registration/ABHA, appointments/live queues, specialty EMR, IPD/wards, OT, emergency, LIMS, RIS/PACS, pharmacy ward indents/unit-dose supply, billing/TPA/claims, central procurement, assets, HR/payroll, and analytics. It offers cloud, on-premise, and hybrid deployment and advertises HL7/FHIR and Indian scheme connectivity.[^18]

**Workflow:** ABHA/registration → OPD or emergency → clinical orders → departmental worklists → ward/OT if admitted → accumulating charges and claims → discharge and analytics.

**Strength:** institutional breadth and deployment choice.  
**Lesson:** offline/degraded operations and national identity/interoperability matter in India. The HR, OT, and institutional layers do not belong in the current scope.

#### DocPulse

DocPulse spans solo clinics, multi-specialty clinics, hospitals, and chains. Its public workflow is unusually explicit: online/IVR/WhatsApp/walk-in booking feeds one calendar and queue; the doctor sees history and records; lab and pharmacy receive digital orders; billing consolidates services; results return to the EMR; and admins see patient flow, revenue, beds, and branch performance. It advertises IPD, insurance/TPA, telemedicine, LIMS/machine integration, batch/expiry/vendor pharmacy operations, multi-location, and ABDM.[^19]

**Workflow:** omnichannel booking → token/queue → encounter/order → lab/pharmacy fulfilment → consolidated bill → digital delivery and analytics.

**Strength:** a clear connected-department story at several facility sizes.  
**Where the current platform may be stronger:** detailed prescription fulfilment semantics and physical stock truth, subject to hands-on validation.  
**Where DocPulse is ahead:** booking channels, lab, multi-doctor/branch operation, telemedicine, and patient communication.

#### MocDoc

MocDoc offers clinic, hospital, and LIMS products. Public material covers multi-doctor calendars, appointments, OP case sheets, patient dashboards, billing/accounting, hospital registration-to-discharge, pharmacy/inventory, and laboratory billing-to-report dispatch.[^20]

**Strength:** breadth across clinic, hospital, and diagnostics, with a modular growth story.  
**Evidence caution:** public review samples are small. Capterra showed high overall ratings during this review, with praise for ease/support and isolated comments about setup/data entry or interface modernization; these are signals, not population-level usability proof.[^35]

#### Clinicea

Clinicea's help centre documents more workflow depth than a typical marketing page: calendar and resource scheduling, call handling and WhatsApp, CRM, EMR, investigations from sample collection through result sign-off and abnormal-result follow-up, pharmacy/refills, billing/packages/expenses, reports, document management, multiple locations, patient portal, API/integrations, and an offline solution.[^21]

**Workflow:** calendar/resource → registration/visit → investigation/pharmacy/financial work → portal and automated follow-up.

**Strength:** configurable specialty/business workflows and operational documentation.  
**Lesson:** abnormal results and unfinished work should become owned tasks, not passive records—consistent with the current platform's task-state philosophy.

#### HODO

HODO markets separate hospital, clinic, laboratory, and emergency suites with multi-branch operation, central purchasing, patient and staff mobile apps, and ABDM support.[^22]

**Strength:** India-first institutional packaging and mobile roles.  
**Evidence limitation:** the public pages reviewed gave much less task-level detail than Insta, DocPulse, or Clinicea; feature names should be validated in a demo.

#### PappyJoe

PappyJoe advertises appointment/treatment management, progress notes, billing, customized prescriptions, consent, feedback, IPD, lab, inventory, CRM/HRM, WhatsApp/SMS, claims/RCM, beds/transfers, mobile use, and AI-assisted functions.[^23]

**Strength:** very broad feature packaging for clinics and hospitals.  
**Evidence limitation:** breadth is easier to verify than workflow quality; it needs scenario testing before any UI conclusions.

#### SoftClinic

SoftClinic publishes appointment views, patient registration, OPD/e-prescription/test/vaccination records, IPD/bed/OT/round/discharge functions, billing/accounting, statutory registers, reports, regional-language support, and offline-first positioning.[^24]

**Strength:** long-tail reach, regional/offline use, and a traditional full-practice feature set.  
**Lesson:** reliable operation and familiar workflows can matter more than fashionable UI in this segment.

#### Clinicia

Clinicia documents patient records, scheduling/reminders/tokens, online booking paths, signed/template prescriptions shared by WhatsApp or email, billing/expenses, digital consent, and inventory with department requests, purchase orders, goods movement, centralized stock, and low-stock alerts.[^25]

**Strength:** a credible small-to-mid clinic feature baseline.  
**Comparison:** broader than the current platform before the visit, but its public inventory descriptions do not establish equivalent batch/package/fulfilment depth.

### 5. Public and open-source alternatives

#### NIC eHospital and ORS

NIC's eHospital is a web-based, workflow-driven, customizable, multi-tenant HMIS used by more than 1,000 health facilities according to NIC. Its suite covers registration/emergency, OPD, IPD/ADT, billing, lab, radiology, laundry, diet, OT, stores and pharmacy. ORS adds public online appointment booking, lab reports, blood availability, and online payment; the booking flow is mobile verification → hospital/department → availability → date → confirmation SMS.[^26]

**Strength:** public scale, ABDM alignment, and end-to-end hospital scope.  
**Lesson:** national-health integration is no longer a premium differentiator; it is moving toward infrastructure.

#### eSushrut@Clinic

This is the most important new low-end competitive signal. The Ministry of Health launched eSushrut@Clinic on 29 June 2026 as a lightweight, cloud HMIS for small outpatient clinics. The official release lists registration, billing, MIS, speech-to-text, clinical decision support, HPR/HFR onboarding, ABHA, Find ABHA, and Scan & Share. Published pricing is ₹499/month for five users, subsidized to an effective ₹299/month, with the first three months free and extra users at ₹50 each.[^17]

**Strategic implication:** a private product cannot win by being merely “digital registration + prescription + bill” at a low price. It must win on workflow depth, service, reliability, specialty fit, commerce, or a proprietary operating advantage. The current platform's pharmacy/operational truth is such an advantage—if paired with ABDM and a credible patient continuity layer.

#### Bahmni

Bahmni combines an EMR with laboratory, inpatient, stock, billing/accounting, reporting, PACS, and terminology capabilities. Its registration flow includes identity/demographics, visit management, and capture of paper records, X-rays, or other documents by camera into the longitudinal record.[^27]

**Strength:** open-source hospital breadth and implementation flexibility.  
**Trade-off:** open source removes licence dependence, not implementation, configuration, hosting, support, or workflow-design work.

#### OpenMRS

OpenMRS is a configurable open-source clinical platform. Its public feature list includes flexible clinical forms and orders; registration, appointments, queues, billing, stock, labs, and dispensing; granular privileges/audit; multilingual support; exports; and REST/FHIR interoperability with local and national systems.[^28]

**Strength:** extensibility, standards, and public implementation ecosystem.  
**Trade-off:** it is a platform to configure and implement, not a turnkey four-tablet clinic product.

#### OpenEMR

OpenEMR combines practice management and clinical records, with scheduling, check-in-triggered workflows, reminders, e-prescribing, billing, lab integration, decision rules, access controls, multilingual support, on-premise/cloud deployment, and full data ownership.[^29]

**Strength:** mature, free/open software with substantial ambulatory breadth.  
**Trade-off:** its US certification and billing orientation, deployment responsibility, and broad legacy surface make it a reference or build substrate rather than a direct India-clinic UX model.

## Feature coverage comparison

The following matrices group products by comparable operating model. They deliberately distinguish module breadth from workflow depth.

### Patient and clinical journey

| Product/family | Walk-in queue | Future calendar | Self-book/check-in | EMR + Rx | Specialty charting | Lab order/result | Portal/record access | Teleconsult | Automated recall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Current Clinic Platform** | **Deep** | Partial | No evidence | **Deep** | Partial | No evidence | Partial (staff-shared) | No evidence | Partial/manual |
| Epic / Oracle enterprise | Yes | Deep | Deep | Deep | Deep | Deep | Deep | Yes | Yes |
| athena / eCW / NextGen / Tebra / DrChrono | Yes | Deep | Yes–Deep | Deep | Yes | Yes | Deep | Yes | Yes |
| Practo Ray | Yes | Deep | Yes | Yes | Templates | No evidence | Yes | Yes | Yes |
| HealthPlix | Yes | Yes | Partial | Deep | Deep | Partial | Yes | Yes | Yes |
| Eka Care | Deep | Yes | Yes | Deep | Yes | Integration | Yes | Yes | Yes |
| Insta / Healthray / DocPulse | Deep | Deep | Yes | Deep | Deep | Deep | Yes | Yes | Yes |
| MocDoc / Clinicea | Yes–Deep | Deep | Yes | Deep | Yes | Yes–Deep | Yes | Partial–Yes | Yes |
| HODO / PappyJoe / SoftClinic / Clinicia | Yes | Yes | Partial–Yes | Yes | Partial–Yes | Partial–Yes | Partial | Partial–Yes | Yes |
| NIC eHospital / ORS | Yes | Yes | Yes | Yes | Partial | Yes | Yes | No evidence | SMS confirmation |
| eSushrut@Clinic | Partial | Partial | Partial | Yes | No evidence | Partial | ABDM exchange | No evidence | Notifications |
| Bahmni / OpenMRS / OpenEMR | Yes | Yes | Partial | Deep/configurable | Configurable | Yes | Partial–Yes | Add-on/partial | Yes/configurable |

### Operational and institutional journey

| Product/family | Billing/payments | Claims/TPA | Owned pharmacy | Batch/expiry stock | Procurement/GRN | Observation/IPD | Nursing/MAR | Multi-site | ABDM/India exchange | Offline/on-prem |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Current Clinic Platform** | **Deep** | No evidence | **Deep** | **Deep** | **Deep** | Focused observation | Deliberately deferred | No evidence | No evidence | No evidence |
| Epic / Oracle enterprise | Deep | Deep | Deep | Deep | Deep | Deep | Deep | Deep | Country-dependent | Yes/options |
| Global ambulatory suites | Deep | Deep | eRx/integration | Partial | No evidence | No–Partial | No–Partial | Yes | Country-dependent | Mostly cloud |
| Practo Ray | Yes | No evidence | No evidence | Inventory listed in help | Partial | No evidence | No evidence | Yes | Yes | Cloud |
| HealthPlix | Yes | No evidence | Integration/adjacent | No evidence | No evidence | Hospital product | Hospital product | Yes | Yes | Online/offline claim |
| Eka Care | Yes | No evidence | Integration | No evidence | No evidence | No evidence | No evidence | Yes | Yes | Cloud/mobile |
| Insta / Healthray / DocPulse | Deep | Deep | Deep | Deep | Deep | Deep | Deep | Deep | Yes | Cloud/on-prem/hybrid varies |
| MocDoc / Clinicea | Deep | Partial–Yes | Yes | Yes | Yes | Yes/varies | Partial | Yes | Varies | Yes/options |
| HODO / PappyJoe / SoftClinic / Clinicia | Yes–Deep | Partial–Yes | Yes | Yes | Yes | Yes | Partial–Yes | Yes | Varies | Varies |
| NIC eHospital | Yes | Government workflows | Yes | Yes | Yes | Deep | Yes | Multi-tenant | Deep | Government cloud |
| eSushrut@Clinic | Yes | No evidence | Planned/adjacent | No evidence | No evidence | No | No | Cloud tenancy | Deep | Cloud; assisted ABDM modes |
| Bahmni / OpenMRS / OpenEMR | Yes | Configurable/add-on | Yes | Partial–Yes | Partial–Yes | Yes/varies | Yes/varies | Configurable | Integration work | Deep deployment choice |

## The current platform's actual workflow

The comparison baseline is the implemented product described in the current repository, not the archived “hospital all in one” concept.[^30][^31]

### Patient arrival and queue

1. Staff search or register the patient, with duplicate-suggestion support.
2. A same-day arrival/token is created.
3. The patient moves through waiting, vitals, consultation, billing, and supply states.
4. Each role lands on a relevant operational view rather than a generic module directory.

### Clinical encounter

1. The nurse records vitals and context.
2. The doctor opens the next patient, reviews history, and records complaint, history, diagnosis, advice, prescription, and follow-up.
3. Draft and completion states prevent an unfinished consultation from silently appearing done.
4. Print and attached-image flows support the physical visit.

### Dispensing and payment

1. The pharmacy sees prescriptions as actionable work.
2. It can supply in full or partially, with a controlled doctor-authorized substitution route.
3. The system retains both the prescribed drug and the product actually supplied.
4. Stock is allocated by batch and expiry rules.
5. Prescription, OTC, and open-payment work converge at the counter without erasing their different origins.

### Inventory and procurement

1. Products and package versions map clinical medicine to trade items.
2. Receiving captures supplier, package, batch, expiry, quantity, cost, and MRP context.
3. Expiry returns/write-offs, suppliers, purchase orders, and WhatsApp-assisted ordering form the replenishment workflow.
4. Opening counts and stocktakes are blind; discrepancies become explicit review and posting actions.

### Observation and governance

1. A focused four-bed observation workflow covers placement, handoff, transfer, and discharge.
2. It is not a disguised full inpatient module.
3. Audit, Schedule H1, reports, daybook/till, financial review, staff/PIN, and role access support clinic control.
4. Nurse medication administration is intentionally not implemented; it is a safety-sensitive scope decision, not an accidental missing screen.[^32]

The application's 26 current workspaces are role-grouped: daily doctor work emphasizes Today/Consult/Patients; nursing emphasizes Due now/Vitals/Observation; pharmacy emphasizes Counter/Stock/History; administration exposes broader people, clinic, inventory, finance, settings, report, and audit tools.[^33]

## UI/UX workflow comparison

### 1. Starting point

| Pattern | Products | UX consequence |
|---|---|---|
| **Role/task-led** | Current Clinic Platform; enterprise worklists in a more complex form | Users see work that needs action; good for shared tablets and handoffs |
| **Calendar-led** | Practo Ray, Clinicea, NextGen, Tebra, DrChrono | Excellent for appointment-driven clinics; can underrepresent walk-in and downstream fulfilment work |
| **Prescription-led** | HealthPlix, Eka Care | Optimizes the doctor's highest-frequency task; risks leaving pharmacy, stock, and finance as adjacent tools |
| **Department/module-led** | Insta, Healthray, HODO, PappyJoe, many traditional HMS products | Maps a hospital organization clearly; creates navigation and training weight in a small clinic |
| **Patient-context-led** | Epic, Oracle, athenaOne | Keeps chart, orders, communication, and history around one patient; powerful but demands strong cross-system data |
| **Configurable platform-led** | Bahmni, OpenMRS, OpenEMR | Flexible for implementers; UX quality depends heavily on local configuration and governance |

For the present clinic, role/task-led navigation is the correct default. A nurse should not browse “modules” to discover overdue work, and a pharmacist should not reconstruct supply obligations from a patient chart. The best market idea to add is a **calendar as an additional intake surface**, with scheduled patients and walk-ins converging into the same live queue.

### 2. Handoff clarity

The current product's strongest UX principle is that completion has consequences. A consultation is not merely a saved note; it produces billing, dispensing, follow-up, and sometimes observation work. A dispense is not merely a stock decrement; it explains what was prescribed, supplied, unpaid, partial, substituted, or unavailable.

Hospital suites also connect departments, but often expose this through many module queues. Doctor-first EMRs frequently optimize note/Rx completion and then rely on integrations or simpler inventory modules. The current system should retain explicit cross-role status ribbons and exception queues as it adds external integrations.

### 3. Progressive disclosure

The current scope can be easier than a full HMS because it knows what it is not. Four-bed observation does not need hospital-wide bed-class tariffs. A one-doctor clinic does not need a provider utilization dashboard. The interface should keep advanced receiving, package, audit, and financial functions out of daily role navigation while making exceptions impossible to miss.

### 4. Patient UX

This is the largest relative weakness. MyChart, healow, athenaPatient, Ray, HealthPlix, and Eka normalize patient self-service or digital continuity: appointments, intake, messages, records/results, payments, and follow-up.[^2][^6][^7][^11][^13][^14] The current patient WhatsApp action is staff-initiated and consent-gated, which is safer than an uncontrolled send but not a patient product.

The proportionate answer is a **link-first patient layer**:

- appointment confirmation/reschedule/cancel;
- visit summary, prescription, invoice, and follow-up date;
- payment link and receipt;
- requested lab report upload or result view;
- consent and identity checks;
- expiration and revocation for sensitive links.

This can deliver most patient value without the adoption burden of requiring an app download or full portal account.

### 5. Offline and failure UX

HealthPlix, Clinicea, SoftClinic, Healthray, Bahmni, and OpenEMR all advertise offline, local, on-premise, or hybrid options in some form.[^13][^18][^21][^24][^27][^29] These claims vary substantially in meaning, but they expose a real buying concern: what happens when connectivity fails?

For the current platform, “offline mode” should not be claimed until conflict resolution, stock integrity, payments, and audit ordering are designed. A more achievable first step is a visible degraded-state design, safe retry/idempotency, local printable fallback forms, and a tested recovery procedure.

### 6. AI

Ambient documentation, speech-to-text, clinical prompts, and automated workflows are now visible in Oracle, NextGen, DrChrono, Eka integrations, and eSushrut@Clinic.[^3][^8][^10][^15][^17] AI is rapidly becoming table stakes in vendor messaging, but it is not yet evidence that an AI-heavy product produces a safer or faster clinic.

The right first AI use would be assistive and reviewable: draft a complaint/history/SOAP note or turn dictated follow-up advice into structured text. It must never silently finalize diagnosis, medication, substitution, or dispensing.

## Frontend appearance, icons, and easy-access audit

### Verification scope

The current development frontend was rendered and visually inspected at the clinic's primary 1024×768 tablet size on 14 September 2026. The staff-selection screen and six-digit PIN screen loaded with meaningful content, the application and manifest returned successfully, and no Next.js error overlay was present.

The live authenticated workspaces were not opened because no test PIN was available in the current local data and access controls were not bypassed. Their assessment uses the current implementation, navigation definitions, component system, acceptance-tested behavior, and current interactive design references. This is enough to assess structure and design intent, but it is not a substitute for observing a doctor, nurse, pharmacist, and administrator completing real tasks.

### Directional scorecard

These scores are design judgments for the stated clinic and tablet environment, not standardized usability-test results.

| Area | Current assessment | Reason |
|---|---:|---|
| Visual identity | 8/10 | The paper-and-ink system is recognizable and specific to clinic records rather than a generic SaaS theme |
| Visual polish | 7/10 | Clean and coherent, but the entry screens are sparse and some hierarchy feels more utilitarian than finished |
| Icon-system consistency | 8/10 | One 24×24 stroke family, consistent optical sizing, normally paired with text |
| Icon distinctness | 7/10 | Several inventory and administration meanings reuse generic or closely related shapes |
| Touch accessibility | 9/10 | Buttons are deliberately 44–48 px high; PIN keys and staff rows are comfortably tappable |
| Keyboard/screen-reader foundations | 9/10 | Visible focus, semantic navigation labels, named controls, reduced-motion handling, and icon accessibility are considered |
| Doctor/nurse/pharmacy access | 9/10 | Three primary daily stations plus a grouped More drawer keeps repeated work close |
| Administrator access | 7/10 | Twenty-one destinations are sensibly grouped, but still demand scanning and repeated navigation |
| Patient-context continuity | 6/10 | Selected-patient state exists, but patient identity, risk, payment, supply, and follow-up are not yet one persistent visual band |
| Patient-facing experience | 3/10 | The product is almost entirely staff-facing; patients cannot yet book, check in, view records/results, or pay through their own surface |

### Current visual language

The implemented design system in [`app/globals.css`](../../app/globals.css) is called **ink on ledger stock**. It is grounded in the artifacts the software replaces: the OPD register, case sheet, token board, and observation whiteboard.

| Token/decision | Current implementation | Assessment |
|---|---|---|
| Paper | `#f0f5f3` | Calm green-grey ground; suitable for long clinic use |
| Secondary paper | `#e4ede9` | Separates surrounding workspace without decorative gradients |
| Sheet | `#ffffff` | Makes active records read like documents |
| Ink | `#213b32` | Strong dark green identity with adequate visual authority |
| Active | `#176751` | One clear action/current-state colour |
| Attention | `#a35c00` | Reserved for work requiring attention |
| Stop | `#b42318` | Reserved for blocked, dangerous, or destructive states |
| Main type | Archivo | Compact, readable, and more characterful than a default system sans |
| Numeric/code type | IBM Plex Mono | Appropriate for tokens, batch numbers, money, and values that must be transcribed exactly |
| Corners | 2 px | Feels like a clinical record rather than a soft consumer card deck |
| Elevation | None | Hierarchy comes from borders and rule weight, not shadows |

The direction should be retained. It is more distinctive and trustworthy for this clinic than a blue-and-white hospital template or a generic rounded-card SaaS dashboard.

### What already works visually

- The palette is calm, professional, and closely related to the clinic logo without using colour decoratively.
- Active, attention, stop, and available states keep separate meanings.
- Information remains understandable in grayscale because status also uses words and shapes.
- Ordinary boundaries use a light rule, important records use a heavier rule, and the current location uses an ink/active treatment.
- Typography is large enough for a tablet on a desk or counter rather than designed only for a desktop monitor.
- Entered values remain at least 16 px, avoiding iOS focus zoom and supporting physical transcription from medicine packs.
- Checkbox and radio controls are enlarged for thumb use.
- Reduced-motion preference is respected.
- Night shift and high-contrast variants preserve the same status semantics.
- Buttons use direct verbs—such as Save, Dispense, Review checkout, or Sign out—instead of vague Submit labels.
- Loading and unavailable controls explain what is happening or why an action is refused.
- The interface avoids visual fashion that would age quickly: gradients, glass effects, excessive shadows, decorative charts, and animation on every panel.

### Visible entry-screen findings

#### Staff selection

The current screen is fast and safe: clinic identity, session duration, four large staff rows, role labels, and a clear chevron. It is easy to understand without training.

Improvements:

- Increase the clinic mark by roughly 15–20% or use the compact mark beside the clinic name so it has enough visual presence at 1024 px.
- Avoid showing the clinic name as small text inside the logo and again immediately as a large title unless both serve distinct purposes.
- Add a role icon to each staff row: shield/administrator, stethoscope/doctor, pulse/nurse, and counter/pharmacy.
- Keep the person's name as the strongest line and the role as secondary text.
- Render the session-duration sentence in the main sans face. Monospace should be reserved for information someone compares or transcribes, not routine guidance.
- Keep the vertical list rather than changing to small avatar circles. A list scales better when staff are added and makes full names readable.
- Do not encode roles only by colour; the icon and role word must remain.

#### PIN entry

The PIN screen is one of the stronger surfaces. It has a single job, generous number keys, visible progress dots without revealing the PIN, a clearly named back action, and no competing controls.

Improvements:

- Carry the selected role icon into the identity area so staff can confirm at a glance that they selected the right account.
- Keep the current automatic submission after the final digit only while the required PIN length is explicitly stated and progress is announced.
- Preserve the large keys and spacing; visual compactness would make this screen worse.
- Do not add password fields, email addresses, unnecessary illustration, or promotional text.

### Authenticated application shell

The shell in [`components/ClinicApp.tsx`](../../components/ClinicApp.tsx) has the right division of labor:

- Doctor, nurse, and pharmacy receive a short horizontal daily bar.
- Administrator receives a grouped rail on wide screens and a proper drawer on smaller screens.
- Hidden navigation is removed from the accessibility tree rather than merely translated off-screen.
- The shell shows staff identity, role, doctor-presence state, connection freshness, appearance, and sign-out.
- The current workspace provides its own single `h1`, avoiding duplicate page headings.

The main easy-access gaps are not more menu items. They are missing context and missing signals.

#### Add persistent global patient search

Patient search should be available from every authenticated workspace, not only from the Patients station. It should support name, phone, patient ID, and today's token without making the operator leave current work.

Recommended interaction:

1. Tap Search in the header or use a keyboard shortcut.
2. Type name, phone, ID, or token.
3. See recent patients and matches with age/sex/phone context.
4. Open the patient in the current role's appropriate workspace.
5. Preserve unsaved work or explicitly ask before replacing the current patient.

#### Add a persistent patient-context band

When a patient is selected, every clinical or counter workspace should show the same compact facts in the same order:

```text
Token 12 · Kavitha R. · 42/F · Follow-up
Penicillin allergy · ₹220 due · 1 prescription waiting · Result pending
```

The first row identifies the person and visit. The second row shows only safety and unfinished-work facts. This prevents repeated patient lookup and reduces wrong-patient action risk.

#### Add workload counts to navigation

Navigation should answer where work is waiting before a station is opened:

- `Today 6`
- `Due now 3`
- `Counter 4`
- `Review 2`
- `Expiring 8`

Counts must represent actionable work, not total records. Zero counts can disappear. Red should be reserved for blocked/safety-critical work; ordinary waiting counts remain neutral or active green.

#### Improve administrator reach

The administrator's twenty-one stations are correctly grouped, but grouping alone does not remove access cost. Add:

- a short **Needs attention** area on Overview;
- recent stations;
- optional pinned stations;
- global patient and document search;
- counts beside Review, Expiring, Stock-take, Billing, and Activity when action is required.

Do not expose all twenty-six application views in a flat top bar or icon grid.

#### Improve portrait and phone reach

The current top navigation is suitable for a tablet resting on a stand. On a handheld phone, the three daily destinations should become a bottom bar so they stay within thumb reach. More remains the fourth item. The administrator can continue using a menu/drawer because a twenty-one-item bottom navigation is impossible.

### Icon-system audit

The implementation in [`components/ui/Icon.tsx`](../../components/ui/Icon.tsx) is a good foundation:

- one 24×24 coordinate system;
- geometry kept within a consistent optical area;
- 1.75 px strokes with round caps and joins;
- `currentColor`, so icons inherit state rather than inventing it;
- icons normally remain decorative beside a visible text label;
- a deliberate accessible-title path exists when an icon genuinely carries the label;
- only used glyphs ship with the application.

#### Icons that are already clear

| Meaning | Current icon | Judgment |
|---|---|---|
| Consultation | Stethoscope | Strong and familiar |
| Queue | Ordered list | Clear with the Today label |
| Vitals | Pulse | Strong |
| Observation | Bed | Strong |
| Counter | Counterfront | Specific and distinctive |
| Receiving | Truck | Strong |
| Billing/history | Receipt | Strong |
| Money | Rupee | Strong and India-specific |
| Audit/accountability | Shield | Strong |
| Expiry/problem | Alert triangle | Strong when accompanied by text |
| Search | Magnifier | Universal |

#### Icons that should be separated

| Destination | Current risk | Recommended glyph |
|---|---|---|
| Formulary | Tag reads as pricing/category rather than medicine identity | Capsule or tablet with a small identity line |
| Inventory | `pack` and `boxes` overlap visually | Stacked medicine cartons reserved only for stock |
| Stock-take | Reuses boxes/inventory language | Clipboard with count marks |
| Suppliers | Uses generic users | Storefront, warehouse, or supplier building |
| Purchase orders | Shopping bag can read as retail sale | Document with ordered lines and a small arrow |
| Schedule H1 register | Lock reads primarily as security | Ruled ledger with a shield or `H1` mark |
| Clinic settings | Sliders are acceptable but generic | Keep sliders; do not also use them for unrelated configuration |
| Overview | Dashboard grid is understandable but generic | Keep it only for Overview so the meaning becomes learned |

#### Icon rules to retain

1. Never make an unfamiliar icon the only source of meaning.
2. Keep navigation icons at a consistent 19–21 px optical size.
3. Use larger 40–48 px icons only for completion, empty, or blocked result states.
4. Do not mix this stroke family with emoji, filled stock icons, Font Awesome, or multiple vendor libraries.
5. Use colour on the surrounding state or label, not random per-icon colours.
6. Reserve red for dangerous/destructive actions and blocked outcomes.
7. Every icon-only control must have an accessible name and a touch target of at least 44 px.
8. A selected station should be shown by position, rule/background, and text—not by changing only the icon colour.

### Easy-access model by role

The current three-primary-stations model should remain the core navigation rule.

| Role | Primary access now | Keep | Add |
|---|---|---|---|
| Doctor | Today, Consult, Patients | Queue-first landing and one-tap next patient | Waiting count, persistent patient search/context, unsigned-draft count, result-review tasks |
| Nurse | Due now, Vitals, Observation | Due-now landing and observation access | Overdue count, next timed task, patient safety flags, handoff ownership |
| Pharmacy | Counter, Stock, History | Unified counter as landing | Waiting/partial counts, quick scan/search, expiry exceptions, visible payment/supply state |
| Administrator | Overview and grouped rail | Grouped information architecture | Needs-attention summary, pinned/recent destinations, global search, actionable counts |
| Patient | No direct surface | Consent-gated staff sharing | Secure link for appointment, prescription, visit summary, invoice/receipt, payment, result, and follow-up |

### Recommended north-star shell

On a clinic tablet:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Clinic mark  Search patient/token…     Doctor in  Synced  Role      │
├──────────────────────────────────────────────────────────────────────┤
│ Today 6        Consult 1 draft        Patients        More           │
├──────────────────────────────────────────────────────────────────────┤
│ Token 12 · Kavitha R. · 42/F · Follow-up                            │
│ Allergy · ₹220 due · Prescription waiting · Result pending          │
├───────────────────────────────────────────────┬──────────────────────┤
│                                               │ Visit state          │
│ Current role's work                           │ Arrival ✓            │
│                                               │ Vitals ✓             │
│                                               │ Consult current      │
│                                               │ Counter waiting      │
├───────────────────────────────────────────────┴──────────────────────┤
│ Status/explanation                         Primary next action       │
└──────────────────────────────────────────────────────────────────────┘
```

The memorable visual element remains the ruled clinical record and live visit state—not a decorative dashboard hero.

### Frontend improvement register

#### P0 — high-value access and safety

| Improvement | Why it matters | Acceptance signal |
|---|---|---|
| Persistent patient search | Removes navigation detours and repeated lookup | Reach a returning patient from any workspace without opening Patients first |
| Persistent patient-context band | Reduces wrong-patient and missed-obligation risk | Identity, allergy, due amount, supply, result, and follow-up state stay visible where relevant |
| Actionable navigation counts | Makes workload discoverable | Waiting work is visible before opening the station; counts match the underlying task set |
| Role icons on staff selection | Speeds recognition on a shared tablet | Every staff row has name, role word, and distinct family-consistent icon |
| Icon disambiguation | Reduces learning burden in pharmacy/admin areas | Formulary, inventory, stock-take, suppliers, orders, and H1 have non-overlapping shapes |
| Sticky task footer | Keeps completion/review action reachable | Primary action and status remain visible without scrolling through a long record |
| Safe-exit checklist | Prevents a visually completed visit with unfinished downstream work | Payment, supply, follow-up, results, and documents show owned completion or explicit pending state |
| Administrator Needs attention | Replaces hunting across twenty-one stations | Overview links directly to every actionable exception set |

#### P1 — patient journey and richer workflow visibility

| Improvement | Why it matters | Acceptance signal |
|---|---|---|
| Calendar plus queue | Adds scheduled care without breaking walk-ins | Check-in turns an appointment into the same live queue item used by a walk-in |
| Visit-progress rail | Makes handoffs legible | Arrival, vitals, consult, fulfilment, payment, and completion show owner and current state |
| Secure patient link pages | Closes the post-visit experience gap | Patient can view only authorized, time-bounded prescription, summary, bill, receipt, result, and follow-up data |
| Reminder/recall status | Makes communication operational | Scheduled, sent, delivered, failed, and retry/owner states are visible |
| Investigation result inbox | Prevents passive unreviewed reports | Ordered, received, abnormal, reviewed, and patient-notified are separate states |
| Phone bottom navigation | Improves handheld reach | Three daily stations and More remain one-thumb reachable at 320–390 px |

#### P2 — refinement after observation

| Improvement | Why it matters | Acceptance signal |
|---|---|---|
| Recent and pinned admin stations | Speeds owner-specific routines | Repeated stations become one tap without altering permissions |
| Specialty presentation packs | Reduces irrelevant fields | Only evidence-backed specialty charts are added; core encounter stays consistent |
| Assistive dictation/note drafting | Reduces documentation effort | Draft is visibly unverified and cannot finalize clinical decisions |
| Lightweight patient portal account | Useful only if secure links become insufficient | Built after measured repeat-use need, not because competitors have an app |

### Proposed usability acceptance targets

These targets should be validated with representative staff rather than treated as claims:

- Staff identity to role landing: no more than one staff tap plus PIN entry.
- Open the next patient from a role landing: one primary action.
- Find an existing patient from anywhere: one search action plus result selection.
- Reach any daily role station: one tap.
- Reach any authorized secondary station: no more than two taps.
- No ordinary touch target below 44×44 px.
- No core navigation item represented by icon alone.
- No safety or workflow state communicated by colour alone.
- A user can always identify the selected patient and current visit before a write action.
- A disabled safety-sensitive action explains the missing requirement on touch and to assistive technology.
- Network freshness and failed writes remain distinct; a stale snapshot must never look like a successfully saved action.
- At 320, 390, 768, 1024, and 1280 px widths, primary actions remain visible and no fixed-width control forces horizontal scrolling.

### What not to change

- Do not replace the ruled paper-and-ink identity with a generic blue hospital dashboard.
- Do not add decorative gradients, glass panels, floating shadows, or charts without an operational question.
- Do not make every surface a rounded card; record, task, warning, and completion need visibly different structures.
- Do not expose every authorized feature in the primary navigation.
- Do not remove words to make the interface look cleaner; clinical and operational icons need labels.
- Do not use the clinic logo's orange as a second action colour. Keep it in identity artwork; amber already means attention.
- Do not shrink controls to fit more content above the fold.
- Do not animate ordinary navigation or cards. Motion should explain a user-triggered change.
- Do not modernize the PIN screen by adding account/password conventions that are slower on a shared clinic tablet.
- Do not let a visual redesign erase partial, pending, failed, or owner-required states.

## Inventory, supplier, and reordering deep dive

### Executive finding

The inventory foundation is stronger than the purchasing interface built on top of it. The application already has the hard parts many small systems omit: clinical-versus-trade identity, versioned packages, immutable receipt-time conversion, batch stock, FEFO, three stock buckets, append-only movements, cost/MRP basis, idempotent GRNs, partial PO receipts, expiry action, supplier returns, blind opening count, blind recurring stock-take, and purchase/expiry reports.

The main recommendation is therefore **consolidation before expansion**:

> Keep the rigorous database model, but make the pharmacist experience one Stock workspace with a small number of task queues. Remove the older paths that bypass the rigorous model. Add intelligence as an explained suggestion, never as automatic ordering.

The current complexity is not caused by the database having too much detail. Pharmacy stock genuinely needs product, package, batch, expiry, price, and movement detail. The complexity comes from exposing that detail in multiple stations, asking the same question twice, and maintaining old and new ways to perform the same operation.

### What is implemented now

Source code, migrations, and tests take precedence in this table. “Partial” means the data or backend exists but the normal screen does not complete the intended workflow.

| Area | Current implementation | Assessment |
|---|---|---|
| Medicine identity | Substance → clinical drug → trade product → versioned package → batch. Schedule and sale class remain explicit. | **Strong.** Correct separation of clinical intent from the physical item. |
| Package units | Recursive verified package ladders, with immutable conversion snapshots on received batches. Database quantities remain base units. | **Strong foundation.** Daily screens do not consistently translate totals back into boxes/strips/loose units. |
| Barcodes | Mapped codes, symbology, package level, unknown-code queue, and an option to mark GS1-capable codes as carrying batch/expiry. | **Partial reach.** The model is ready, but the main Receiving and Stock-take forms still begin with search/select and typing rather than scan. |
| Batch stock | Available, quarantined, and blocked quantities; active/recalled/withdrawn status; batch expiry, supplier, MRP, cost, package breakdown, and pickability. | **Strong.** The shelf summary is dense and raw-unit-led; actions sit behind a batch modal. |
| Stock issue | Counter allocation is FEFO, excludes expired/non-pickable batches, prevents negative stock, and records allocations and price. | **Strong and safety-relevant.** Preserve it. |
| Goods receipt | Dedicated Receiving station creates a numbered GRN, accepts invoice details, is retry-safe, requires a verified package, accepts physical package counts, and separates accepted, free, quarantined, and rejected quantities. | **Deep implementation.** This should be the only normal receipt path. |
| Purchase orders | Low-stock list, supplier grouping, draft PO, editable WhatsApp message, placed/partial/delivered states, print, and partial receipt. | **Basic workflow with important inconsistencies.** Lines are static base-unit quantities and are not editable from the screen. |
| Suppliers | Contact record, WhatsApp destination, GSTIN/address, active state in data, medicine links, preferred supplier on medicine, and return-window days in data. | **Partial.** Create and link are exposed; edit, disable, preferred-supplier maintenance, and return-window entry are not. |
| Reordering | A medicine is low when pickable on-hand is at or below a manual reorder level. A draft asks for target minus on-hand. | **Simple min/max only.** It does not use consumption, measured lead time, variability, open POs, stockouts, or price history. |
| Expiry | Returnable and non-returnable queues, sorted by return deadline or expiry, return-all, write-off, expected credit, and credited/rejected settlement. | **Good exception concept, incomplete supplier setup and reconciliation.** |
| Opening count | Package-aware blind count, submit, per-line approve/recount/reject, and append-only approved adjustment. | **Strong onboarding control.** It is presented as a permanent station even though it is a one-time rollout task. |
| Recurring stock-take | Partial/full label, blind count, value-based recount threshold, review, approval, append-only adjustment, and history. | **Strong principle, weaker execution than opening count.** It is not package-aware, scan-led, or scope-enforced. |
| Reporting | Stock valuation, expiry/holds, supplier returns, purchase orders versus receipts, and received GRNs/invoices. | **Useful evidence.** Operational decisions still require moving between several screens. |

### The current end-to-end workflows

#### 1. Medicine and package setup

There are two visible ways to begin:

1. **Formulary** follows the current model: define identity, build a package ladder, verify it against a physical pack, and then receive against that verified version.
2. **Stock → Add a medicine** is an older all-in-one form. It asks for identity, classification, supplier, reorder levels, and an optional opening batch with quantity and prices.

The second path is shorter, but it weakens the governing model. Its optional opening quantity can create a batch before a verified package exists and avoids the approved blind opening-count workflow. The right simplification is not to keep both. Use a short “Add medicine” assistant that creates identity first, then either verifies the pack or clearly leaves the product **Not ready to receive**. Opening stock should enter through the opening count, not a hidden field in medicine creation.

#### 2. Supplier setup

The visible path is:

`Suppliers → Add supplier → Edit links → select every medicine carried`

The medicine-link modal is touch-friendly and searchable, but the relationship contains only a yes/no link. It cannot record the supplier's SKU, ordering pack, minimum order, last price, price validity, or lead time. More immediately, the add form does not expose `returnWindowDays`, although the backend accepts it and the Expiring screen tells the user to set it on Suppliers. A supplier created through the current UI therefore receives the safe default of zero days and all their expiring stock behaves as non-returnable. The screen also shows Active/Disabled but offers no edit or disable action.

#### 3. Reorder and place a purchase order

The visible path is:

`Orders → Needs reordering → choose supplier → Create draft order → edit WhatsApp text → Send & place`

The command selects every active, linked medicine at or below its reorder level and calculates `target stock − pickable on hand`, with a minimum of one base unit. It then records those lines and generates a WhatsApp message.

This is understandable as a first min/max implementation, but five problems make it unreliable as the clinic's purchasing cockpit:

- open pending, placed, and partially received POs are not subtracted, so the same shortage can be drafted repeatedly;
- the order quantity is a base-unit number even though the screen says it works out packs;
- the user can edit the WhatsApp message, but cannot edit the recorded PO lines—changing “150” to “2 boxes” in the message does not change what the system believes was ordered;
- sending WhatsApp is the only visible transition from Pending to Placed, so a telephone, printed, or manually sent order cannot be recorded as placed;
- the message asks the supplier to confirm availability and expected delivery, but the application has nowhere to record either answer.

The schema already carries `order_level_name`, `order_level_count`, and `package_version_id` on PO lines, but the current `create_order` path does not populate them. Those fields should be used rather than adding a second package-order model.

#### 4. Receive a delivery

There are again two paths:

- **Receiving** uses `post_goods_receipt`, the current rigorous workflow.
- **Orders → Receive delivery** uses the older `receive_order` shortcut.

The dedicated Receiving station requires a supplier and optional PO, then asks for every delivered medicine, physical package counts, batch, expiry, printed MRP and basis, purchase price and basis, tax, and exceptional free/quarantined/rejected quantities. It creates a numbered goods receipt, preserves the invoice detail, protects against duplicate submission, updates PO progress, and moves stock through the append-only ledger.

The Orders modal instead receives one order line at a time with quantity, batch, expiry, MRP, purchase price, and selling price. It creates the batch directly. It does not require a verified package, record a GRN or supplier invoice, use package quantity/basis, carry an idempotency key, or handle free/quarantined/rejected stock. This is not merely duplicate UI; it creates two grades of stock evidence.

The dedicated form is also more laborious than it needs to be. Selecting a PO does not prefill all outstanding lines, and a user must add and identify each delivery line again. The right result is one receipt engine with two presentations:

- **Receive a PO**: prefilled outstanding lines, with staff confirming what actually arrived.
- **Direct delivery / quick receipt**: supplier and scanned items, clearly flagged when invoice paperwork is missing.

Both must post the same GRN command and preserve the same evidence.

#### 5. Expiry, returns, and credits

The Expiring station correctly distinguishes the deadline to return stock from the expiry date. It groups open expected credits and presents returnable stock separately from stock to dispense first or write off. This is a meaningful advantage over a generic “expiring soon” report.

The workflow is incomplete at its edges:

- return windows cannot be entered or maintained through the supplier UI;
- the screen offers **Return all** or **Write off** for the full available batch, although the backend supports a quantity;
- a return records an internally expected credit at purchase cost, but not the supplier's actual credit-note number, date, amount, or invoice against which it was applied;
- “Credited” closes the return but does not reconcile it against a supplier invoice or purchasing balance;
- no printable/shareable return note action is visible in the reviewed panel.

#### 6. Count and correct stock

The product has two separate blind-count systems:

- **Opening count** is package-aware and has per-line review decisions.
- **Stock-take** is the recurring count and uses one raw base-unit input per batch.

Both correctly hide expected stock while counting and preserve sales that occur before approval by posting a delta rather than overwriting the balance. The recurring screen also sorts review by variance value and requires a second count above a threshold.

However, a “full” stock-take is not proven full: the screen explicitly permits submitting only the batches where a number was typed, and the server requires at least one line rather than every in-scope batch. “Part of the shelf” is a free-text note rather than an enforced rack/product scope. There is no scan-to-count flow even though the barcode model exists.

### Documentation conflict to resolve

`docs/reference/INVENTORY.md` says that `consumption_velocity`, `supplier_lead_time`, `stockout_history`, `supplier_price_history`, and `reorder_suggestions` shipped. A current source search finds those names only in that statement and in a hardening migration's list of **retired public-application views**. The current `jmc` snapshot, command layer, components, and test suite implement manual reorder level/target stock, not learned suggestions.

This report therefore treats intelligent reordering as **planned, not implemented**. Either the reference claim should be corrected, or the missing current-schema implementation should be restored deliberately. It must not be sold as present until the current application exposes and tests it.

### What established inventory products contribute

The useful benchmark is not enterprise screen density; it is how established systems prevent re-entry and make replenishment explainable.

- Odoo's replenishment model separates automatic and manual triggers. Its manual report shows forecasted stock, lead times, arrival dates, and an explicit **Order Once** decision. It also supports minimum, maximum, and order multiples.[^38] For this clinic, the manual-review pattern is the fit; automatic PO creation is not.
- Odoo stores vendor-specific price, supplier product code, discount, minimum quantity, and delivery lead time against the product/vendor relationship, and can use that data to prefill an RFQ.[^39][^40] The lesson is that `supplier_medicines` should become a small procurement profile, not remain only a checkbox.
- Zoho links a preferred vendor and reorder level to the item, can open a PO populated with that vendor's low-stock items, and uses a distinct purchase-receive document for partial receipts and batch/barcode capture.[^41][^42] The current platform already has most of the safer receive-document foundation; it needs a cleaner handoff into it.
- GS1 healthcare guidance supports encoding GTIN plus batch/lot and expiry in GS1 DataMatrix for traceability.[^43] The current barcode data model anticipated this, but receiving and counting need to make it operational while retaining manual verification for packs without structured codes.
- WHO guidance emphasizes FEFO, stock-level and expiry monitoring, alert/buffer stock, timely ordering, and maintained movement records.[^44] The platform already meets much of the traceability side; the missing piece is a usable buffer/reorder decision surface.
- Microsoft's documented cycle-count pattern creates small count work by item or location and resolves differences without blocking ordinary outbound activity.[^45] A small clinic does not need warehouse work orders, but it benefits from the same idea: frequent, bounded counts instead of a rare whole-pharmacy event.

### Complexity and risk register

| Priority | Finding | User impact | Recommended decision |
|---|---|---|---|
| **P0** | Two receiving commands produce different evidence. | Staff must learn two forms; stock can bypass verified packages and GRNs. | Remove the Orders receipt modal. “Receive” deep-links to the dedicated Receiving flow with the PO preselected. Retire the old command after migration/compatibility review. |
| **P0** | Editable WhatsApp text is not the PO record. | Supplier and system can disagree on quantity while both look saved. | Make PO lines editable in package units; generate the message from the saved lines. Allow a note, but do not let free text be the only editable order. |
| **P0** | Supplier return window is data-only. | Expiry returns default to impossible even though the UI tells staff to configure them. | Add supplier edit with return window; show an explicit “No returns agreed” state only when deliberately chosen. |
| **P0** | Reorder ignores quantities already ordered. | Repeated taps can create duplicate purchases and overstock. | Calculate from inventory position: usable stock plus open PO quantity, not shelf quantity alone. Warn on an existing draft/order. |
| **P0** | Base units are presented as ordering units. | “150” may mean tablets while staff and suppliers think “1 box.” | Store and show the ordered package/version and package count, with base-unit translation underneath. |
| **P0** | Initial stock can be created inside Add medicine. | It bypasses verified package and blind opening controls. | Remove the opening batch from ordinary medicine creation; route opening quantities through Opening count or a GRN. |
| **P1** | Supplier records cannot be edited/disabled and preferred supplier is hard to change. | Wrong phone, return terms, or supplier choice becomes permanent from the UI. | Add edit/deactivate and explicit preferred/alternate supplier management. Keep history tied to the old record. |
| **P1** | A non-WhatsApp order cannot become placed. | Printed/telephone orders stay Pending and cannot be received against normally. | Add “Mark placed another way,” requiring channel/reference and date. WhatsApp remains the fastest path, not the state machine. |
| **P1** | PO selection does not prefill the GRN. | Staff re-identify every medicine and can match the wrong line. | Open all outstanding PO lines prefilled; staff confirm batch/expiry/prices and actual quantities. |
| **P1** | Reorder advice has no demand, lead-time, price, or explanation. | Manual levels drift and users cannot judge a suggestion. | Add a transparent suggestion with 30/60/90 consumption, measured supplier lead time, safety buffer, current/open stock, and recent prices. |
| **P1** | Supplier relationship is a checkbox. | No order pack, MOQ, supplier SKU, price, or lead-time defaults. | Extend the existing link into a package-specific procurement profile populated from receipts. |
| **P1** | Return settlement is only Credited/Rejected. | Expected credit can close without recording the real note or invoice application. | Capture actual credit-note reference/amount/date and where it was applied; keep partial credit open. |
| **P1** | Two count systems remain equally prominent. | Staff must decide whether “Opening count” or “Stock-take” is correct. | Hide Opening count after rollout completion; use Stock-take/Cycle count for recurring work. |
| **P1** | Full/partial count scope is descriptive, not enforced. | A one-line count can be filed as whole-pharmacy. | Freeze an explicit batch/item/rack scope at start and show counted/remaining progress without exposing expected quantities. |
| **P2** | Receiving is typing-heavy. | Large invoices require repeated selection and re-entry. | Add scan-first item/package lookup, remember safe supplier/package defaults, and optionally attach the invoice. OCR comes only after the ordinary form is proven. |
| **P2** | No supplier reliability view. | Supplier choice depends on memory. | Show measured lead time, fill rate, price change, late/open orders, returns, and unresolved credits—five facts, not a dashboard of charts. |

### Recommended information architecture

Keep the pharmacist's primary navigation as **Counter · Stock · History**. Do not add Purchasing, GRN, Returns, and Counts as more top-level buttons. Make **Stock** the task-led front door into the existing specialist views.

```text
Stock
├─ Scan or search any medicine / package / batch
├─ Needs action
│  ├─ Reorder (7)
│  ├─ Awaiting delivery (3)
│  ├─ Expiry / return (4)
│  └─ Count due (12)
├─ On shelf
│  └─ medicine row → batch drawer → ledger / hold / correction
└─ Setup and records
   ├─ Suppliers
   ├─ Medicines & packages
   ├─ Goods-receipt history
   └─ Opening count (only until rollout is approved)
```

This does not require one enormous component. The existing routes can remain for deep links and permissions. The simplification is that staff choose the job—**order, receive, return, count**—rather than remembering which of eight inventory modules owns it.

Recommended default Stock page:

- one large **Scan or search stock** field, focused on entry;
- four compact action rows with counts, owner, and the next deadline;
- the shelf list below, with filters for Low, Out, Expiring, Held, and On order;
- one human-readable stock figure, such as **2 boxes · 3 strips · 4 tablets**, with **334 tablets** available as secondary audit text;
- next expiry and on-order arrival on the row;
- row actions limited to **Receive**, **Order**, and **Batches** where relevant;
- a batch drawer for receipt history, movement ledger, status, price, and corrections.

### Recommended target workflows

#### Reorder: review a proposed purchase, do not build it from scratch

1. Stock shows **7 need ordering**.
2. Reorder opens suggestions already grouped by preferred supplier.
3. Each row reads in clinic language:
   - **17 strips on shelf**;
   - **1 box already ordered, expected Tuesday**;
   - **usually uses 3 strips/week**;
   - **supplier normally takes 4 days**;
   - **suggested: 2 boxes**;
   - **why: reaches 3 weeks of cover after the open order arrives**.
4. Staff may accept, change packages, choose an alternate supplier, or snooze with a reason.
5. **Review purchase order** shows the exact saved lines, last purchase price, proposed price, and total.
6. **Send on WhatsApp** or **Mark placed another way** changes the order state.
7. Supplier availability, supplier reference, and expected arrival are recorded when known.
8. **Receive** opens the same PO in the dedicated GRN workflow.

The PO line and the generated message must always agree. If a user edits a quantity, the system regenerates the message. Free-text comments remain possible below the structured lines.

#### Receiving: confirm the physical delivery, with exceptions collapsed

1. Choose or scan the supplier invoice, then choose the PO. If opened from an order, both are already selected.
2. All outstanding lines appear, showing **ordered / previously received / expected now** in order packages.
3. Scan a pack. A mapped GS1 code can prefill product/package and, when actually encoded, batch and expiry. Staff still verify the physical label.
4. Enter what arrived. Accepted quantity is the only open section by default.
5. Expand **Free, damaged, held, or refused** only when the invoice/delivery differs.
6. Show a review list of discrepancies: short, extra, rejected, price changed, new batch, or changed pack.
7. Post once through `post_goods_receipt`; show GRN number, units added, held quantity, rejected quantity, PO remainder, and whether invoice paperwork is complete.
8. Ask whether a short delivery remains expected. Keep it as a backorder or close the remainder with a reason.

Safe defaults can remove much of the current typing:

- MRP basis and purchase basis default from the verified package and last supplier receipt, but remain visibly confirmable;
- tax rate defaults from the last same supplier/package receipt, not from a global guess;
- supplier and PO are inherited from where the workflow began;
- the selected PO supplies medicine and package choices;
- free/quarantine/rejected sections stay collapsed at zero;
- duplicate supplier invoice number for the same supplier warns or refuses according to approved policy.

#### Supplier: one profile, operational facts first

The supplier detail should lead with:

- business name, contact, WhatsApp, and active state;
- agreed return window;
- open orders and next expected delivery;
- outstanding return credits;
- medicines/packages supplied, with last price and order unit;
- measured average lead time and fill rate after sufficient history exists.

Editing contact details or disabling a supplier must not rewrite old orders or receipts. “Preferred supplier” belongs on the medicine/package procurement relationship and should be easy to change with a recorded actor/date.

#### Count and expiry: small queues instead of special projects

- After the approved opening count, remove **Opening count** from ordinary Pharmacy navigation and leave it under Admin → Setup/History.
- Rename recurring **Stock-take** to **Count stock** in the working UI; keep “stock-take” on formal records if desired.
- Offer a suggested cycle count: items never counted, high-value stock, frequent movers, recent discrepancies, and recently received changed packs.
- Freeze the chosen scope. Show **23 of 30 batches counted** without showing expected stock.
- Let scan move immediately to the correct batch count row.
- Keep value-based recount and independent approval.
- In expiry work, allow partial return/write-off, generate a return note, and retain the batch remainder.
- Keep the expiry queue sorted by the action deadline, not by raw expiry alone.

### A reorder calculation users can understand

Do not introduce an opaque forecasting service. A small clinic can use a deterministic calculation whose inputs are visible:

```text
inventory position = pickable on hand + open PO quantity

expected need = recent daily use × (measured supplier lead time + review interval)

target = expected need + safety buffer

suggested order = target − inventory position
                  rounded up to the supplier's order multiple
```

Use the 30-, 60-, and 90-day movement history to show whether consumption is stable or changing. A practical first version can weight 30 days most heavily, cap obvious one-off anomalies for review rather than silently deleting them, and fall back to the clinic's manual reorder/target levels until enough history exists. The safety buffer can increase when lead time varies or stockouts occurred. A waiting prescription may be shown as known near-term demand, but it must not become an invisible stock reservation without an explicit clinic policy.

Every suggestion should save its input snapshot and user decision so the clinic can later answer:

- What did the system know?
- Why did it suggest this quantity?
- Who changed or ignored it?
- Did the supplier deliver on time and in full?

Nothing should create or send a PO automatically. Established systems support automatic replenishment, but the current clinic policy and risk profile favor the manual-review pattern.[^38]

### Minimal data improvements

Prefer extending current tables and relationships over creating a parallel inventory model.

| Existing area | Minimal additions or activation |
|---|---|
| `suppliers` | edit/deactivate command; normalized WhatsApp/phone; return policy; optional credit terms/minimum order; measured metrics derived from transactions rather than manually typed claims |
| `supplier_medicines` | package version, supplier SKU/name, preferred rank, order level and multiple, MOQ, last/agreed price, price-valid-from/to, stated lead time; retain history instead of delete-and-reinsert when procurement facts matter |
| `purchase_order_lines` | use the existing package-version/order-level columns; add quoted/ordered price basis where approved; retain base-unit total as derived audit quantity |
| `purchase_orders` | expected arrival, supplier acknowledgement/reference, placed channel, closed-short reason, cancellation action, and a status transition that does not depend on WhatsApp |
| `goods_receipts` | supplier-invoice duplicate protection, paperwork-complete state, optional invoice attachment, and explicit discrepancy summary |
| `supplier_returns` | actual credit-note reference/date/amount, partial settlement, and invoice/application link |
| reorder suggestion | calculated input snapshot, proposed package quantity, reason/explanation, status (reviewed/ordered/snoozed/dismissed), actor, and link to the resulting PO |
| stock history | derive stockout events and supplier lead time from movement/PO/GRN history where possible; store only an event or snapshot when derivation would lose meaning |

Database protections should continue to carry the irreversible rules: no negative stock, append-only ledger, valid state transitions, one receipt effect per idempotency key, PO receipt not above the approved tolerance, and no expired stock entering available inventory. Interface defaults reduce work; they do not replace database constraints.

### Visual design, icons, and easy access

Keep the paper-and-ink visual system. Inventory benefits from a restrained ledger feel more than from generic blue ERP cards. Differentiate actions through icon shape, text, and status—not decorative colour.

| Task | Recommended icon | Avoid |
|---|---|---|
| Stock / on shelf | stacked cartons with visible separation | the same “boxes” icon for both stock and stock-take |
| Receive | truck or tray with inward/down arrow | truck alone when it could mean supplier or delivery history |
| Reorder / PO | lined document with small outward arrow | shopping bag, which reads as patient purchase or retail basket |
| Supplier | storefront/warehouse with contact marker | generic users, already used for patients and staff |
| Count stock | clipboard with tally marks | another carton icon |
| Expiry | calendar/hourglass with alert mark | alert triangle alone, which says danger but not time |
| Return | carton with return arrow | receive-truck icon reused in reverse without words |
| Supplier credit | rupee with return/check mark | rupee alone, already used for payment and daybook |

Every icon keeps its label. Action counts belong beside the label: **Reorder 7**, **Receive 3**, **Expiry 4**. Use 48 px targets, sticky primary actions on long forms, and a persistent scan action that never competes with the final destructive/posting action. On phones or portrait tablets, turn wide shelf tables into rows with the three facts needed for a decision and open the remainder in a drawer.

### Recommended delivery sequence

#### P0 — make one safe, coherent inventory workflow

1. Remove the Orders receipt shortcut and route every PO receipt through the dedicated GRN.
2. Remove optional opening stock from ordinary Add medicine; use verified packages plus opening count/GRN.
3. Make structured PO lines editable and regenerate WhatsApp from them.
4. Subtract open PO quantities and block accidental duplicate reorder drafts.
5. Activate package ordering fields and display order quantities in boxes/strips with base-unit audit text.
6. Add supplier edit, deactivate, return-window, and preferred-supplier controls.
7. Add a non-WhatsApp placed channel and a cancel/close-short transition.

#### P1 — reduce navigation and re-entry

1. Turn Stock into the task hub with Reorder, Awaiting delivery, Expiry/return, and Count due queues.
2. Prefill Receiving from the PO and collapse exception sections until needed.
3. Add scan-first receipt and count entry.
4. Hide Opening count after rollout and make recurring counts package-aware with explicit scope/progress.
5. Complete supplier credit-note reconciliation and show open credits on the supplier profile.
6. Show on-order quantity and expected arrival in Stock.

#### P2 — add transparent purchasing intelligence

1. Add demand/lead-time/safety-buffer suggestions with a manual min/max fallback.
2. Build supplier procurement profiles from receipt history: package, price, MOQ, lead time, and supplier code.
3. Add a compact supplier scorecard and price-change warning at PO review.
4. Add invoice attachment and only then test assisted extraction/OCR on real clinic invoices.
5. Consider alternate-vendor quote comparison for expensive or unavailable lines only after routine purchasing works.

### Usability and correctness acceptance targets

Validate with the pharmacist and owner on representative invoices, not synthetic perfect data.

- A user can reach Reorder, Receive, Expiry action, or Count from Stock in one tap.
- There is exactly one production command path that adds a supplier delivery to stock.
- No receipt can bypass a verified package, GRN, idempotency key, or batch/expiry evidence.
- Opening a PO in Receiving shows every outstanding line without reselecting medicines.
- The displayed PO line, saved PO line, printed order, and WhatsApp order always show the same package quantity.
- A second reorder attempt visibly accounts for open draft/placed quantities and cannot silently duplicate them.
- Every supplier can be edited, disabled, assigned a return window, and given a preferred/alternate relationship without changing historical receipts.
- A ten-line normal PO receipt requires entry only of facts that changed from the PO/last verified package.
- A structured barcode can identify package and, where encoded, batch/expiry; an ordinary barcode never pretends to carry lot data.
- A full count cannot submit until every frozen in-scope batch is counted or explicitly marked inaccessible with a reason.
- No expected stock quantity reaches the counting client before submission.
- An open supplier return cannot close as credited without an actual credit amount and reference; a partial credit remains visibly open.
- All destructive or financially consequential stock actions show a focused review and a result that names quantity, batch, value, actor, and remaining work.

### What not to add

- Do not build a generic warehouse-management system with bins, waves, pick faces, forklifts, or transfer orders for one in-house dispensary.
- Do not add automatic PO creation or sending.
- Do not add opaque AI demand forecasting before the deterministic calculation and its inputs are trusted.
- Do not show every supplier metric as a chart. Lead time, fill rate, last price change, open orders, and open credits are enough.
- Do not make pharmacists understand “clinical drug,” “product,” “package version,” and “batch” on every daily screen. Show brand/strength/pack/batch; keep the precise model underneath and reveal it in setup/audit detail.
- Do not merge Supplier, Purchase Order, Goods Receipt, Return, and Credit into one database object to make the navigation look simpler. They are different real-world events. Simplify the entry points while preserving their identities.
- Do not use invoice OCR as a substitute for physical batch, expiry, pack, and damage verification.

### Recommended inventory decision

The product does not need a larger inventory module. It needs **one trustworthy route through the inventory module it already has**.

The highest-value change is to make Stock the calm front door, make the rigorous GRN the only receipt path, make orders structured and package-aware, make supplier terms editable, and calculate reorder suggestions from on-hand plus on-order stock with a plain-language explanation. That reduces visible complexity while increasing correctness—the right direction for a four-tablet clinic.

## Where the current platform leads

### 1. In-house dispensary truth

Most clinic systems document e-prescribing, a pharmacy module, or stock. The current platform connects the entire physical chain in one small-clinic workflow:

`clinical drug → prescription → product/package → batch → actual supplied quantity → invoice/payment → stock ledger → audit/register`

That chain is commercially meaningful and safety-relevant. It is the most defensible feature cluster in the product.

### 2. Walk-in reality

Many ambulatory suites start from a provider calendar. The current platform starts from today's arrivals and role work. For high-walk-in environments, this is a better operational truth. Adding appointments should enrich this flow, not force every patient into a rigid slot.

### 3. Honest partial states

Partially supplied prescriptions, unpaid balances, pending follow-ups, unreadable legacy prescriptions, unposted counts, expiring batches, and supplier credits remain visible. This avoids a common all-in-one failure: many records exist, but nobody owns unfinished work.

### 4. Appropriate observation scope

The current four-bed workflow is more usable for the stated clinic than a copied IPD suite. It supports handoff, transfer, and discharge without importing wards, bed classes, diet, laundry, OT, insurance preauthorization, and discharge accounting.

### 5. Small-team role design

Doctor, nurse, pharmacy, and administrator have distinct home surfaces, while multi-role accounts can switch context. That is a stronger small-clinic model than a department menu containing dozens of modules.

## Where the market leads

### Critical gaps

1. **Appointment calendar and future scheduling.** The present appointment record is principally a same-day arrival/token, not a complete future resource calendar.
2. **Automated reminders and recalls.** Follow-up dates exist, but reliable scheduled patient outreach is not a complete product workflow.
3. **ABDM/ABHA.** Indian competitors and public systems increasingly make national identity and record exchange visible. As of 6 February 2025, the government reported 73.98 crore ABHA, 49.06 crore linked health records, 3.63 lakh registered facilities, and 1.59 lakh facilities using ABDM-enabled software.[^34]
4. **Lab/referral loop.** The market commonly supports order → sample/referral → result → clinician review → patient notification. The current platform has document/image support but not a proper investigation work queue.
5. **Patient continuity.** There is no patient-owned view for prescriptions, visit summaries, results, bills, payments, or appointment actions.
6. **Online intake and consent.** Staff still carry the whole demographic/history entry burden.
7. **Data portability and integration surface.** Mature products expose interfaces or repeatable exchange. OpenMRS makes this explicit through REST/FHIR; Eka advertises webhooks and custom integrations.[^15][^28]
8. **Connectivity resilience.** There is no verified offline/degraded operating model.

### Important but second-order gaps

- online payment links and reconciliation;
- multi-provider/resource scheduling;
- teleconsultation with encounter and payment continuity;
- specialty chart packages such as pediatrics growth/vaccine, diabetes trends, dermatology image series, or gynecology flows;
- patient broadcasts and recall cohorts;
- self-service document upload before or after the visit;
- accounting export;
- onboarding/migration tools, guided setup, training, and in-product support;
- published integration, backup, restore, and exit procedures;
- assistive speech/ambient note drafting with mandatory clinician review.

### Gaps that are not gaps for this target

- full inpatient admission/discharge/transfer;
- nurse medication administration record and five-rights barcode workflow;
- OT and anaesthesia;
- complete LIMS, analyzer integration, or blood bank;
- RIS/PACS and DICOM worklists;
- TPA, insurance preauthorization, claim coding, and denial management;
- hospital HR, payroll, duty roster, laundry, diet, biomedical assets, and accreditation evidence packs;
- enterprise population health and bed-capacity command centres.

These are legitimate features in Insta, Healthray, Epic, Oracle, NIC eHospital, and other hospital products. Adding them now would weaken the current product by changing its customer, information architecture, risk profile, and implementation burden.

## Recommended product sequence

### P0 — required to become a credible clinic product

#### 1. Calendar plus queue convergence

Add future appointments, provider availability, reschedule/cancel/no-show, and reminder state. At check-in, a scheduled appointment becomes the same arrival/token object used by walk-ins. One queue remains the operational truth for today.

#### 2. Automated reminder and follow-up engine

Support appointment confirmation, configurable reminder timing, missed-visit follow-up, and clinician-selected recall. Every message should retain consent, destination, template/version, delivery state, retry state, and owner when delivery fails.

#### 3. Minimal patient share layer

Provide secure, expiring links for visit summary, prescription, invoice/receipt, follow-up date, and later results. Start with WhatsApp/SMS delivery rather than a mandatory native app.

#### 4. ABDM foundation

Implement facility/professional onboarding support, ABHA discovery/linking with consent, Scan & Share where applicable, and standards-based health-record exchange. Treat this as infrastructure and compliance work, not a badge.

#### 5. Investigation/referral loop

Do not build a full LIMS. Build test/referral ordering, external lab/facility, patient instructions, pending/result-received/clinician-reviewed/patient-notified states, report attachment, abnormal flag, and ownership of overdue results.

#### 6. Portability and recovery proof

Ship patient, encounter, invoice/payment, dispensing, inventory, and audit exports plus tested backup/restore and an owner-readable recovery runbook. Trust during failure and exit is part of the product.

### P1 — meaningful growth layer

- public booking link and lightweight pre-visit intake;
- payment links tied to invoices and reconciliation;
- multi-doctor, room, and equipment calendar if the clinic expands;
- teleconsult appointments using the same encounter, prescription, bill, and follow-up chain;
- specialty packs selected by actual customer demand;
- patient upload of prior records and lab results;
- accounting export and a documented API/webhook surface;
- narrowly scoped, reviewable voice-to-note assistance.

### P2 — only after customer evidence

- multi-location control and shared patient identity;
- packages, memberships, and treatment plans;
- CRM/leads/reputation features;
- external pharmacy, home delivery, or diagnostic marketplace integrations;
- advanced population/clinical analytics;
- richer patient account/portal.

### Separate product, not a roadmap item

If the target becomes a 20–100 bed hospital, create a separate hospital product plan. That plan would require full IPD, MAR, OT, lab/radiology, TPA/claims, central stores, departmental charging, duty rosters, assets, hospital accreditation workflows, and a different safety/governance program. It should not be smuggled into the clinic navigation one module at a time.

## Competitive positioning

### Recommended category statement

> A clinic operating system for doctor-owned practices with an in-house dispensary—connecting today's queue, consultation, actual medicine supply, stock, payment, and follow-up without hospital-software overhead.

### Proof points to sell

- The prescription and the supplied medicine are never silently treated as the same thing.
- Partial fulfilment and doctor-authorized substitution remain traceable.
- Batch, expiry, package size, MRP, cost, and stock movement stay connected.
- The counter handles prescription, OTC, and payment work in one place.
- Blind counts, expiry action, purchasing, H1 records, daybook, and audit are operating workflows, not report names.
- Each role starts with today's work and visible exceptions.
- Observation is designed for a small clinic, not copied from hospital IPD.

### Claims to avoid

- “Complete hospital management system.” It is not, and should not be for this target.
- “AI-powered” before a tested clinical review and safety model exists.
- “ABDM compliant” before the required milestones and production exchange are verified.
- “Offline-first” before concurrent stock, payments, conflict resolution, and audit ordering are safe.
- “Better UX than Epic/Practo/HealthPlix.” The present evidence supports a better fit for this clinic workflow, not a general usability victory.

## Commercial signals

Public prices are not directly comparable because vendors vary by users, modules, services, transaction fees, implementation, hosting, and country:

- Practo Ray publicly displayed ₹999/month and ₹1,499/month annual-plan options during this review, with different storage, reports, doctor limits, SMS allowances, and payment fees.[^12]
- eSushrut@Clinic publishes an effective subsidized price of ₹299/month for five users, three months free, and ₹50 for each additional user.[^17]
- Eka uses plan/module/add-on packaging, including WhatsApp credits and optional integrations; public pages should be quoted for the exact current package rather than reduced to one headline price.[^14][^15]
- Insta and many HMS vendors price after assessing users, centres, modules, integrations, implementation, and cloud/on-premise needs.[^16]
- athenaOne states that its price follows a percentage-of-collections model.[^6]

The implication is not “be cheapest.” A ₹299 public option makes price competition on generic EMR functions unattractive. Charge for the operational value that low-end systems do not clearly provide: preventing stock loss, keeping dispensing and payment truthful, reducing missed follow-up, and making a small team accountable without hospital-level complexity.

## Evidence and validation gaps

Before converting this research into product commitments, run scenario-based trials with the closest competitors: Practo Ray, HealthPlix, Eka Care, DocPulse, Clinicea, and one full HMS such as Insta or Healthray.

Use the same scenarios in every trial:

1. register a returning patient with a possible duplicate;
2. schedule tomorrow, reschedule, mark arrival, and add a walk-in between slots;
3. record vitals and complete a repeat consultation in under two minutes of documentation time;
4. prescribe a drug that is partly in stock, substitute with doctor approval, and collect a part payment;
5. receive two package sizes and two batches of the same medicine at different MRPs;
6. return an expiring batch and reconcile supplier credit;
7. order an external lab test, upload a result, flag abnormal, review, and notify the patient;
8. lose connectivity or duplicate-submit during payment/dispense;
9. export a complete patient record and an inventory ledger;
10. remove a staff member and inspect the resulting audit trail.

Capture task time, clicks/taps, re-entry, errors, dead ends, role switching, recovery after interruption, and whether the system exposes unfinished work. A feature checkbox cannot answer those questions.

Public review sites add only weak supporting evidence. MocDoc's small Capterra/G2 samples include positive ease/support signals and occasional complaints about setup, data entry, lag, customization, or dated presentation.[^35][^36] HealthPlix patient-app reviews include individual complaints about support and profile/booking behavior, but they do not evaluate the doctor's EMR.[^37] Practo Ray reviews can be mixed with consumer Practo experiences, so the public score was excluded. These sources are useful for generating test cases, not ranking products.

## Final decision

The current platform is not behind because it lacks hospital breadth. It is behind where a patient and clinic encounter the product before and after the consultation, and it is exposed in India by the absence of ABDM and a lab/referral loop.

The winning sequence is:

`booking/reminder → one live queue → consultation → truthful dispense/payment → result/follow-up → secure patient share → ABDM exchange`

That sequence would combine the market's strongest patient-continuity pattern with the current platform's unusually strong pharmacy and operational core. It is a more credible and differentiated product than either a generic appointment-and-prescription app or an overgrown small-hospital ERP.

## Decisions for review

The following decisions convert the research into a coherent product direction. They are intentionally stated for review rather than silently assumed:

1. **Category:** position the product as a clinic operating system for doctor-owned practices with an in-house dispensary, not as a complete hospital management system.
2. **Core differentiator:** keep prescribed-versus-supplied truth, partial fulfilment, controlled substitution, batch/package/expiry accuracy, stocktake, purchasing, payment, H1, and audit as the product's deepest connected workflow.
3. **Navigation:** retain role/task-led daily navigation—three primary stations plus More—and the administrator's grouped rail.
4. **Visual identity:** retain the restrained paper-and-ink system, semantic colours, square record geometry, and no-elevation hierarchy.
5. **Immediate frontend work:** prioritize persistent patient search/context, workload counts, role icons on staff selection, clearer pharmacy/admin icons, sticky actions, and an administrator Needs attention surface.
6. **Appointment model:** add a future calendar beside the existing walk-in flow; both must converge into one live arrival queue.
7. **Patient layer:** begin with consent-controlled, expiring links rather than requiring a native app or full account portal.
8. **Continuity:** make reminders, follow-up, result review, and patient notification accountable task states.
9. **India infrastructure:** treat ABDM/ABHA and Scan & Share as foundational exchange capability, not a marketing badge.
10. **Diagnostics:** add the external test/referral/result/review loop before considering a complete LIMS.
11. **AI:** use AI only for visible, reviewable assistance such as dictated draft notes; never silently finalize clinical or dispensing decisions.
12. **Resilience:** prove backup, restore, export, retry, stale-state, and degraded-connectivity behavior before claiming reliability or offline operation.
13. **Scope boundary:** leave full IPD, MAR, OT, RIS/PACS, claims/TPA, HR/payroll, laundry, diet, and hospital asset management outside this product unless the customer target changes.
14. **Validation:** observe representative staff completing the scenario set in this report before declaring the frontend complete or superior to a competitor.
15. **Inventory consolidation:** keep `post_goods_receipt` as the one receipt engine and retire every UI path that creates received stock without the verified package, GRN, invoice context, and retry protection.
16. **Purchasing truth:** make PO lines structured, editable, package-aware, and authoritative; WhatsApp/print content must be generated from those saved lines.
17. **Reorder policy:** calculate transparent manual suggestions from usable plus on-order stock, recent consumption, supplier lead time, and a visible safety buffer; never create or send orders automatically.
18. **Supplier operations:** expose supplier edit/deactivation, return windows, preferred/alternate procurement profiles, recent price, expected delivery, and unresolved credits without building a general ERP vendor module.
19. **Inventory access:** make Stock the task hub for Reorder, Awaiting delivery, Expiry/return, and Count; hide Opening count from routine pharmacy navigation after rollout approval.

## Sources

All web sources were accessed on 14 September 2026 unless a publication date is stated. Vendor adoption, performance, compliance, and usability statements remain vendor claims unless corroborated by a government or independent source.

[^1]: KLAS Research, [“Ambulatory Core Solutions Mindshare 2025,” 22 April 2025](https://klasresearch.com/report/ambulatory-core-solutions-mindshare-2025-which-vendors-are-top-of-mind-for-ambulatory-practices/3463). The public brief reports the respondent/organization counts and key findings; KLAS itself cautions that results are not conclusive for an entire client base.
[^2]: Epic, [MyChart feature catalogue](https://www.mychart.org/l/en-us/explore/) and [Health Systems and Clinics](https://www.epic.com/software/health-systems-and-clinics/).
[^3]: Oracle Health, [Clinical Suite](https://www.oracle.com/health/clinical-suite/).
[^4]: Oracle Health, [Patient Administration](https://www.oracle.com/health/revenue-cycle/patient-administration/).
[^5]: MEDITECH, [Expanse product set](https://home.meditech.com/en/d/mktcontent/otherfiles/expanseproductset.pdf).
[^6]: athenahealth, [athenaOne](https://www.athenahealth.com/solutions/athenaone).
[^7]: eClinicalWorks, [Patient Engagement and healow](https://www.eclinicalworks.com/products-services/patient-engagement/).
[^8]: NextGen Healthcare, [NextGen Office for small practices](https://www.nextgen.com/solutions/electronic-health-records/small-practices-nextgen-office).
[^9]: Tebra, [Plans and feature comparison](https://www.tebra.com/pricing).
[^10]: DrChrono, [EHR platform](https://www.drchrono.com/ehr/) and [plans](https://www.drchrono.com/pricing/).
[^11]: Practo, [Ray clinic management](https://www.practo.com/providers/clinics/ray) and [Ray help centre](https://help.practo.com/).
[^12]: Practo, [Ray plans and pricing](https://www.practo.com/providers/clinics/ray/plans). Prices and promotions can change.
[^13]: HealthPlix, [EMR and digital clinic](https://www.healthplix.com/). Adoption, security, prescription-speed, and market-position statements on this page are vendor claims.
[^14]: Eka Care, [EKA DOC for doctors](https://www.eka.care/s/for-doctors) and [clinic plan comparison](https://www.eka.care/practice-management/plan-pricing).
[^15]: Eka Care, [integration catalogue](https://product.eka.care/s/for-doctors/integrations-browse).
[^16]: Insta by Practo, [hospital solution](https://www.instahms.com/hospital), [pharmacy and inventory](https://www.instahms.com/pharmacy-and-inventory), and [pricing approach](https://www.instahms.com/row/pricing).
[^17]: Press Information Bureau, Ministry of Health and Family Welfare, [“Union Health Minister Launches eSushrut@Clinic,” 29 June 2026](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2278996&lang=1&reg=6).
[^18]: Healthray, [Hospital Information Management System](https://healthray.com/hospital-information-management-system/). Scale and compliance statements are vendor claims; the page links its NABH listing.
[^19]: DocPulse, [Hospital and Clinic Management Software](https://docpulse.com/). Scale, compliance, uptime, and performance statements are vendor claims.
[^20]: MocDoc, [product overview](https://mocdoc.com/) and [Clinic Management System brochure](https://mocdoc.com/images/new-homepage/CMS-Brochure.pdf).
[^21]: Clinicea, [product help centre](https://help.clinicea.com/en/) and [calendar workflow](https://help.clinicea.com/en/article/getting-started-with-calendar-ryglvr/).
[^22]: HODO, [Hospital Management Software](https://hodo.in/). Scale and adoption figures are vendor claims.
[^23]: PappyJoe, [product catalogue](https://pappyjoe.com/products/) and [feature FAQ](https://pappyjoe.com/faqs-2/).
[^24]: SoftClinic, [Hospital Management Software](https://www.softclinicsoftware.com/hospital-management-software/) and [product home](https://softclinic.io/). Adoption figures are vendor claims.
[^25]: Clinicia, [feature catalogue](https://clinicia.com/features/) and [product home](https://www.clinicia.com/).
[^26]: National Informatics Centre, [eHospital and ORS](https://www.nic.gov.in/project/ehospital/), last updated 27 May 2026.
[^27]: Bahmni, [patient registration and document capture](https://www.bahmni.org/registration), [laboratory](https://www.bahmni.org/laboratory/), and [documentation](https://bahmni.github.io/content/documentation.html).
[^28]: OpenMRS, [product and feature catalogue](https://openmrs.org/product/).
[^29]: OpenEMR Foundation, [OpenEMR product and features](https://www.open-emr.org/).
[^30]: Current repository, [documentation map](../README.md) and [schema/type reference](../SCHEMA_AND_TYPES.md).
[^31]: Current repository, [implemented UI/UX workflow plan](../UI_UX_PLAN.md).
[^32]: Current repository, [owner policy register](../OWNER_POLICY_REGISTER.md).
[^33]: Current repository, [navigation definition](../../components/navigation.ts).
[^34]: Press Information Bureau, Ministry of Health and Family Welfare, [“Update on the implementation of Ayushman Bharat Digital Mission,” 11 February 2025](https://www.pib.gov.in/PressReleaseIframePage.aspx?PRID=2101737&lang=2&reg=3).
[^35]: Capterra, [MocDoc HMS reviews](https://www.capterra.com/p/161290/MocDoc-HMS/) and [MocDoc LIMS reviews](https://www.capterra.com/p/188380/MocDoc-LIMS/reviews/). Small, self-selected samples.
[^36]: G2, [MocDoc HMS reviews](https://www.g2.com/products/mocdoc-hms/reviews). Small, self-selected sample.
[^37]: Google Play, [HealthPlix patient app](https://play.google.com/store/apps/details?id=com.healthplix.patient). Individual patient-app reviews, not a clinician-EMR evaluation.
[^38]: Odoo, [Reordering rules](https://www.odoo.com/documentation/16.0/applications/inventory_and_mrp/inventory/warehouses_storage/replenishment/reordering_rules.html). The documented manual replenishment report includes forecast stock, lead-time timing, arrival information, minimum/maximum quantities, order multiples, and an explicit user order action; Odoo also offers automatic triggers, which this report does not recommend for the clinic.
[^39]: Odoo, [Lead times](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/warehouses_storage/replenishment/lead_times.html). Vendor lead time is defined from PO confirmation to receipt and can vary by vendor/product relationship.
[^40]: Odoo, [Requests for quotation](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/purchase/manage_deals/rfq.html) and [Import vendor pricelist](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/purchase/products/pricelist.html). The documented vendor data includes product code, quantity/minimum, price, discount, and delivery lead time, and can prefill purchasing documents.
[^41]: Zoho Inventory, [item management and reorder actions](https://www.zoho.com/us/inventory/help/items/item-managing.html) and [preferred vendors for reorders](https://www.zoho.com/us/inventory/kb/items/item-preferred-vendor.html).
[^42]: Zoho Inventory, [Purchase Receives](https://www.zoho.com/us/inventory/help/purchase-orders/purchase-receive.html). The documented receive flow starts from a PO, accepts partial quantities, supports item scanning and batch capture, and can later populate a vendor bill.
[^43]: GS1, [GS1 DataMatrix Guideline](https://ref.gs1.org/guidelines/datamatrix/). The healthcare guidance describes GTIN with batch/lot and expiry data for traceability; not every retail barcode carries these attributes.
[^44]: World Health Organization, [Procurement, supply chain and inventory management](https://www.who.int/tools/quality-management-system-for-non-laboratory-settings/pillar-3--procurement-supply-chain-and-inventory-management) and [Standard operating procedures](https://iris.who.int/bitstream/handle/10665/360835/9789240049581-eng.pdf?sequence=1). The guidance covers usage-based forecasting, buffer/alert stock, timely ordering, expiry monitoring, stock records, and FEFO.
[^45]: Microsoft, [Cycle counting in Dynamics 365 Supply Chain Management](https://learn.microsoft.com/en-us/dynamics365/supply-chain/warehousing/cycle-counting). The enterprise implementation is larger than this clinic needs, but its bounded item/location counts, mobile entry, non-blocking outbound stock, and variance resolution are relevant patterns.
