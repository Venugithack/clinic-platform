# Consistency review — 17 Aug 2026

The 16 Aug revisions (free hosting, tablets, inventory depth, the reactive-bot
WhatsApp design, deep-link supplier orders) were applied unevenly. Several
sections still carry the design they replaced.

Nothing below is a design error. It is revision lag, plus a data model that has
not caught up to the two documents that supersede it. **§4 must be closed before
`BUILD.md` day 2**, because that is the day the first migration is written.

Each item quotes its own text, so it stays findable after line numbers move.

**Suggested order — three passes:**

| | Pass | Why first |
|---|---|---|
| 1 | §1 — `PROPOSAL.md` | It is the one file meant to leave the building. Everything in it is visible to the client |
| 2 | §2, §5 — internal staleness | Cheap, mechanical, and it stops the stale numbers being quoted back at you |
| 3 | §3, §4 — the estimate and the schema | §4 blocks the first migration |

---

## 1. Blocking — in the client-facing document

`PROPOSAL.md` is described in `README.md` as "safe to send as-is once the
bracketed placeholders are filled." It is not, yet. Five items.

### 1.1 The supplier section contradicts the rest of the same document

`PROPOSAL.md` §4, *"Supplier orders — a decision for you"*, still recommends
one-tap-via-Cloud-API and presents sending from his own phone as the fallback
*"if you would still prefer it fully automatic."*

But §10's cost table in the same document already reads:

> WhatsApp — supplier orders | **0** — sent from your own WhatsApp

That is deep-link mode. So §4 asks him to decide something §10 has already
decided, and the two halves of one document describe different builds.

Related, same section: §4 prices a second WhatsApp number at *"About ₹200/month.
Worth doing regardless"*, while `PLAN.md` §17 now reads *"Second WhatsApp number
| **0** | No longer needed — supplier traffic never touches the Cloud API
number."*

**Fix:** rewrite §4's decision block around deep link as the chosen design —
the automation he is paying for (knowing what to order and when, drafting it,
tracking the reply) is intact either way, and only the send button moves. Keep
the second number as the named upgrade path if he later wants the send
unattended, and drop the ₹200 from anything that reads as a running cost today.

### 1.2 A WhatsApp low-stock digest is promised that the design deleted

Three places, two answers:

| Where | Says |
|---|---|
| `PROPOSAL.md` §1 | *"plus one WhatsApp message each morning listing what has run low"* |
| `PROPOSAL.md` §4, alerts table | *"on screen live; one WhatsApp summary each morning"* |
| `PLAN.md` §10.3 | *"Low stock to staff — **in-app only** — staff are looking at the screen anyway (§12.4). A message adds nothing"* |
| `PLAN.md` §12.4 | *"WhatsApp digest to staff \| once daily, 08:00"* |

§10.3 cites §12.4 as its support while §12.4 says the opposite.

**Fix:** decide once. In-app only is the right answer under the reactive-bot
design — a staff digest is business-initiated, so it needs a template and a
per-message cost for information already on the screen they are holding. Then
correct all four places, including both in `PROPOSAL.md`.

### 1.3 The ₹2,900 figure does not reconcile

`PROPOSAL.md` §10:

> The figure above assumes the once-daily reminder design in §5; per-dose
> reminders would push it to roughly ₹2,900.

Two problems. The ~₹390 total does **not** assume the daily digest — §5
recommends shipping without reminders and the table carries no reminder line.
And 390 + 2,200 = 2,590, not 2,900.

**Fix:** state that the total excludes reminders, then give both deltas
explicitly — daily digest +₹150 → ~₹540; per-dose +₹2,200 → ~₹2,590. A cost
number a client cannot reproduce on a napkin is the wrong kind of surprise.

### 1.4 Backup frequency stated twice, differently

`PROPOSAL.md` §9 says *"Backups | Daily, stored separately"*. §10 of the same
document says *"Your data is backed up **every hour**."* `HOSTING.md` §5 is
hourly. §9 is the stale one.

### 1.5 He is asked to accept free hosting before start, having deferred it

`PROPOSAL.md` §11 lists *"Whether you accept free hosting, having read §10"* as
due **"Before we start"**, and §12's agreement block gates on it. `README.md`
carries the same requirement.

`PLAN.md` §18.1 explicitly deferred exactly this:

> ~~Does he accept free-tier's no-SLA and ≤1h data-loss window?~~ — **deferred
> 16 Aug 2026** — build local, decide with a working system in the room

**Fix:** move it to a decision due around M4, and say why in the proposal — *"we
build locally first, and you make this call with the working system in front of
you"* is a better sentence for him than a risk waiver at signature. `README.md`
item 5 needs the same correction.

---

## 2. Internal staleness

| # | Where | Problem |
|---|---|---|
| 2.1 | `PLAN.md` §10.3, end | The *"a message carries the fact and a link, never the record"* paragraph appears **twice, back to back** — once as "Carried unchanged", once as "Carried from the prototype and non-negotiable". Delete the second |
| 2.2 | `WHATSAPP.md` §9 | *"**Recommendation: row 2**"* (second number, one-tap, ~₹200/mo + verification) contradicts §0 of the same document and `PLAN.md` §18.2, both now deep link. §9 was not revised when §0 was added |
| 2.3 | `WHATSAPP.md` §8, closing lines | *"Unattended supplier orders → drafted automatically, sent on one tap, from a second number"* — same staleness as 2.2 |
| 2.4 | `README.md`, "Before anything is built" item 3 | *"~~§10.4 supplier send mode chosen~~ — **one-tap approval**, chosen 16 Aug 2026"* — superseded by the deep-link revision. "One tap" is ambiguous between the two mechanisms `WHATSAPP.md` §0 separates; name the mechanism |
| 2.5 | `HOSTING.md` §6 | WhatsApp still **₹300–800/month**, total **₹370–870**, *"Down from ~₹4,700 in `PLAN.md` §17"* — all pre-reactive-bot. `PLAN.md` §17 is now ~₹390. The prose immediately below the table already assumes the new design and contradicts its own table |
| 2.6 | `PLAN.md` §16 | *"Backups \| Supabase daily **PITR** plus a nightly logical dump"* — the free tier has no PITR. That absence is the entire reason `HOSTING.md` §5 exists. Replace with the hourly `pg_dump` → R2 rig and the weekly restore drill |
| 2.7 | `PLAN.md` §8, M0 row | Still *"staging + prod deploys"*, done when *"a staff member logs in **on staging**"*. Local-first (`HOSTING.md` §1a, `BUILD.md` §1) means no hosting account until M7. `BUILD.md` §1.8 has the correct M0 exit criteria — copy them |
| 2.8 | `PLAN.md` §3, A6 | *"He will buy a WhatsApp Business Platform number and **pay Meta's per-message fees**"* — under the reactive design the patient channel is ~₹0. The number is still needed; the fees clause is stale |
| 2.9 | `HOSTING.md` §7 | *"Two days from now, on **18 August 2026**, Oracle halves…"* — that was written on the 16th. Make it an absolute date with no relative clause. `PLAN.md` §19 describes the same event in the past tense; one of them is wrong on any given day |

---

## 3. The estimate does not add up any more

| | |
|---|---|
| `PLAN.md` §8 | M0 = **5 days**, and the ~71-day total is built on it |
| `BUILD.md` §1 | *"**7 days** (was 5; the plpgsql harness, PIN auth and the LAN certificate are new)"* |

Either the +2 is already absorbed by the `plpgsql` (+4) and tablet (+6) lines —
in which case `BUILD.md` should say so — or the total is **~73 days**, not 71,
and `README.md`, `PLAN.md` §8 and `PLAN.md` §17's pricing anchor all move with
it.

Worth settling before the build fee in `PROPOSAL.md` §10 is filled in, since
that number is derived from it.

---

## 4. The data model has not caught up — closes before day 2

`BUILD.md` §1.4 writes the first migration from `PLAN.md` §7 plus `INVENTORY.md`
§1. `PLAN.md` §7 predates both the base-unit rule and several features that were
added around it.

### 4.1 Missing tables

Four things other sections commit to have nowhere to live:

| Missing | Committed by |
|---|---|
| `counter_queries` | `PLAN.md` §11.1 — *"Implemented as Supabase Realtime subscriptions on `prescriptions` and a `counter_queries` table"*. It is the back-half of the headline feature |
| barcode → drug/batch map | `INVENTORY.md` §2 — *"the first scan of an unknown code prompts 'which drug is this?' once, and remembers"*. Many-to-one, so it is its own table |
| return notes + expected supplier credits | `INVENTORY.md` §6 — *"a return note removes stock via the ledger and opens an expected credit… reconciled against subsequent supplier invoices"* |
| till sessions + cash day-close | Q3's answer, `PLAN.md` §8 M4 (+1 day), and `PROPOSAL.md` §11 promises him *"a till, and a cash count at day-end"* |

### 4.2 Fields that must land in the first migration

`INVENTORY.md` §1 is explicit that pack configuration and MRP live on the
**batch**, and `BUILD.md` §1.4 says this lands in migration one, *"not a later
one"*. §7 currently disagrees:

| §7 today | Should be |
|---|---|
| `drugs … unit, pack_size` | `drugs … base_unit` (tablet/ml/piece), plus a *default* pack config used only to prefill the receiving screen |
| `drugs … generic` | structured `salt_composition` **and** `strength` — `INVENTORY.md` §7 needs both to match equivalence, and *"same salt + same strength + same form"* is the whole substitution feature |
| `stock_batches … cost_price, mrp` | adds `units_per_strip`, `strips_per_box`, `cost_per_base_unit`; `mrp` stays but is explicitly per-batch |
| `qty_received`, `qty_on_hand`, `qty` | `qty_base` everywhere — `BUILD.md` §1.4: *"named so it cannot be mistaken (`qty_base`, never `qty`)"* |
| `suppliers … lead_time_days` | adds `return_window_days` (`INVENTORY.md` §6) — and note `lead_time_days` is the *claimed* figure; `INVENTORY.md` §8 wants the **measured** one derived from PO-sent → GRN |

This is the one section on the list with an asymmetric cost curve. Everything
else here can be fixed next month; this cannot be fixed once stock is recorded
against it — which is the argument `INVENTORY.md` §1 already makes.

### 4.3 Barcode coverage is an untested assumption

`INVENTORY.md` §2 opens with *"Every Indian pharmacy strip carries a barcode."*
That sentence is load-bearing: it justifies 2 of the +12 days, and
`PROPOSAL.md` §4 sells scan-driven receiving, dispensing, counter sale and
stock-take on the back of it.

In practice a meaningful share of Indian strips carry no usable retail barcode,
and where they do it is often an inconsistent GS1 batch code rather than a
stable product code. If coverage on his shelf is 50%, the flagship accuracy
feature degrades to typing for half of every session.

**Twenty minutes of work:** take 20 strips off his actual shelf, scan them with
a phone, count how many resolve. Do it before `PROPOSAL.md` §4 is sent, and
either soften that paragraph or keep it with confidence.

It is also absent from `PLAN.md` §19's risk register either way.

### 4.4 Two WhatsApp messages have no template and no budget

`PLAN.md` §10.3 concludes *"**One template in v1**, down from eight"* —
`clinic_closed`. But two business-initiated messages survive elsewhere in the
plan:

| Message | Where | Status |
|---|---|---|
| *"3 orders ready for approval"*, 8am | `PLAN.md` §10.4, step 2 of the recommended design | Not in the template list, not in §17's costs |
| Low-stock digest to staff | `PLAN.md` §12.4 (see 1.2) | Same |

Both go to people inside the clinic who are already looking at the app. Simplest
resolution is to make both **in-app**, which keeps "one template in v1" true and
leaves §17's cost table correct. If either stays on WhatsApp, it needs a
template, an approval and a line in the cost table.

---

## 5. Minor

| # | Where | Problem |
|---|---|---|
| 5.1 | `WHATSAPP.md` §0a | Asserts verification is required because a dev WABA caps at five test numbers — then §0's closing section says the question is unresolved. Those are two different gates: *production access* vs *business verification*. Separate them, since resolving it is a day-1 item that may delete the longest pole in `PLAN.md` §9 |
| 5.2 | `HOSTING.md` §5, §8 | The weekly restore drill needs a scratch Supabase project and `PLAN.md` §16 wants a full staging environment, alongside prod — three projects, against a per-organisation cap on the free plan. Add the project count to §8's re-verify checklist |
| 5.3 | `HOSTING.md` §4 | Sizes tables named `consultations`, `prescription_lines`, `messages`. §7 calls them `encounters`, `prescriptions` (items as jsonb) and `wa_messages`. The jsonb difference in particular changes the estimate |
| 5.4 | `PROPOSAL.md` §4, alerts table | Promises expiry alerts at *"90 / 60 / 30 days before"*. `PLAN.md` §12.3 and `INVENTORY.md` §6 define a single 90-day threshold with a weekly digest |
| 5.5 | `PLAN.md` §5.3 | Header says *"Eight."* and then a ninth rule is appended below the table. Fold the base-unit rule into the table and say nine |
| 5.6 | `INVENTORY.md` §10 | Nominates §4 (costing) and §8 (reorder intelligence) as the budget cut of last resort — but `PROPOSAL.md` §4 already sells both to the client by name (*"What your shelf is worth"*, *"Ordering that learns"*). Once that document is sent, the 3.5-day escape hatch is gone. Either accept that, or keep those two paragraphs out of the version he signs |
| 5.7 | `PROPOSAL.md` §5 | *"One 'leaving now' button — on your computer and on your phone"*. He has tablets, not a computer. Small, but it is the kind of word a client notices |
| 5.8 | `PROPOSAL.md` §7 | Asks for *"GST certificate or registration"* for Meta verification without surfacing what `PLAN.md` §9 flags — that Q4 deferred GST *billing*, which is not the same as being registered, and the no-GST verification path is slower |
| 5.9 | git | `plan/build-kickoff` is byte-identical to `main`. Delete it locally and on origin, or it becomes a branch someone eventually assumes is ahead |

---

## Checklist

**Pass 1 — `PROPOSAL.md`, before it is sent**

- [ ] 1.1 §4 rewritten around deep link; second-number pricing corrected
- [ ] 1.2 Low-stock digest promise corrected in §1 and §4
- [ ] 1.3 §10 reminder arithmetic corrected and stated as a delta
- [ ] 1.4 §9 backup frequency → hourly
- [ ] 1.5 Free-hosting decision moved to ~M4 in §11 and §12
- [ ] 5.4, 5.6, 5.7, 5.8

**Pass 2 — internal staleness**

- [ ] 2.1 – 2.9
- [ ] 5.1, 5.2, 5.3, 5.5
- [ ] 1.2 and 1.5's counterparts in `PLAN.md` and `README.md`
- [ ] 5.9 delete `plan/build-kickoff`

**Pass 3 — estimate and schema, before `BUILD.md` day 2**

- [ ] §3 M0 reconciled at 5 or 7 days; totals and pricing anchor follow
- [ ] 4.1 four missing tables added to `PLAN.md` §7
- [ ] 4.2 base-unit fields moved onto the batch; `qty_base` naming throughout
- [ ] 4.3 barcode coverage physically tested on his shelf; risk register updated
- [ ] 4.4 both staff messages resolved as in-app, or templated and costed
