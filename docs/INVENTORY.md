# Inventory — the design brief for "top notch"

Venu's instruction. `PLAN.md` §12 has the skeleton — append-only ledger, FEFO,
the three sets, the PO lifecycle. This document is what raises it from correct
to genuinely good, and it starts with the one thing that sinks most pharmacy
software before anything else gets a chance to.

---

## 1. The unit model — get this wrong and nothing above it works

A pharmacy **buys in boxes and sells in tablets.** The doctor writes "6 tablets";
the supplier invoices "1 box = 10 strips × 15 tablets." Software that stores
"quantity: 4" without knowing what a 4 is will be wrong within a week and
unfixable within a month.

**Rule: every stock number in the database is in base units. Always. No
exceptions.** A base unit is the smallest sellable thing — one tablet, one ml,
one piece. Boxes and strips exist only at the edges: on the receiving screen and
on the label.

```
GRN: "2 boxes"  ──convert on receipt──►  ledger: +300 tablets
                                              │
counter: "6 tablets"  ──────────────────► ledger: −6 tablets
                                              │
display: 294 ──decompose──► "19 strips + 9 loose"
```

### The detail that separates working software from broken software

**Pack configuration and MRP live on the batch, not on the drug.**

Manufacturers change strip sizes between production runs, and MRP changes
between batches — that is exactly why it is printed on the strip. If the
conversion factor lives on the drug record, one supplier changing 15s to 10s
silently corrupts every historical quantity you have.

| Field | Lives on | Why |
|---|---|---|
| `base_unit` (tablet / ml / piece) | drug | never changes |
| `salt_composition`, `strength` | drug | drives substitution, §7 |
| `units_per_strip`, `strips_per_box` | **batch** | changes between production runs |
| `mrp` | **batch** | printed per batch; selling above it is illegal |
| `cost_per_base_unit` | **batch** | what this batch actually cost, §4 |
| `qty_on_hand` | batch, in base units | cache over the ledger |

The drug carries a *default* pack config to prefill the receiving screen. The
batch records what actually arrived. They are allowed to differ, and when they
do, the batch wins.

### Consequences that fall out for free

- **Loose-strip tracking is automatic.** 47 tablets on hand with 15 to a strip
  is 3 strips and 2 loose, computed, never stored, never drifting.
- **Sale price** is `batch.mrp ÷ units_in_pack`, rounded to the paise, with a
  hard invariant: a line total can never exceed `mrp × packs sold`. Rounding a
  loose-tablet price up past MRP is a legal problem, not a rounding problem.
- **Two batches of the same drug at different MRPs** coexist correctly, and
  FEFO decides which one the patient is charged for.

---

## 2. Barcode, from the tablet camera

Both screens are tablets (`TABLET.md`). Tablets have cameras. Every Indian
pharmacy strip carries a barcode. This is free accuracy, and it is the single
highest-value addition in this document after §1.

| Where | What it removes |
|---|---|
| **Goods receipt** | Typing drug names off an invoice — the slowest, most error-prone screen in the build |
| **Dispense** | The wrong-drug-off-the-shelf error. Scan what you picked; it either matches the prescription line or it refuses |
| **Counter sale** | Scan-scan-scan-total. This is what the customer expects a shop to look like |
| **Stock-take** | Scan-and-count instead of hunting a printed list |

Implementation is `BarcodeDetector` where the tablet supports it, ZXing-wasm as
the fallback. No scanner hardware, no cost, no drivers.

**Scan-to-verify at dispense is the safety feature worth naming to the doctor.**
A pharmacist reaching for the wrong box is the error that actually harms
someone, and this catches it before the patient is holding it.

Barcodes map many-to-one onto batches: the first scan of an unknown code prompts
"which drug is this?" once, and remembers.

---

## 3. What the inventory refuses

Extending `PLAN.md` §11.3. These are invariants enforced in the plpgsql
transitions (`HOSTING.md` §3), not validations in a form.

| Refusal | Reason |
|---|---|
| Stock can never go negative — no override, no staff role | A negative shelf is a lie the software told |
| Expired batches are excluded from on-hand, not merely flagged | §12.3 conflation is what let expired stock over the counter in the prototype |
| Dispense allocates FEFO, splitting across batches, recording each | Recall traceability |
| Schedule H1 cannot leave on a counter sale | Legal, §15.2 |
| A line total can never exceed batch MRP × packs | Legal |
| GRN cannot create a batch with an expiry in the past | Catches a mistyped year at the door |
| GRN cannot create a batch whose expiry is earlier than an existing batch already dispensed against | Catches the other mistyped year |
| The ledger is append-only — corrections are compensating rows with a reason | An edit is a story nobody can reconstruct |

**Sold-before-received.** The stock is physically on the shelf but the GRN is
not entered — a daily occurrence in real pharmacies. The tempting fix is to
allow negative stock. The right fix is an **inline quick-GRN** on the counter
screen: three fields, batch and expiry and quantity, posted as a real receipt,
flagged for the invoice to be attached later. The sale proceeds, the ledger
stays true, and there is a work queue of receipts awaiting paperwork.

---

## 4. Costing and valuation — where the money actually is

`PLAN.md` §12 tracks quantities. It does not track what they cost, which means
it cannot answer the two questions the doctor will ask in month two: *what is
sitting on my shelf worth,* and *what am I making on it.*

| | Design |
|---|---|
| Method | **Weighted average cost per base unit, per batch** |
| Set at | GRN, from invoice value ÷ base units received, net of trade discount and inclusive of freight where apportioned |
| Valuation | `SUM(qty_on_hand × cost_per_base_unit)` over non-expired batches, as of any date via the ledger |
| Margin | Per sale line, per drug, per month — sale value minus cost of the units actually allocated |
| Expiry loss | Written off at cost to a `expiry_writeoff` reason code, reported monthly |

Because the ledger records which batch each unit left from, cost of goods sold
is exact rather than estimated. Stock valuation as of 31 March, for his
accountant, is one query and it reconciles.

GST is deferred by his answer to Q4, but **cost and MRP are captured from day
one**, so switching GST on later is a tax-rate column and a bill layout, not a
data migration.

---

## 5. Stock-take that finds errors instead of confirming them

A stock-take that shows the expected number next to the count field does not
find discrepancies. The counter sees 47, counts "about 47," types 47. This is
well-documented human behaviour and it makes the whole exercise theatre.

| Step | Design |
|---|---|
| 1. Scope | Full, or by shelf/rack, or by drug group. Partial counts are what actually happen |
| 2. Count | **Blind** — the expected quantity is not shown. Scan the strip, enter what is there |
| 3. Variance | Expected vs counted, sorted by value of the discrepancy, not by size |
| 4. Recount | Anything over a threshold goes back for a second count before it can post |
| 5. Approve | The doctor approves. Only then do adjustment rows post |
| 6. Post | One `adjust` movement per batch, with the stock-take id as the reason |

Nothing posts to the ledger until step 5. A stock-take in progress does not
block the counter — sales during the count are timestamped and reconciled
against the count time.

The variance report is also the theft-and-drift detector, which is why it is
sorted by rupee value.

---

## 6. Expiry, worked all the way through

`PLAN.md` §12.3 defines `expiring_soon`. It does not say what anybody does about
it, and "use it or lose it" is not a workflow.

```
90 days out ──► expiring_soon list, weekly digest to the counter
                     │
      ┌──────────────┼──────────────┐
      ▼              ▼              ▼
 return to      dispense first   write off
 supplier       (FEFO already     at cost
      │          does this)          │
      ▼                              ▼
 return note ──► credit expected ──► reconciled against
 (stock out)     from supplier       the next invoice
```

Most suppliers accept returns within a window before expiry — typically 3 to 6
months, per supplier, and missing that window is pure loss. So:

- `suppliers.return_window_days`, and the expiring list is grouped by **whose
  return window is closing first**, not merely by expiry date.
- A return note removes stock via the ledger and opens an expected credit.
- Credits are reconciled against subsequent supplier invoices, so unreturned
  credits are visible instead of forgotten.

This one section pays for a meaningful part of the build fee every year, and it
is the most common thing missing from cheap pharmacy software.

---

## 7. Substitution that is real

`PLAN.md` §11.2 promises the prescription composer will show `OUT — 2
alternatives`. That promise requires the drug master to carry **salt
composition and strength as structured fields**, not inside the brand name.

| | |
|---|---|
| Equivalence | Same salt + same strength + same dosage form = substitutable |
| Shown as | Brand, in stock, MRP, and the price difference against what was prescribed |
| Who decides | **The doctor.** The counter proposes over the realtime link (§11.1); the doctor approves. Never automatic |
| Recorded | Both the prescribed drug and the dispensed drug, with the approval and who gave it |

This is the clean side of `PLAN.md` §5.3 rule 8. Matching identical salts is a
lookup, not a clinical inference — no interaction checking, no therapeutic
alternatives, no "similar" drugs. Same salt, same strength, or nothing.

It also makes the drug master a harder client deliverable (§9). Worth it: it
turns the headline feature from a badge into something that answers a real
question at the counter.

---

## 8. Reordering that learns, and still never acts alone

`PLAN.md` §12.4 offers a suggested reorder level after 60 days. Extend it, keeping
rule 4 — nothing orders itself — absolutely intact.

| Signal | Source | Use |
|---|---|---|
| Consumption velocity | 30/60/90-day moving average from the ledger | the base number |
| **Measured** supplier lead time | actual days from PO `sent` to GRN, per supplier | not what the supplier claims |
| Lead-time variance | same data | buffer for the unreliable ones, not a flat 1.5× for everyone |
| Stockout history | how often on-hand hit zero | the drugs that need a bigger cushion |
| Supplier price history | last 5 purchase prices per drug per supplier | shown on the PO line: "₹42 last time from Kumar, ₹45 from Reddy" |

Everything above is **suggestion only**, rendered as a proposed quantity the
doctor can edit before the one tap that sends (`WHATSAPP.md` §9). The moment
these numbers write a PO by themselves, `PLAN.md` §5.3 rule 4 is gone and one
bad reorder level costs him real money.

Price history on the PO line is small to build and immediately visible — he
sees he is being charged more than last month, at the moment he can do something
about it.

---

## 9. The drug master is the gate

Everything in this document assumes a drug master with, per drug: name, salt
composition, strength, dosage form, schedule (H / H1 / OTC), default pack
configuration, HSN code (for the deferred GST), and a default supplier.

`PLAN.md` §19 already rates "drug master never arrives" as **high likelihood,
blocks go-live**. Sections 1, 4 and 7 above make it a harder ask than it was.
So the mitigation gets stronger, not weaker:

- Salt and strength are **mandatory**; pack config and HSN can be filled during
  the parallel run.
- Ship an importer that takes his supplier invoices — most distributors send a
  CSV or a printed invoice that can be typed once and reused.
- Bootstrap from the last 6 months of purchase invoices: that is his real
  formulary, roughly 300–500 drugs, not the 40,000 in a national database.
- Make it a **payment milestone**, as §17 already recommends.
- Offer to do the data entry, billed. It is the fastest path and he will
  probably take it.

---

## 10. What this adds to the estimate

Against `PLAN.md` §8's M3 and M4:

| Addition | Days |
|---|---|
| Batch-level pack config, MRP, unit conversion (§1) | 2 |
| Barcode scan — receipt, dispense, counter, stock-take (§2) | 2 |
| Costing, valuation, margin reporting (§4) | 2 |
| Blind stock-take with variance and approval (§5) | 1.5 |
| Expiry returns, credit notes, write-offs (§6) | 2 |
| Salt-based substitution (§7) | 1 |
| Reorder intelligence and price history (§8) | 1.5 |
| **Total** | **+12 days** |

§1 is not optional — it is a correctness requirement, and building without it
means rebuilding. The rest is the difference between inventory that records what
happened and inventory the doctor runs his purchasing from.

**The 3.5-day escape hatch is closed.** §4 and §8 were the two to cut if the
budget forced it — the only two addable later without touching data already
recorded. Both shipped in M3: weighted-average cost per base unit, carried
through dispense into the ledger (§4), and `consumption_velocity`,
`supplier_lead_time`, `stockout_history`, `supplier_price_history` and
`reorder_suggestions` (§8). Both are also sold to the client by name in
`PROPOSAL.md` §4 — *"What your shelf is worth"* and *"Ordering that learns"*.
Cutting either one now would not be a descope but a retraction: the code exists,
and the sentence promising it is in the document he is about to be sent. If the
budget has to move, it has to move somewhere else.
