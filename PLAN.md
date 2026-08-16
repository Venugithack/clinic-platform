# Clinic platform — build plan

**Status: DRAFT. Not approved. No code until the sign-off box at §20 is filled.**

One doctor, one clinic, one in-house pharmacy. A paying client with a real
shelf, real patients and a real drug licence — so this is not the hospital
prototype with features deleted. It is a smaller surface built deeper.

Read §1–§4 to decide whether the shape is right. §5–§14 are the build. §15–§18
are what has to be true before anyone starts.

**Updated 16 Aug 2026** with the client's answers to §18 (recorded there) and
three constraints from Venu — host it free, tablets are the devices, inventory
is the centrepiece. Each has its own document: [`HOSTING.md`](HOSTING.md),
[`TABLET.md`](TABLET.md), [`INVENTORY.md`](INVENTORY.md). §5, §12, §17 and §18
below are the sections those changed.

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
| A2 | ✅ **CONFIRMED 16 Aug 2026.** The clinic holds a retail drug licence and employs a registered pharmacist. The pharmacy sells OTC as well as prescription medicines, and bills from the pharmacist's window | — |
| A3 | ✅ **CONFIRMED 16 Aug 2026.** Two screens: the doctor in his cabin, the pharmacist at the counter. The live link in §11 is the real requirement, not a nicety | — |
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

Revised 16 Aug 2026 for the zero-hosting-cost constraint. Full reasoning,
limits, sizing and the migration path in [`HOSTING.md`](HOSTING.md).

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 16 + React 19 + TypeScript + Tailwind 4 | Same as prototype; the ported code compiles unchanged |
| DB | Postgres via **Supabase free, ap-south-1 (Mumbai)** | Data residency for DPDP. Realtime is what makes §11 work. Auth included. 500 MB holds ~2 years — `HOSTING.md` §4 |
| Live sync | Supabase Realtime on `prescriptions`, `presence`, `appointments` | The doctor↔counter link is a subscription, not polling |
| Auth | Supabase Auth + **staff PIN over a registered device session** | Shared tablets. `TABLET.md` §5 |
| Hosting | **Cloudflare Workers / Pages, free** | The only major free tier that permits commercial use. Vercel Hobby forbids it — `HOSTING.md` §2 |
| Server logic | **Supabase Edge Functions** (WhatsApp webhook, sends) + `pg_cron` | Keeps the Worker under Cloudflare's 3 MiB free-plan ceiling |
| State transitions | **`plpgsql`, `SECURITY DEFINER`**, direct write grants revoked | Rules 2 and 3 below become DB-enforced instead of convention — `HOSTING.md` §3 |
| WhatsApp | **Meta Cloud API, direct**, on the clinic's own Meta Business account | No BSP monthly fee, no third party holding patient phone numbers, client owns the asset |
| Backups | `pg_dump` → GitHub Actions → Cloudflare R2, hourly, restore-tested weekly | Free tiers have none. This is ours to build — `HOSTING.md` §5 |
| Errors | Sentry free · UptimeRobot free | You will not be sitting in the clinic when it breaks |
| Tests | Vitest + Playwright (tablet viewport) + **pgTAP** for the transitions | pgTAP is new: the transitions now live in the database |
| Devices | 2 × 10–11" Android tablet, PWA-installed | `TABLET.md` §1 |

**Total hosting cost: ₹0/month.** Unavoidable running cost drops to ~₹390 (§17),
and most of that is the 4G router backup rather than anything to do with software.

**Rejected:** BSP aggregators (WATI/AiSensy/Interakt) — ₹2–5k/month forever, and
patient numbers sit in a third party's database, which is a DPDP problem you
would own. Revisit only if Cloud API onboarding stalls. **Rejected:** on-premise
server in the clinic — patient WhatsApp needs the internet anyway, so an
on-prem box buys nothing and makes backups, hardware failure and remote support
your problem. **Rejected:** Vercel Hobby — its fair-use terms define a paid
consultant's build as commercial, so it is off-limits regardless of usage.

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
| 2 | **One writer** — every state change is one `plpgsql` function, in a DB transaction, writing its audit row in the same transaction. Direct write grants on those tables are revoked, so the bypass is refused by Postgres rather than discouraged by convention (`HOSTING.md` §3) | a change happens that nobody can explain three months later |
| 3 | **Stock is a ledger** — `stock_movements` is the truth. `qty_on_hand` is a cache updated in the same transaction; a nightly job asserts they agree and alerts on drift | the shelf and the screen disagree and nobody knows when they started to |
| 4 | **Money and stock never move unattended** — no cron, no webhook, no auto-rule writes a sale, a dispense or a purchase order send | one bad reorder level orders ten times the stock and he pays for it |
| 5 | **Every send is a row before it is a send** — WhatsApp messages are persisted with an idempotency key, then dispatched; retries are safe | a webhook retry sends the same order to the supplier twice |
| 6 | **Presence is never a promise** — always rendered with an "as of" time; expires without a heartbeat | a patient drives 20 km to a locked door and blames the app |
| 7 | **Patient surfaces default-deny** — `findings` and `notes` never leave; a grep test enforces it across `app/p/**` | clinician shorthand, written for himself, is read by the person it is about |
| 8 | **Nothing clinical is inferred** — no computed high/low, no suggested dose, no suggested diagnosis. Only what a human entered | §15.3 |

Rules 1, 2, 7 and 8 are carried from the prototype, where they were earned.
Rules 3, 4, 5, 6 are new and exist because this build touches money, stock and a
third party.

**Ninth rule, added 16 Aug 2026:** *stock is always stored in base units — one
tablet, one ml, one piece — and pack configuration lives on the batch, not on
the drug.* Broken means every historical quantity is silently wrong the first
time a manufacturer changes a strip size. `INVENTORY.md` §1.

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
| **M4** | Billing: consult fee + medicines, discount, print (A4 + 80mm), day-book, counter till and cash day-close. **GST fields captured, GST off** (Q4) | 4 | A bill prints correctly for a consult + 4 medicines across 2 batches; the day's total matches the sum of its bills; the till reconciles against counted cash |
| **M5** | Purchasing + supplier WhatsApp (§10.4, §12.5) | 4 | Low stock drafts one PO per supplier; approve sends a template message; supplier's reply is captured; goods received against the PO create batches |
| **M6** | Presence + public status page (§13) | 2 | Doctor logs in → status live in 30s. Laptop shut → "away" within 5 min. Closing time → "closed" regardless of session |
| **M7** | Patient WhatsApp + portal (§14) | 7 | A real phone books an appointment, gets a token, opens the queue page, gets an "Rx ready" message, opens the prescription |
| **M8** | Reports and registers: Schedule H1 register, daily sales, stock valuation, expiry, purchase register (§15.2) | 3 | H1 register exports for a date range in a form an inspector accepts |
| **M9** | Hardening: E2E suite, offline write queue, backups + **tested restore**, monitoring, error states, permissions review, load of real data | 5 | Restore drill completes from a backup into a scratch project with zero data loss; Playwright covers the six critical paths |
| **M10** | Training, parallel run, go-live | 3 + 2 weeks calendar | §16 |

**Build total: 46 working days** as originally scoped. The 16 Aug 2026
constraints add to it:

| Addition | Days | Where |
|---|---|---|
| Inventory depth — base units, barcode, costing, blind stock-take, expiry returns, substitution, reorder intelligence | +12 | `INVENTORY.md` §10 |
| Tablet-first UI — layout system, numpad, search overlay, PWA, PIN auth, print on real hardware | +6 net | `TABLET.md` §9 |
| Transitions rewritten in `plpgsql` with pgTAP | +4 | `HOSTING.md` §3 |
| Free-tier ops rig — hourly dumps to R2, weekly restore drill, keep-alive, monitoring (net of what M9 already carried) | +2 | `HOSTING.md` §5 |
| Counter till and cash day-close (from Q3) | +1 | §18 |
| **Revised total** | **~71 days** | |

**Quote ~70 days, not 46.** The increase is real work the client asked for —
inventory as the centrepiece and tablets as the devices — and roughly ₹4,300/month
of hosting saved pays a slice of it back every year.

M0 → M1 → M2 → M3 are strictly sequential. M4–M8 can reorder. M7 cannot start
until the WhatsApp number is verified (§9), which is why the paperwork starts on
day 1. **M3 must start from `INVENTORY.md` §1** — the base-unit model is not a
feature that can be retrofitted onto recorded stock.

---

## 9. Calendar — the long pole is paperwork, not code

**Revised 16 Aug 2026: build local first** (`HOSTING.md` §1a). Supabase runs in
Docker on the dev machine, both tablets connect over the clinic Wi-Fi, and M0–M4,
M6 and M8 complete with no hosting account, no Meta account and no spend. M5 ships
in deep-link mode, which needs no Meta paperwork at all (`WHATSAPP.md` §0). Only
**M7 — patient WhatsApp — actually requires the outside world.**

That removes hosting from the critical path. It does *not* remove Meta
verification, if verification turns out to be required at all — see the open
question in `WHATSAPP.md` §0, which may take it off the critical path too. Until
that is resolved against Meta's own docs, treat the table below as live and start
it on day 1 anyway: it is free, and starting it late only moves the delay to the
end.

Start these on **day 1, before the first commit**:

| Task | Owner | Lead time |
|---|---|---|
| Meta Business Account + **business verification** (needs GST cert / incorporation docs / utility bill) | Client, you assist | **3 days – 3 weeks**, unpredictable |
| **Confirm he has a GST registration certificate** — his Q4 answer deferred GST *billing*, which is not the same as being unregistered. If he has none, Meta verification needs the drug licence + clinic registration + a utility bill instead, and that path is slower | Client | ask this week |
| **Published privacy policy at a public URL** — mandatory since Jan 2026 before any template can send | You draft, client publishes | 1 day |
| Dedicated phone number for WhatsApp Business Platform — must **not** be on the WhatsApp or WhatsApp Business app | Client | 1 day (new SIM) |
| Display-name approval | Client | 1–3 days |
| Message template submission and approval | You | Hours – 2 days each, rejections common |
| Domain + DNS for the portal | Client | 1 day |
| Drug master list with pack sizes, suppliers, MRPs | Client | **1–2 weeks of his time** — the real bottleneck |
| Opening stock count | Client + you | 1 day, done in one sitting, clinic closed |

Add, from the 16 Aug 2026 answers:

| Task | Owner | Lead time |
|---|---|---|
| **2 tablets, stands, and a network-capable printer** — check whether the existing A4 is USB-only | Client | 1 week to procure |
| **Clinic hours, weekly off, holiday calendar** (Q10 — he configures at handover) | Client | during the parallel run |
| **Salt composition and strength** on every drug in the master (Q8: no existing system, so this is typed from scratch) | Client, you assist | folded into the 1–2 weeks above, but it is now a harder ask |

**Realistic calendar: 14–16 weeks from signature to go-live** (was 10–12), of
which ~14 weeks is build and the rest is verification, data preparation and the
parallel run. Quote 16 weeks. Do not quote 6.

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
| One daily digest — "today's doses", opt-in per prescription | ~₹150 | Viable, but not in v1 |
| **Portal only, no push** | **₹0** | **Yes, v1 default** |

**Revised 16 Aug 2026.** Under the reactive-bot design (§10.3) reminders are the
*only* patient message left that costs anything — everything else moved inside
the free 24-hour service window. That makes them easy to defer: ship v1 without
them, and let him ask after a month of running the clinic. If he does, it is the
daily digest, opt-in per prescription, behind a clinic setting he can switch off
when he sees the bill.

### 10.3 Templates to build (v1)

**Revised 16 Aug 2026 — reactive-bot design (`WHATSAPP.md` §0a).** The patient
channel is now service-only: the patient always messages first (a QR at the
door, pre-filled), which opens a 24-hour window, and everything during the visit
is a free-form interactive reply inside it. No template, no category, no opt-in
machinery, no cost.

| Message | Now | Why |
|---|---|---|
| Booking confirmation | **free-form, in window** | the patient booked *through* the bot — the window is open by definition |
| Queue position / "you're next but one" | **free-form, in window** | |
| Prescription ready | **free-form, in window** | |
| Bill ready | **free-form, in window** | |
| `po_to_supplier` | **deep link — no template** | `WHATSAPP.md` §0. Sent from his own WhatsApp |
| Low stock to staff | **in-app only** | staff are looking at the screen anyway (§12.4). A message adds nothing |
| `dose_digest` | **template — deferred** | crosses the 24h boundary. §10.2's cost trap; drop it from v1 and let him ask for it |
| `clinic_closed` | **template — build it** | the one genuine exception (§13.3): rare, unprompted, and genuinely wanted |

**One template in v1**, down from eight. That removes template rejection from
the calendar, category reclassification from the risk register (`WHATSAPP.md`
§3), and the per-message cost from §17.

Two obligations this design creates, both in `WHATSAPP.md` §0a: a **human
fallback button**, because a menu that cannot answer "my child has a fever" is
worse than no bot; and an **away message** outside clinic hours pointing at
`/now`.

Carried unchanged: **a message never carries the record, only the fact that it
exists plus a link** — now for privacy and Meta's restricted-goods list rather
than for cost.

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

> Venu's brief is that inventory is the centrepiece, so this section is now the
> skeleton and [`INVENTORY.md`](INVENTORY.md) is the design: the base-unit model
> (§1 there — start with it, it is a correctness requirement), barcode scanning
> from the tablet camera, batch costing and valuation, blind stock-take, the
> expiry-return-and-credit workflow, salt-based substitution, and reordering
> that learns from measured supplier lead times. **+12 days** on M3/M4.

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
| **Rollback** | Cloudflare deployment rollback, one click; migrations are forward-only with a written down-path for each |
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

Build fee — yours to set. Anchors: ~71 build days (§8) plus ~15 days of setup,
training, data loading and support. Price the whole thing, not the days, and
price the parallel run in.

### Running (client pays vendors directly wherever possible — do not front these)

Revised 16 Aug 2026 for the free-hosting constraint. Working in
[`HOSTING.md`](HOSTING.md).

| Item | Indicative ₹/month | Note |
|---|---|---|
| Supabase free (ap-south-1) | **0** | 500 MB holds ~2 years. No PITR — we run our own hourly dumps instead |
| Cloudflare Workers/Pages | **0** | Free plan permits commercial use |
| Backups — GitHub Actions + R2 | **0** | Within both free tiers |
| Sentry, UptimeRobot | **0** | Free tiers are enough |
| Domain (.in) | ~70 | Optional. A `*.pages.dev` URL is free, but a QR on the clinic door deserves better |
| WhatsApp — patient channel | **~0** | Reactive bot, service messages only (§10.3, `WHATSAPP.md` §0a) |
| WhatsApp — `clinic_closed` template | ~20 | The one remaining template. Fires a handful of times a year |
| WhatsApp — supplier orders | **0** | Deep-link mode (`WHATSAPP.md` §0) |
| 4G router backup | ~300 | Prerequisite, not optional (§5.2). A clinic expense, not a hosting one |
| Second WhatsApp number | **0** | No longer needed — supplier traffic never touches the Cloud API number |
| **Total** | **~390** | Down from ~₹4,700. Plus your support/AMC |

One-time, client: **2 × tablet + stands, ~₹35–45k** (`TABLET.md` §1), and
possibly a Wi-Fi print server or a network-capable printer — his current A4 must
be checked, because **a tablet cannot print to a USB printer.**

**What free costs, stated plainly:** no vendor SLA, and up to one hour of data
loss in a total-loss scenario against the five minutes a paid plan's PITR would
give. He accepts both in writing, or he pays ₹2,100/month for Supabase Pro alone
— hosting stays free either way. `HOSTING.md` §9. Every free tier here is behind
an adapter, so escalating to paid is a configuration change of at most a day,
not a rewrite (`HOSTING.md` §7).

### Client obligations — put these in the contract

Drug master **with salt composition and strength** (`INVENTORY.md` §9) and pack
sizes and MRPs · supplier list with WhatsApp numbers **and return windows** ·
opening stock count · Meta business verification documents · a published privacy
policy · a dedicated SIM · the 4G backup · **2 tablets and stands** · **a
network-capable printer** (`TABLET.md` §1) · clinical sign-off (A8) · a named
person available for training · payment of vendor bills in his own name.

**Payment structure to propose:** 40% on signature, 30% on M3 acceptance (he
sees the doctor↔pharmacy loop working on real stock), 30% on go-live acceptance.
30-day warranty, then an AMC covering hosting oversight, backups, Meta template
changes and support hours.

---

## 18. Open questions — answered 16 Aug 2026

**Client answers, of record.** Nine of twelve are settled; three are not.

| # | Question | Answer | Consequence |
|---|---|---|---|
| 1 | Retail drug licence and pharmacist? (A2) | **Yes** — licence, pharmacist, pharmacy sells OTC and prescription, bills from the pharmacist's window | A2 confirmed. Counter sale and H1 selling are both in. Full §12 scope |
| 2 | Who sits at the counter? (A3) | **Two screens** — doctor in his cabin, pharmacist at the counter | A3 confirmed. M2 stays two windows. §11 is the real requirement |
| 3 | Walk-ins without a prescription? | **Yes — add the counter-sale monitor** | Counter sale confirmed, +2 days. Brings a till and a cash day-close with it |
| 4 | GST registered? | **Deferred** — set aside for now, planned later | **Do not** drop the fields. Capture cost, MRP and HSN from day 1 so switching GST on is a rate column and a bill layout, not a migration (`INVENTORY.md` §4) |
| 5 | Supplier ordering mode? (§10.4) | **One-tap approval** — with more clarification wanted | Recommended option taken. Remaining detail in §18.1 |
| 6 | How many suppliers, on WhatsApp? | **N suppliers, all reachable on WhatsApp** | M5 is worth building. Supplier management is unbounded CRUD, not a fixed list. Per-supplier return windows matter (`INVENTORY.md` §6) |
| 7 | Patients/day? | **Varies — needs clarification** | A4 (≤100/day) holds at any plausible number, so this blocks nothing. Sizing in `HOSTING.md` §4 assumes ~60 consults/day; revisit if he says otherwise |
| 8 | Existing software to migrate? | **No** | Migration risk gone. But there is no drug master to import either — §9's 1–2 week client bottleneck stands, and `INVENTORY.md` §9 makes it a harder ask |
| 9 | Printer? | **A4 now, small printer planned.** Updated 16 Aug 2026: **it is a Bluetooth printer** | Print CSS for both A4 and 80 mm. **Bluetooth does not solve this** — a tablet cannot print over Bluetooth either (`TABLET.md` §1, corrected). Still open: the model number, and whether it also has Wi-Fi. If it does, nothing to do; if it is Bluetooth-only, it cannot be used from a tablet at all |
| 10 | Clinic hours and weekly off? | **He will configure once the platform is ready** | Hours, weekly off and holidays must be settings, not constants. Presence auto-close reads them (§13.2) |
| 11 | Patients seeing diagnosis labels? | **Depends** | Build the config flag, default **off**, advice-only fallback. Costs little and defers the decision safely |
| 12 | Code ownership? | **Thinking about it** | Open. Blocks the contract, not the build. Your §15 below is the same question |

### 18.1 Still open — and what each one blocks

| # | Open | Blocks | Needed by |
|---|---|---|---|
| 5 | WhatsApp specifics — the six items in §18.2 | M5, M7 | before Meta verification starts (day 1) |
| 7 | Patients/day, smartphone share | nothing structural — affects the portal-vs-text emphasis in M7 | before M7 |
| 12 | Code ownership | the contract | before signature |
| — | ~~Does he accept free-tier's no-SLA and ≤1h data-loss window?~~ | ~~the hosting decision~~ | **deferred 16 Aug 2026** — build local, decide with a working system in the room (`HOSTING.md` §1a) |
| — | **Is business verification actually required at this volume?** (`WHATSAPP.md` §0) | whether the longest pole in §9 exists at all | before M7, ideally week 1 |

### 18.2 WhatsApp — the session to have with the doctor

He asked for clarification and so did Venu. [`WHATSAPP.md`](WHATSAPP.md) is the
reference; these are the six decisions that actually have to come out of that
conversation. One sitting, ~30 minutes.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| 1 | Which number sends supplier orders | main · second number · his personal phone via deep link | **Deep link, revised 16 Aug 2026.** It needs no Meta account, no verification, no templates and costs ₹0 — and it lets M5 ship during the local build (`WHATSAPP.md` §0). The second number stays the upgrade path if he later wants the send unattended |
| 2 | If he later wants true unattended supplier send | second number + Cloud API | Then, and only then, the paperwork applies. Revisit after go-live with real usage in hand |
| 3 | Per-supplier consent | ask each supplier for a written "yes, send orders here" | **Do it.** A WhatsApp reply is a record, and it is more than most businesses have |
| 4 | Dose reminders | per-dose · one daily digest · off | **Off in v1.** They are the only meaningful cost left and the only remaining template beyond `clinic_closed`. Let him run the clinic for a month and ask for them, if he still wants them (§10.3) |
| 5 | Who owns the Meta Business account | clinic · developer | **Clinic.** It is his asset, his verification, his number. Venu gets admin access, not ownership |
| 6 | Privacy policy URL | mandatory since Jan 2026 before any template sends | Venu drafts, clinic publishes. One day, and it gates every send (§9) |

Two things are **not** on the table and he should hear why: unofficial WhatsApp
libraries at any price (`WHATSAPP.md` §1), and a "doctor has arrived" broadcast
— marketing-category traffic that gets a number reported, replaced by the free,
always-current `/now` link (§13.3).

**For you:**

| # | Question |
|---|---|
| 13 | Fixed price or time-and-materials? Fixed price with this much unknown is a risk you carry |
| 14 | Are you available in person on go-live day and the week after? If not, don't sign |
| 15 | ~~Is this the first customer of a product, or a one-off?~~ **Answered 16 Aug 2026: a one-off, single-tenant.** No `clinic_id`; the `clinic` table is a single-row singleton with a constraint saying so. Taken against the `BUILD.md` §0 recommendation, and the cost curve has now turned — a second clinic is weeks of migration against live patient data, not three days of schema |

---

## 19. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Meta business verification stalls | Medium | Blocks M5, M7 | Start day 1. Deep-link fallback (§10.4) keeps supplier ordering alive |
| ~~WhatsApp number restricted after supplier messaging~~ | **Eliminated** | — | Supplier orders now go by deep link from his own WhatsApp (`WHATSAPP.md` §0). The Cloud API number never touches supplier traffic |
| ~~Number reported by patients, quality rating drops~~ | **Low** | Kills patient channel | Reactive bot only replies to people who messaged first (`WHATSAPP.md` §0a). Almost nothing to report |
| Drug master never arrives from the client | **High** | Blocks M3, go-live | Make it a payment milestone. Offer to type it from his purchase invoices, billed |
| Scope creep — "can it also do…" | **High** | Slips everything | §2 change control, agreed in writing at signature |
| Opening stock count is wrong | High | Every stock number wrong from day 1 | Stock-take in M3 exists for this. Reconcile nightly during parallel run |
| Clinic internet outage during consult | Medium | Consult stops | Offline write queue + 4G backup (§5.2) |
| He wants interaction checking / diagnosis help | Medium | Regulatory and liability exposure | §15.3. Decline or quote a licensed database separately |
| Fixed price with unknowns 1–12 unanswered | ~~High~~ **Low** | You absorb the overrun | ✅ 9 of 12 answered 16 Aug 2026. Three remain, none of them structural (§18.1) |
| **Free tier withdrawn or limits cut mid-contract** | Medium — Oracle halved its ARM free tier on 18 Aug 2026 | Emergency migration | Every free tier behind an adapter; escalation to paid is ≤1 day and costed (`HOSTING.md` §7). Re-verify at §8 there before signature |
| **Supabase free 500 MB reached** | Low in 2 years, certain eventually | Writes fail | Audit rows store changed fields only, never full snapshots. Alert at 400 MB, archive to R2, Pro is ₹2,100/mo (`HOSTING.md` §4) |
| **Free tier outage with no support queue** | Low, but no SLA | Clinic stops | §5.2 paper fallback + backfill. He accepts this in writing (`HOSTING.md` §9) |
| **His printer cannot be reached from a tablet** | **Raised to High, 16 Aug 2026** — it is a Bluetooth printer, and Bluetooth is not a network. Web Bluetooth is BLE-only, Web Serial's RFCOMM support is desktop-only, and Mopria excludes Bluetooth | Nothing prints from a tablet on go-live day, and M1's gate cannot close | Get the model number and check for Wi-Fi / Wi-Fi Direct / Ethernet on the spec sheet. Wi-Fi print server ~₹2,000, or a Wi-Fi 80 mm thermal ~₹3–5k (`TABLET.md` §1) |
| ~~Pack sizes retrofitted after stock is recorded~~ | **Eliminated** | — | Base units and batch-level pack config landed in the first migration, 16 Aug 2026, with a pgTAP assertion that fails any later migration putting `units_per_strip` or `mrp` back on the drug |
| **A second clinic is wanted later** | Low, but it is now the expensive direction | Weeks of migration against live patient data | Accepted consequence of Q15 (one-off, 16 Aug 2026). Quote it as a project, never as a configuration change |
| Sole-developer bus factor | Certain | He is running a clinic on it | Documented runbook, client owns credentials, code in a repo he can be given access to |

---

## 20. Sign-off

Nothing gets built until this is filled in.

```
Scope (§2) agreed as written                    [ ]  date ______
Assumptions §3 A1–A8 confirmed                  [~]  A2, A3 done 16-08-2026
Open questions §18 1–12 answered                [~]  9 of 12 done 16-08-2026
  └─ remaining: Q7, Q12, and §18.2              [ ]  date ______
Supplier send mode chosen (§10.4)               [x]  one-tap, 16-08-2026
Free-tier risks accepted (HOSTING.md §9)        [ ]  date ______
Price, milestones and running costs accepted    [ ]  date ______
DPA drafted and reviewed                        [ ]  date ______
Clinical sign-off process agreed (A8)           [ ]  date ______

Client: ____________________  Developer: ____________________
```
