# Clinic platform — build plan

**Status: DRAFT. Not approved. No code until the sign-off box at §18 is filled.**

One doctor, one clinic, one in-house pharmacy. A paying client with a real
shelf, real patients and a real drug licence — so this is not the hospital
prototype with features deleted. It is a smaller surface built deeper.

Read §1–§4 to decide whether the shape is right. §5–§14 are the build. §15–§18
are what has to be true before anyone starts.

---

## 1. What he asked for, in his words

| # | His words | What that means here |
|---|---|---|
| 1 | "connection between the doctor room and pharmacy" | Prescription signed in the consult room appears at the counter in under a second, on a second device. Two-way — the counter can push back "out of stock", the doctor answers without leaving his chair. §11 |
| 2 | "inventory management of the medicines" | Real inventory: drug catalogue, suppliers, batch + expiry, stock in as well as out, stock-take, valuation. §12 |
| 3 | "low stock notification" | In-app badge live, one WhatsApp digest a day. Not one message per drug. §12.4 |
| 4 | "auto message send to supplier in whatsapp placing the order" | System drafts the purchase order automatically, grouped per supplier. Sending is **one tap by a human**, not unattended. Read §10.4 before agreeing otherwise — this is the one requirement I am pushing back on. |
| 5 | "patients whatsapp … know if the doctor is available or not" | Presence derived from his logged-in device, with a heartbeat and an expiry, shown as *"in clinic, as of 2 min ago"* — never as a promise. §13 |
| 6 | "as usual the appointment booking and prescription checking and other things patients can see" | WhatsApp booking → token → queue position → prescription → bill → visit history, on a link. §14 |

Everything in that table is in v1. Nothing outside it is.

---

## 2. Scope

| In v1 | Out of v1 (v2 candidates) | Never |
|---|---|---|
| Patient registry, phone-keyed, families on one number | Online payment / UPI collection | Beds, wards, admissions, discharge |
| Appointments, tokens, queue | Lab module (order → result → release) | Any second doctor's independent practice |
| Consult form, diagnosis, prescription | Document upload (external lab PDFs, scans) | Teleconsultation / video |
| Prescription → counter, live | Certificates (fitness, sick leave) | Symptom checker, diagnosis suggestion, dose suggestion (§15.3) |
| Dispense, partial dispense, substitution | Accounting export (Tally) | Patient-facing medicine ordering / delivery |
| Counter sale (OTC, no prescription) | Multi-branch | Selling or sharing patient data |
| Drug catalogue, suppliers, batches, expiry, FEFO | Loyalty / recall campaigns / marketing blasts | ABDM / ABHA linkage (until he asks and pays) |
| Goods receipt, purchase orders, stock-take | Staff attendance / payroll | |
| Low-stock + expiry alerts, supplier PO over WhatsApp | Insurance / TPA claims | |
| Billing: consult fee + medicines, GST-ready, printed | | |
| Patient WhatsApp: booking, token, Rx link, bill link, reminders | | |
| Doctor presence + public clinic status page | | |
| Schedule H1 register, daily sales, stock valuation reports | | |
| Audit log on every write | | |

**Change control:** anything not in the left column is a written change request,
quoted separately, scheduled after go-live. Agree this with him *before* he
starts adding to it — he will, and that is normal.

---

## 3. Assumptions — confirm before build

Each of these changes the work if wrong. Get answers in writing.

| # | Assumption | If wrong |
|---|---|---|
| A1 | India. DPDP Act 2023, Drugs & Cosmetics Act, CDSCO, GST. | Whole of §15 is rewritten |
| A2 | The clinic holds a **retail drug licence** and either a registered pharmacist or a valid dispensing-doctor exemption for its state | If not, the pharmacy module cannot legally sell — it becomes stock tracking for his own dispensing only, and counter sale is dropped |
| A3 | At least one non-doctor staff member sits at the counter | If he is genuinely alone, the counter and consult windows merge into one screen and M2 shrinks by ~2 days but the "connection" requirement partly evaporates — clarify |
| A4 | ≤ 100 patients/day, ≤ 5 concurrent devices | None. Load is trivial at any plausible number for one clinic |
| A5 | Reliable-enough clinic internet, or willing to add a 4G backup on the router | Architecture changes to LAN-first, +8 days. See §5.2 |
| A6 | He will buy a WhatsApp Business Platform number in the clinic's name and pay Meta's per-message fees | No supplier automation, no patient push. The product still works; the two headline features do not |
| A7 | He accepts a printed prescription signed by hand as the legal document; the app's copy is a convenience | Digital signature / e-sign integration, +3 days |
| A8 | He personally signs off the drug list, dose schedules, consult form fields and prescription layout | Build stops. Nothing clinical ships unreviewed — §15.3 |

**A8 is the one that changes everything for the better.** The prototype was
built with no clinician to check it, which is why it refuses to infer anything.
He *is* the clinician. Get his sign-off in writing on each clinical artefact and
that constraint lifts for this build.

---

## 4. What is different from the demo he saw

Set this expectation early. He bought the *feel* of the demo, not its contents.

| Demo | This build |
|---|---|
| One browser, localStorage, no server | Postgres, two-plus devices, live sync |
| Nothing leaves the browser; WhatsApp is drawn | Real Meta Cloud API, real templates, real cost per message |
| 10 department packs, wards, nurses, labs | One general-practice pack, no wards |
| Stock only ever goes down, one batch per drug | Full ledger: receipts, returns, adjustments, multi-batch FEFO |
| "Reorder" is a badge | Reorder is a purchase order with a supplier and a state machine |
| Fake patients, seeded, resettable | Real patients, backed up, deletable on request under DPDP |
| No auth | Real auth, per-role, audited |

Roughly 40% of the prototype's code ports across; the rest is new. Detail in §6.

---

## 5. Architecture — locked

### 5.1 Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 16 + React 19 + TypeScript + Tailwind 4 | Same as prototype; the ported code compiles unchanged |
| DB | Postgres via **Supabase, ap-south-1 (Mumbai)** | Data residency for DPDP. Realtime is what makes §11 work. Auth + Storage included |
| Live sync | Supabase Realtime on `prescriptions`, `presence`, `appointments` | The doctor↔counter link is a subscription, not polling |
| Auth | Supabase Auth, email+password, per-staff | Small user count; no SSO complexity |
| Hosting | Vercel Pro | Zero-ops deploys, preview envs, rollback in one click |
| WhatsApp | **Meta Cloud API, direct**, on the clinic's own Meta Business account | No BSP monthly fee, no third party holding patient phone numbers, client owns the asset |
| Errors | Sentry | You will not be sitting in the clinic when it breaks |
| Tests | Vitest (unit) + Playwright (E2E) | Replaces the prototype's bespoke `loop-test.js` |

**Rejected:** BSP aggregators (WATI/AiSensy/Interakt) — ₹2–5k/month forever, and
patient numbers sit in a third party's database, which is a DPDP problem you
would own. Revisit only if Cloud API onboarding stalls. **Rejected:** on-premise
server in the clinic — patient WhatsApp needs the internet anyway, so an
on-prem box buys nothing and makes backups, hardware failure and remote support
your problem.

### 5.2 The internet question

Cloud is right *because* the patient-facing half is useless offline. But the
consult room must not stop when the line drops.

| Failure | Behaviour |
|---|---|
| Internet down, ≤ 15 min | Doctor keeps consulting. Writes queue in the browser (IndexedDB), flush on reconnect. Counter shows last-known stock with a stale banner |
| Internet down, longer | Fall back to paper prescriptions; a "backfill" screen enters them afterwards |
| Supabase down | Same as above. Status page + Sentry alert to you |

Non-negotiable mitigation: **a 4G backup on the clinic router** (~₹300/month).
Put it in the proposal as a client-supplied prerequisite, not an optional extra.

### 5.3 The rules that hold it together

Eight. Each is enforced by a test, not by discipline.

| # | Rule | Broken means |
|---|---|---|
| 1 | **One seam** — only `lib/db/*` talks to Supabase | a component runs a query with no RLS, no audit, no transaction |
| 2 | **One writer** — every state change is one function in `lib/transitions/*`, in a DB transaction, writing its audit row in the same transaction | a change happens that nobody can explain three months later |
| 3 | **Stock is a ledger** — `stock_movements` is the truth. `qty_on_hand` is a cache updated in the same transaction; a nightly job asserts they agree and alerts on drift | the shelf and the screen disagree and nobody knows when they started to |
| 4 | **Money and stock never move unattended** — no cron, no webhook, no auto-rule writes a sale, a dispense or a purchase order send | one bad reorder level orders ten times the stock and he pays for it |
| 5 | **Every send is a row before it is a send** — WhatsApp messages are persisted with an idempotency key, then dispatched; retries are safe | a webhook retry sends the same order to the supplier twice |
| 6 | **Presence is never a promise** — always rendered with an "as of" time; expires without a heartbeat | a patient drives 20 km to a locked door and blames the app |
| 7 | **Patient surfaces default-deny** — `findings` and `notes` never leave; a grep test enforces it across `app/p/**` | clinician shorthand, written for himself, is read by the person it is about |
| 8 | **Nothing clinical is inferred** — no computed high/low, no suggested dose, no suggested diagnosis. Only what a human entered | §15.3 |

Rules 1, 2, 7 and 8 are carried from the prototype, where they were earned.
Rules 3, 4, 5, 6 are new and exist because this build touches money, stock and a
third party.

---

## 6. What ports from the prototype

| Port as-is | Port and rework | Build new |
|---|---|---|
| `lib/types.ts` shape conventions | `lib/store.ts` → `lib/db/*` (Supabase) | Everything in §12 (inventory, suppliers, purchasing) |
| `lib/ids.ts`, `nowIso()` discipline | `lib/session.ts` → Supabase Auth | Everything in §10 (real WhatsApp) |
| `lib/reminders.ts` (dose schedule engine) | `lib/transitions.ts` → per-domain, transactional | §13 presence |
| `components/ConsultForm`, `consultCore`, `DiagnosisPicker`, `TemplateForm` | `RxComposer` + **live stock badge** (§11.2) | Counter-sale, GRN, stock-take, PO screens |
| `components/RxComposer` core | `DispenseForm` → batch-aware, partial, substitution | Reports / registers (§15.2) |
| `app/p/*` portal screens | `lib/queries.ts` → SQL views | Audit log, backups, monitoring |
| `lib/billing.ts` | Pharmacy screen → live queue | Offline write queue |

Discarded: wards, beds, admissions, `medAdmins`, ward-round, nurse window, lab
window, referrals, 9 of 10 department packs, the demo clock, `PhoneFrame`.

**Port by copying into the new repo module by module. Do not fork the old repo
and delete.** Deleting leaves half-removed ward logic behind; copying forces
every line to be looked at once.

---

## 7. Data model

Postgres. All tables have `id uuid`, `created_at`, `updated_at`. RLS on every
table. `_` = new vs prototype.

### Clinic core

```
clinic          name, address, phone, doctor_reg_no, drug_licence_no, gstin,
                open_hours jsonb, timezone
staff           name, role: doctor|counter|admin, reg_no?, phone, auth_user_id, active
patients        name, phone, dob?, age?, sex, address?, allergies?, notes?,
_               phone_is_shared bool          -- families on one number
appointments    patient_id, date, token_no, status: booked|waiting|in_consult|done|no_show,
_               source: walkin|whatsapp|phone, reason?, follows_encounter_id?
encounters      patient_id, doctor_id, appointment_id?, findings jsonb,
                diagnoses jsonb, advice?, follow_up_date?, notes?
prescriptions   encounter_id, patient_id, doctor_id, items jsonb, signed_at,
_               status: pending|partial|dispensed|cancelled
_               -- items[]: drug_id, name, strength, dose, freq, days, food, schedule[], qty
vitals          patient_id, encounter_id?, bp, pulse, temp, spo2, weight, height,
                recorded_by, recorded_at
```

### Pharmacy — the new half

```
_ suppliers        name, contact_name, whatsapp_number, phone, email?, gstin?,
                   lead_time_days, payment_terms?, active
_ drugs            name, generic, strength, form, unit, pack_size,
                   schedule: OTC|H|H1|X, hsn?, default_supplier_id?,
                   reorder_level, reorder_qty, active
_ stock_batches    drug_id, batch_no, expiry, qty_received, qty_on_hand,
                   cost_price, mrp, supplier_id?, grn_id?, received_at
_ stock_movements  drug_id, batch_id, qty (+/-), type: receipt|dispense|sale|
                   return_in|return_out|adjust|writeoff_expiry,
                   ref_type, ref_id, staff_id, at, note?
_ purchase_orders  supplier_id, status: draft|sent|acknowledged|partial|received|cancelled,
                   sent_at?, wa_message_id?, ack_at?, created_by, total?
_ po_lines         po_id, drug_id, qty_ordered, qty_received, unit_cost?
_ goods_receipts   po_id?, supplier_id, invoice_no, invoice_date, received_by, total
_ grn_lines        grn_id, drug_id, batch_no, expiry, qty, free_qty?, cost_price, mrp
  dispenses        prescription_id?, patient_id?, staff_id, at, bill_id?
_ dispense_lines   dispense_id, drug_id, batch_id, qty, unit_price, amount
_ stock_takes      counted_by, at, status, note?
_ stock_take_lines take_id, batch_id, counted_qty, system_qty, variance
  bills            patient_id?, encounter_id?, consult_fee, medicines_total,
                   discount, tax jsonb, total, status, paid_at?, method
```

`stock_batches` separate from `drugs` is the fix for the prototype's worst gap —
one row was drug *and* batch, so a real shelf holding two expiries could not be
represented. FEFO (first-expiry-first-out) allocation is a query over batches.

### Messaging

```
_ wa_contacts   phone, patient_id?, supplier_id?, opt_in_at?, opt_in_source,
                opt_out_at?, last_inbound_at        -- last_inbound_at = the 24h window
_ wa_messages   to_number, direction, template_code?, body, params jsonb,
                status: queued|sent|delivered|read|failed, wa_message_id?,
                error?, ref_type?, ref_id?, idempotency_key UNIQUE, cost?
_ wa_inbound    raw jsonb, received_at, processed_at?   -- keep raw, always
_ wa_sessions   phone, flow_state jsonb, expires_at    -- the booking conversation
```

### Presence and audit

```
_ devices         staff_id, label, device_token, is_clinic_device, registered_at
_ presence        staff_id UNIQUE, status: in_clinic|in_consult|break|away,
                  source: auto|manual, last_heartbeat_at, break_until?, note?
_ clinic_closures date, reason, all_day, from_time?, to_time?
_ audit_log       actor_staff_id?, actor_type, action, entity, entity_id,
                  before jsonb, after jsonb, at, ip?
```

---

## 8. Build order

Days = focused working days for one developer. Calendar is longer — see §9.

| # | Module | Days | Done when |
|---|---|---|---|
| **M0** | Foundations: repo, Next 16, Supabase project, schema + migrations, RLS, auth, audit log, `lib/db` seam, CI, staging + prod deploys | 5 | A staff member logs in on staging, a row written from the UI appears in `audit_log`, and CI blocks a merge that fails typecheck or tests |
| **M1** | Clinic core: patients, appointments, tokens, queue, consult form, diagnosis, Rx composer, prescription print | 4 | Doctor registers a walk-in, consults, signs an Rx, prints it on the clinic's printer |
| **M2** | **Doctor ↔ counter live link** (§11) | 4 | Rx signed on device A is on device B in < 1s; counter raises "out of stock", doctor sees it and substitutes without leaving the consult screen |
| **M3** | Inventory: drugs, suppliers, batches, movements ledger, GRN, FEFO dispense, partial dispense, counter sale, stock-take, expiry block | 6 | Two batches of one drug with different expiries; dispensing takes the earlier; an expired batch is refused; ledger and `qty_on_hand` reconcile |
| **M4** | Billing: consult fee + medicines, discount, GST, print, day-book | 3 | A bill prints correctly for a consult + 4 medicines across 2 batches, and the day's total matches the sum of its bills |
| **M5** | Purchasing + supplier WhatsApp (§10.4, §12.5) | 4 | Low stock drafts one PO per supplier; approve sends a template message; supplier's reply is captured; goods received against the PO create batches |
| **M6** | Presence + public status page (§13) | 2 | Doctor logs in → status live in 30s. Laptop shut → "away" within 5 min. Closing time → "closed" regardless of session |
| **M7** | Patient WhatsApp + portal (§14) | 7 | A real phone books an appointment, gets a token, opens the queue page, gets an "Rx ready" message, opens the prescription |
| **M8** | Reports and registers: Schedule H1 register, daily sales, stock valuation, expiry, purchase register (§15.2) | 3 | H1 register exports for a date range in a form an inspector accepts |
| **M9** | Hardening: E2E suite, offline write queue, backups + **tested restore**, monitoring, error states, permissions review, load of real data | 5 | Restore drill completes from a backup into a scratch project with zero data loss; Playwright covers the six critical paths |
| **M10** | Training, parallel run, go-live | 3 + 2 weeks calendar | §16 |

**Build total: 46 working days.** Add the calendar dependencies in §9.

M0 → M1 → M2 → M3 are strictly sequential. M4–M8 can reorder. M7 cannot start
until the WhatsApp number is verified (§9), which is why the paperwork starts on
day 1.

---

## 9. Calendar — the long pole is paperwork, not code

Start these on **day 1, before the first commit**:

| Task | Owner | Lead time |
|---|---|---|
| Meta Business Account + **business verification** (needs GST cert / incorporation docs / utility bill) | Client, you assist | **3 days – 3 weeks**, unpredictable |
| **Published privacy policy at a public URL** — mandatory since Jan 2026 before any template can send | You draft, client publishes | 1 day |
| Dedicated phone number for WhatsApp Business Platform — must **not** be on the WhatsApp or WhatsApp Business app | Client | 1 day (new SIM) |
| Display-name approval | Client | 1–3 days |
| Message template submission and approval | You | Hours – 2 days each, rejections common |
| Domain + DNS for the portal | Client | 1 day |
| Drug master list with pack sizes, suppliers, MRPs | Client | **1–2 weeks of his time** — the real bottleneck |
| Opening stock count | Client + you | 1 day, done in one sitting, clinic closed |

**Realistic calendar: 10–12 weeks from signature to go-live**, of which ~9 weeks
is build and the rest is verification, data preparation and the parallel run.
Quote 12 weeks. Do not quote 6.

---

## 10. WhatsApp — the part that can sink this

> Full treatment in [`WHATSAPP.md`](WHATSAPP.md) — the six distinct grey areas,
> how to spot an unofficial vendor, and every message in this build classified
> by category, opt-in status and risk. Read it before answering §18 Q5.

### 10.1 What Meta actually allows

| Reality | Consequence for the design |
|---|---|
| A business cannot start a conversation with free text. Business-initiated messages must use a **pre-approved template** | Every outbound message is designed and approved in advance. No dynamic prose |
| A **24-hour service window** opens when the user messages first; inside it, free-form replies are free | The booking conversation is free. Push notifications are not |
| Templates are categorised **utility / authentication / marketing**, priced differently — marketing is ~6× utility in India | Every template must qualify as utility. One marketing-flavoured word and the cost multiplies |
| Users can block or report. Enough reports drop the number's quality rating and Meta throttles or bans it | The number is a single point of failure for the whole product |
| Opt-in is required and must be recorded | `wa_contacts.opt_in_at` + `opt_in_source`. No opt-in, no send. Enforced in the send function, not the UI |

**Pricing: verify against Meta's current India rate card before quoting.** Rates
have changed twice in two years. Indicative order of magnitude at time of
writing: utility ~₹0.12/message, marketing ~₹0.78/message, service messages
free. Build the cost estimate in §17 from the live card, not from this line.

### 10.2 The cost trap: medication reminders

Naive design: one message per dose. A 5-day course at three doses a day is **15
messages per prescription**. At 40 prescriptions a day that is 18,000
messages/month — around ₹2,200/month, more than the hosting.

| Option | Cost/month (40 Rx/day) | Recommendation |
|---|---|---|
| Per-dose push | ~₹2,200 | No |
| **One daily digest — "today's doses", opt-in per prescription** | ~₹150 | **Yes, default** |
| Portal only, no push | ₹0 | Offer as the off switch |

Make it a clinic setting so he can turn it off when he sees the bill.

### 10.3 Templates to build (v1)

| Code | Category | Trigger | Body shape |
|---|---|---|---|
| `appt_confirmed` | utility | booking accepted | "Booked — {{date}}, token {{token}}. Track your turn: {{link}}" |
| `turn_near` | utility | 2 ahead in queue | "You're next but one. {{link}}" |
| `rx_ready` | utility | prescription signed | "Your prescription from Dr {{name}} is ready. {{link}}" |
| `bill_ready` | utility | bill generated | "Your bill for {{date}} — ₹{{amount}}. {{link}}" |
| `dose_digest` | utility | daily, opt-in | "Today's medicines: {{summary}}. Details: {{link}}" |
| `clinic_closed` | utility | unplanned closure | "The clinic is closed today ({{reason}}). Your appointment will be rebooked." |
| `po_to_supplier` | utility | PO approved | "Order from {{clinic}}: {{lines}}. Confirm on this chat." |
| `low_stock_digest` | utility | daily, to staff | "{{n}} medicines at or below reorder level. {{link}}" |

Carried from the prototype and non-negotiable: **a message never carries the
record, only the fact that it exists plus a link.** It keeps every template in
the cheap utility band and keeps a prescription out of a forwardable chat log.

### 10.4 Supplier auto-send — my pushback

He asked for automatic ordering. Three problems:

| Problem | Detail |
|---|---|
| **Opt-in** | Meta requires the recipient to have opted in. A supplier will not fill in a consent form. If he reports the message, the clinic's number takes the hit — the same number the patients use |
| **Money** | An unattended order is a financial commitment to a third party. One wrong reorder level and he has paid for ten times the stock. Rule 4 in §5.3 exists for this |
| **Pack sizes** | Reorder quantity in strips vs boxes vs the supplier's minimum order is a human judgement the first few months |

**Recommended design — he still gets "automatic", one tap short of it:**

1. Nightly job detects low stock, drafts one PO per supplier, ranked by urgency.
2. 8am: one WhatsApp digest to him — *"3 orders ready for approval"* + link.
3. He opens it, edits quantities if needed, taps **Send**.
4. Message goes out; PO moves to `sent`; supplier's reply lands in the app.

Cost of the tap: about four seconds a day. What it buys: he never wakes up to an
order he did not want, and the clinic's WhatsApp number is not risked on
unconsented business messaging.

**Two escape hatches if he insists on true unattended send:**

- **Separate number** for supplier traffic, so a block cannot take patients down
  with it. ~₹200/month + a second verification. Worth it regardless.
- **Deep-link mode**: the app composes the order and opens `wa.me` on his own
  phone with the text pre-filled — he taps send from his personal WhatsApp. Zero
  Meta cost, zero policy risk, and it is what small clinics already do. Slightly
  less impressive in a demo, entirely safe in practice.

If he still wants unattended after reading this: put it behind a per-supplier
flag, a hard monetary cap per order, a daily cap, and a 30-minute cancel window.
Get the choice in writing.

---

## 11. Doctor room ↔ pharmacy — his headline feature

### 11.1 The live link

```
consult room                          counter
────────────                          ───────
doctor signs Rx  ──── realtime ────►  appears at top of queue, < 1s
                                      stock checked live per line
                                      dispense: FEFO batch picked
                                      partial? substitution? ──┐
     ◄──────────── realtime ──────────────────────────────────┘
notification on the consult screen:
"Counter: Amoxicillin 500 out of stock. Substitute?"
doctor approves / edits / rejects ──► counter continues
```

Implemented as Supabase Realtime subscriptions on `prescriptions` and a
`counter_queries` table. No polling. The whole loop is two tables and four
transitions.

### 11.2 The feature that will sell it

**Live stock badge inside the prescription composer.** While he types a drug
name, the row shows `18 in stock · exp 03/2027` or `OUT — 2 alternatives`. He
stops prescribing what is not on his own shelf.

Cheap once inventory is live (M3), enormous perceived value, and it is the
single best argument for buying the two modules together. Build it in M2, wire
the real numbers in M3.

### 11.3 What dispense refuses

Carried from the prototype and extended. **Validate everything before moving
anything** — a prescription is handed over whole, so one short line leaves the
shelf untouched.

| Check | Refusal |
|---|---|
| prescription exists and is not cancelled | *No prescription with that number.* |
| not already fully dispensed | *Already dispensed at 11:42 by Suresh.* |
| drug is in the catalogue | *X is not stocked here.* |
| a non-expired batch exists | *X batch B expired Mar 2026. Remove it from the shelf.* |
| enough stock across valid batches | *Only 6 units of X across all batches.* |
| Schedule H/H1 → prescription mandatory, prescriber recorded | *X is Schedule H1 — it cannot be sold on a counter sale.* |
| same drug on two lines collapses to one quantity | (silent; a defect found twice in the prototype) |

---

## 12. Inventory and purchasing

### 12.1 The ledger

`stock_movements` is append-only and is the truth. Nothing edits it; a mistake
is corrected by a compensating `adjust` row with a reason. `qty_on_hand` on the
batch is a cache updated in the same transaction, and a nightly job asserts

```
batch.qty_on_hand == SUM(movements.qty WHERE batch_id = batch.id)
```

Any drift alerts you before it alerts him. This is how a stock figure earns the
right to be trusted.

### 12.2 FEFO

Dispensing allocates from the **earliest-expiring non-expired batch first**,
splitting across batches when one is short, and records which batch each unit
came from. Batch traceability is what makes a manufacturer recall answerable.

### 12.3 The three sets, kept apart

Conflating them let expired stock over the counter in the prototype.

| Set | Means | Consequence |
|---|---|---|
| `low_stock` | on-hand ≤ reorder level | a purchasing signal |
| `expiring_soon` | not expired, within 90 days | use it or plan to lose it — return-to-supplier window |
| `expired` | expiry < today | **cannot be dispensed at all**, and is excluded from on-hand |

`expiring_soon` excludes `expired`. Expiries render as **`Mar 2027`** — month
and year, as printed on the strip.

### 12.4 Low-stock alerting

| Channel | When | Why |
|---|---|---|
| In-app badge + list | live | the counter is looking at the screen anyway |
| WhatsApp digest to staff | once daily, 08:00 | one message, not one per drug |
| Escalation | still low after 3 days | it was seen and ignored |

Reorder level is manual at go-live. After 60 days of movement data, offer a
*suggested* level from `avg daily use × supplier lead time × 1.5` — suggested,
never applied automatically (rule 4).

### 12.5 Purchase order lifecycle

```
draft ──approve+send──► sent ──supplier replies──► acknowledged
                          │                            │
                          └──goods arrive──► partial ──► received
                                   (GRN creates batches, stock rises)
```

Cancellation allowed from `draft`, `sent`, `acknowledged`. A GRN can exist
without a PO (walk-in purchase) — that path must work, because it is how small
clinics actually buy half their stock.

---

## 13. Doctor presence

### 13.1 Why "logged in = he is there" is not enough

| Failure | Frequency | Result if unhandled |
|---|---|---|
| Forgets to log out, goes home | daily | Patients told he is in. He is not. This is the failure that gets the app blamed |
| Logs in from home to check something | weekly | Same |
| Laptop sleeps mid-session | daily | Ambiguous |
| Steps out for lunch / a home visit | daily | Status says "in clinic" |

### 13.2 The design

| Mechanism | Detail |
|---|---|
| **Heartbeat** | Logged-in device pings every 30s. No ping for 5 min → `away`, automatically |
| **Device registration** | Only devices marked `is_clinic_device` can set `in_clinic`. His home laptop logs in fine and sets nothing |
| **Explicit status** | Big control in his window: In clinic · With a patient · Back by HH:MM · Done for the day |
| **Hard close** | At clinic closing time, status → closed regardless of any session |
| **Leaving button** | One tap on the way out. Also on his phone |
| **Wording** | *"Dr {{name}} is in the clinic — as of 2 min ago"*, never *"available"*. A stale reading must not read as a promise (rule 6) |

### 13.3 How patients see it

**Pull, not push.** A permanent link — `clinic.example/now` — always current,
costs nothing, and can be pinned in the WhatsApp business profile, printed on
the card and stuck on the door as a QR code.

Push only for the exception: `clinic_closed` when he is unexpectedly out and
patients have appointments today. That is worth a message. "Doctor has arrived"
is not, and broadcasting it to a patient list is marketing-category traffic that
gets a number reported.

---

## 14. What patients get

| Surface | Content |
|---|---|
| WhatsApp — quick replies, no free text | Book · My token · My prescription · My bill · Is the doctor in? |
| `/now` | Clinic status, doctor status with an "as of", today's queue length, open hours |
| `/p` | Next appointment, token, **"3 ahead of you"**, cards for prescriptions, bills, visits |
| `/p/rx/[id]` | Full e-prescription, clinic header, doctor name + reg number, print CSS |
| `/p/bills/[id]` | Itemised bill, paid/unpaid, print CSS |
| `/p/visits`, `/p/visits/[id]` | Date, diagnosis label, advice, follow-up date, what was prescribed |

**Default deny.** `findings`, `notes` and diagnosis ICD codes never reach a
patient surface — enforced by a source-level test across `app/p/**`, because
nothing at runtime stops an import and by render time it is too late.

**Identity:** phone possession, proven by WhatsApp. A signed link, 24h expiry,
single-use, exchanged for a 30-day cookie. Clinical routes (`/p/rx`, `/p/visits`)
sit behind a one-time date-of-birth confirmation per device, so a forwarded link
leaks "you have an appointment", not a diagnosis.

**Families on one number:** if the phone maps to more than one patient, the
WhatsApp flow asks which one and the portal shows a switcher. The prototype
deferred this; a real clinic hits it in week one.

---

## 15. Compliance

Assumes India (A1). **Have a lawyer review the DPA and the client contract — the
notes below are engineering requirements, not legal advice.**

### 15.1 DPDP Act 2023

| Requirement | Implementation |
|---|---|
| Clinic is Data Fiduciary; you are Data Processor | Written **Data Processing Agreement**, signed, before any real patient data is loaded |
| Consent, purpose-limited | Consent captured at registration and at WhatsApp opt-in, timestamped and stored, revocable |
| Right to erasure / correction | Staff screen to export and to delete a patient; deletion soft-deletes clinical records (retention law wins) and hard-deletes contact and messaging data |
| Breach notification | Documented procedure, your contact details, Sentry alerting |
| Data residency | Supabase ap-south-1 |
| Minimisation | No data to any third party. This is why §5.1 rejects BSP aggregators |

### 15.2 Drugs & Cosmetics Act — registers that must exist

| Register | Why | Where |
|---|---|---|
| **Schedule H1 register** | Legally required for H1 sales: date, patient name and address, drug, quantity, prescriber name. Retain 3 years | Derived view, exportable to PDF/Excel by date range |
| Purchase register / invoices | Inspection, and recall traceability | GRN + supplier invoice number |
| Batch traceability | Recall | Every dispense line carries `batch_id` |
| Expiry write-off record | Disposal audit | `writeoff_expiry` movements |

If A2 is false, drop counter sale and Schedule H/H1 selling entirely; the module
becomes stock control for his own dispensing.

### 15.3 Clinical safety

Carried verbatim from the prototype and it does not soften for a paying client:

- No diagnosis suggestion, ever. Suggesting a diagnosis from symptoms engages
  CDSCO software-as-a-medical-device rules and clinical liability, and it must
  not arrive by accident as an "autocomplete improvement".
- No inferred dose schedule. A reminder repeats only a schedule the doctor
  ticked. An unticked medicine stays silent.
- No computed abnormal flags on any value. Ranges are stored as printed;
  nothing compares them.
- Drug interaction checking is **out of scope**. If he asks for it — and he
  might — it is a licensed clinical database (and its annual fee), not a
  feature. Quote it separately or decline it.
- **He signs off** the drug list, dose slot times, consult form fields and the
  prescription layout, in writing, before go-live (A8).

---

## 16. "No room for error" — what that actually costs

He is right to demand it. Here is the concrete regime, and it is why M9 and M10
are 8 days and not 2.

| Control | Detail |
|---|---|
| **Transactions** | Every dispense, sale, GRN and PO write is one DB transaction. A partial write is impossible, not unlikely |
| **Audit log** | Actor, action, before, after, timestamp, on every write. Same transaction as the write |
| **Tests** | Vitest on every transition and every refusal in §11.3. Playwright on six paths: register→consult→Rx→dispense→bill; low stock→PO→send→GRN; WhatsApp booking→token→queue; presence on/off/expire; H1 register export; offline write and reflush |
| **Source invariants** | Grep tests: nothing under `app/p/**` imports `findings`; no component imports the Supabase client directly; every timestamp helper is the local-wall-clock one |
| **Staging** | A full second environment with his real drug list and **fake patients**. Every change goes there first |
| **Backups** | Supabase daily PITR **plus** a nightly logical dump to separate storage. An untested backup is not a backup — the restore drill in M9 is a deliverable, run again quarterly |
| **Monitoring** | Sentry for errors, uptime check on `/now`, a daily reconcile job (§12.1) that alerts on stock drift |
| **Rollback** | Vercel instant rollback; migrations are forward-only with a written down-path for each |
| **Parallel run** | **Two weeks running alongside paper before cutover.** Non-negotiable. It is the only way to find what he does that neither of us thought to ask about |
| **Change freeze** | No feature changes during the parallel run. Bugs only |

### Go-live sequence

| Step | |
|---|---|
| 1 | Load drug master, suppliers, opening stock (clinic closed, one day) |
| 2 | Week 1 parallel: pharmacy only. Paper prescriptions, but every dispense entered. Reconcile stock nightly against the shelf |
| 3 | Week 2 parallel: full loop, still printing on his existing pad as backup |
| 4 | Patient WhatsApp switched on for a **pilot list of ~20 regulars first**, not the whole book |
| 5 | Cutover. You are physically present in the clinic on day 1 and reachable on day 2 |
| 6 | 30-day warranty, then a support agreement |

---

## 17. Costs

### One-time (client)

Build fee — yours to set. Anchors: 46 build days plus ~15 days of setup,
training, data loading and support. Price the whole thing, not the days, and
price the parallel run in.

### Running (client pays vendors directly wherever possible — do not front these)

| Item | Indicative ₹/month | Note |
|---|---|---|
| Supabase Pro | ~2,100 | Free tier has no PITR and pauses. Not acceptable for a clinic |
| Vercel Pro | ~1,700 | Commercial use requires it |
| Domain | ~100 | |
| WhatsApp messages | 300–800 | With the daily-digest design in §10.2. Per-dose pushes would be ~₹2,200 |
| 4G router backup | ~300 | Prerequisite, not optional (§5.2) |
| Second WhatsApp number (supplier traffic) | ~200 | Recommended (§10.4) |
| Sentry | 0 | Free tier is enough |
| **Total** | **~4,700–5,200** | Plus your support/AMC |

A cheaper path exists — a single ₹1,200/month Mumbai VPS running everything —
and it trades roughly ₹3,000/month for your ops time and a worse outage story.
Not recommended for the first client.

### Client obligations — put these in the contract

Drug master with pack sizes and MRPs · supplier list with WhatsApp numbers ·
opening stock count · Meta business verification documents · a dedicated SIM ·
the 4G backup · clinical sign-off (A8) · a named person available for training ·
payment of vendor bills in his own name.

**Payment structure to propose:** 40% on signature, 30% on M3 acceptance (he
sees the doctor↔pharmacy loop working on real stock), 30% on go-live acceptance.
30-day warranty, then an AMC covering hosting oversight, backups, Meta template
changes and support hours.

---

## 18. Open questions — answer before build

**For the client:**

| # | Question | What it decides |
|---|---|---|
| 1 | Retail drug licence and pharmacist — yes or no? (A2) | Whether counter sale and H1 selling exist at all |
| 2 | Who sits at the counter? Anyone besides him? (A3) | Whether M2 is two windows or one |
| 3 | Does the pharmacy serve walk-ins without a prescription? | Counter-sale module, ~2 days |
| 4 | GST registered? Invoice format required? | Bill layout and tax handling |
| 5 | Supplier ordering: one-tap approve, or true unattended? (§10.4) | Compliance exposure and which number is at risk |
| 6 | How many suppliers, and are they on WhatsApp? | Whether M5 is worth building at all |
| 7 | Patients/day, and how many have smartphones with data? | Whether the portal or the WhatsApp text carries the weight |
| 8 | Existing software? Any data to migrate? | Migration is unscoped and could be days |
| 9 | Printer: A5 laser, thermal, or existing letterhead? | Print CSS is not one-size |
| 10 | Clinic hours, weekly off, how he handles emergencies out of hours | Presence auto-close and the closure flow |
| 11 | Will he accept patients seeing diagnosis labels? | Some doctors will not. Advice-only fallback is a config flag |
| 12 | Who owns the code — assignment or perpetual licence? | Contract, and whether this becomes a product |

**For you:**

| # | Question |
|---|---|
| 13 | Fixed price or time-and-materials? Fixed price with this much unknown is a risk you carry |
| 14 | Are you available in person on go-live day and the week after? If not, don't sign |
| 15 | Is this the first customer of a product, or a one-off? It changes whether the schema is multi-tenant from day 1 (~3 extra days now, weeks later) |

---

## 19. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Meta business verification stalls | Medium | Blocks M5, M7 | Start day 1. Deep-link fallback (§10.4) keeps supplier ordering alive |
| WhatsApp number restricted after supplier messaging | Medium if unattended | Kills patient channel | Separate number; one-tap approval; opt-in enforced in code |
| Drug master never arrives from the client | **High** | Blocks M3, go-live | Make it a payment milestone. Offer to type it from his purchase invoices, billed |
| Scope creep — "can it also do…" | **High** | Slips everything | §2 change control, agreed in writing at signature |
| Opening stock count is wrong | High | Every stock number wrong from day 1 | Stock-take in M3 exists for this. Reconcile nightly during parallel run |
| Clinic internet outage during consult | Medium | Consult stops | Offline write queue + 4G backup (§5.2) |
| He wants interaction checking / diagnosis help | Medium | Regulatory and liability exposure | §15.3. Decline or quote a licensed database separately |
| Fixed price with unknowns 1–12 unanswered | High | You absorb the overrun | Answer §18 before quoting |
| Sole-developer bus factor | Certain | He is running a clinic on it | Documented runbook, client owns credentials, code in a repo he can be given access to |

---

## 20. Sign-off

Nothing gets built until this is filled in.

```
Scope (§2) agreed as written                    [ ]  date ______
Assumptions §3 A1–A8 confirmed                  [ ]  date ______
Open questions §18 1–12 answered                [ ]  date ______
Supplier send mode chosen (§10.4)               [ ]  date ______
Price, milestones and running costs accepted    [ ]  date ______
DPA drafted and reviewed                        [ ]  date ______
Clinical sign-off process agreed (A8)           [ ]  date ______

Client: ____________________  Developer: ____________________
```
