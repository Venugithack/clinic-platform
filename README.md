# Clinic platform

Custom build for a single-doctor clinic with an in-house pharmacy. Separate
product from the hospital prototype in `../hospital al in one platform` — that
one is a demo, this one has a paying client and a real drug shelf behind it.

**M0–M6, M8, M9 and M11a are built** (17 Aug 2026) — see
[What is built](#what-is-built) below, and `BUILD.md` §5–14. Seven documents describe the rest:

| File | Audience | |
|---|---|---|
| [`PLAN.md`](PLAN.md) | **you only** | the full build plan — architecture, data model, day estimates, risk register, your pricing anchors, and the questions you need to answer yourself. Not for the client |
| [`PROPOSAL.md`](PROPOSAL.md) | **the client** | the same plan written for the doctor — what he gets, what it costs him, what he must supply, what he must decide. Safe to send as-is once the bracketed placeholders are filled |
| [`WHATSAPP.md`](WHATSAPP.md) | **you only** | why WhatsApp automation is a grey area — six separate ambiguities, how to spot an unofficial vendor, and every message in this build classified by risk. Decides the supplier-send question |
| [`HOSTING.md`](HOSTING.md) | **you only** | how this runs for ₹0/month, what free costs in reliability, the backup rig that replaces what free tiers omit, and the one-day exit ramp to paid |
| [`INVENTORY.md`](INVENTORY.md) | **you only** | the inventory design brief — base units, barcode, costing, blind stock-take, expiry returns, salt-based substitution, reorder intelligence |
| [`TABLET.md`](TABLET.md) | **you only** | the tablet-first UI/UX brief — layout, touch rules, the three interactions that decide whether it feels good, and the printer trap |
| [`BUILD.md`](BUILD.md) | **you only** | how the build actually starts — M0 day by day, the gates after it, what is blocked and on whom. **Read §0 first: one decision blocks the first migration** |

Placeholders to fill in `PROPOSAL.md` before sending: clinic name, date, build
fee (§10). Everything else is complete.

## What is built

**M0** — foundations. **M1** — clinic core: a walk-in becomes a token, a
consult, a signed prescription and a printable A4 sheet. **M2** — the
doctor↔counter live link, the feature the clinic actually bought. **M3** —
inventory, the centrepiece: goods receipt, barcodes, FEFO dispensing with
scan-to-verify, the counter sale, the blind stock-take, expiry returns and
supplier credits, and reordering that learns from measured lead times. **M4** —
billing: gapless invoice numbers, A4 and 80mm bills, the day-book, and a cash
till that is counted rather than assumed. **M5** — purchasing: one order per
supplier, approved and sent by the doctor as a WhatsApp deep link, the reply
recorded, and goods received against the order. **M6** — presence: a heartbeat,
a hard close, and a public status page that never says "available". **M8** —
the legal registers: Schedule H1, purchases, expiry write-offs, sales, and a
batch trace for recalls, each exporting as a CSV an inspector can open. **M9** —
hardening: an offline write queue that cannot apply a sale twice, the
permissions review as a standing test, and a restore drill that stopped lying.
**M11a** — the drug master import: paste or choose a CSV, see exactly what it
will do, and load five hundred rows in one go. **M7** (patient WhatsApp and the
patient portal) is deferred at the client's request.

```
app/                Next 16 · React 19 · TS strict · Tailwind 4
  (clinic)/         queue · register walk-in · consult · Rx print · counter
                    receiving · stock-take · expiry · reorder
                    billing · bill print (A4 + 80mm) · day-book · orders
                    presence · reports · import
  p/  now/          patient portal and public status page, default-deny
components/         three-pane shell, numpad, drug search, quantity pad,
                    the counter's questions
lib/
  db/               the ONLY module that imports @supabase/* — lint-enforced
  transitions/      typed wrappers over the plpgsql RPCs
  auth/             device session + staff PIN (TABLET.md §5)
  realtime/         two adapters: Supabase Realtime, and WebSocket over
                    LISTEN/NOTIFY — the HOSTING.md §7 swap, exercised on
                    every test run rather than asserted
  units/            base-unit conversion and costing (INVENTORY.md §1, §4)
  reports/          CSV both ways — quoting, formula injection, BOM on write;
                    a hand-written parser for the file the doctor typed
  offline/          the write queue: keeps what the network ate, never a refusal
  whatsapp/         deep links — four lines, and the reason M5 needs no Meta
                    account at all (WHATSAPP.md §0)
  barcode/          BarcodeDetector, with manual entry beside it
supabase/
  migrations/       25 forward-only migrations — the schema
  tests/            379 pgTAP assertions
  seed.sql          22-drug development seed
e2e/                Playwright, 1280×800 with touch, no desktop project
scripts/            local stack, migrations, backup, restore drill, LAN HTTPS
```

```
pnpm install
./scripts/dev-stack.sh --reset    # Postgres, migrations, seed, API, .env.local
pnpm dev                           # then open the app
pnpm test                          # typecheck · lint · unit · pgTAP · e2e
```

**The two tests that matter most** are in
`supabase/tests/20_transition_grants.sql`: a direct write to the stock ledger is
refused by Postgres with `42501`, and the same role can still call
`app.dispense`. That is `PLAN.md` §5.3 rules 2 and 3 becoming something the
database enforces rather than something the team remembers.

**The M1 gate** is `e2e/m1-gate.spec.ts`, driven against a real Postgres with
real RLS and the real transitions — not a stubbed API.

**The M2 gate** is `e2e/m2-live-link.spec.ts`, driven across two browser
contexts because one context proves nothing about a link between two devices.
It measures the latency and fails above 1.5s, so a regression to polling breaks
the build. It currently runs at ~150ms.

**The M3 gate** is `e2e/m3-dispense.spec.ts`: two batches of one drug with
different expiries, MRPs and strip sizes, FEFO taking the earlier one, and a
barcode scan stopping a pack that is not on the prescription.

**The M4 gate** is `e2e/m4-gate.spec.ts`: a bill for a consultation plus four
medicines, printed at both paper sizes with batch numbers intact; the day's
total reconciled against the sum of its bills; and a drawer counted ten rupees
short, recorded as ten rupees short.

**The M5 gate** is `e2e/m5-gate.spec.ts`, and it asserts a `wa.me` link rather
than a delivery — because a deep link is sent from the doctor's own phone and
this app cannot see what happened next. That single design decision removes Meta
business verification, a second number, template approval and opt-in machinery
from the supplier channel entirely (`WHATSAPP.md` §0).

**The M6 gate** is split on purpose: `A2_presence.sql` moves the clock to prove
a sleeping laptop reads "away" and that closing time beats a live session, and
`e2e/m6-presence.spec.ts` asserts the thing a database cannot — that the public
page never says "available". Presence is computed on read, so no scheduled job
exists to fail.

**The M8 gate** is `e2e/m8-registers.spec.ts`, and the word it tests is
*exports*: a Schedule H1 dispense, then a real CSV downloaded off a tablet with
the six columns the rule names — and its first code unit asserted to be a BOM,
because Excel on Windows reads UTF-8 without one as Latin-1 and turns every
Indian name into mojibake. M8 adds **no transitions at all**: every column it
needed was already in the ledger.

**The M11a rule** is in `20260817090100_import.sql`, and it is the one that
looks wrong until you follow it through: a file with a single unreadable row
imports **nothing**, not even the four hundred rows above it. A drug missing
from the master is indistinguishable, at every other screen in this build, from
a drug the clinic does not stock — so a half-import does not fail in the import
screen where somebody could act on it. It fails at the counter, mid-sale, with
the patient standing there.

**The M9 property worth understanding** is in `20260816270100_replay.sql`: a
queued write carries a key made before its first attempt, and the key row
commits in the same transaction as the effect. So a sale can never be applied
twice, and a sale that *failed* rolls its key back with it and stays retryable.
One property, both guarantees.

**The number that surprised me** is in `e2e/m3-expiry.spec.ts`. Suppliers want
stock back *months before* it expires — 3 to 6, and it differs per supplier — so
the date that decides whether a batch can go back is `expiry −
return_window_days`, not the expiry. A list sorted by expiry date finds out
after the door has already shut, every time. That one design decision is most of
what `INVENTORY.md` §6 is worth.

**The bug worth knowing about:** every transition refusal in the build was
invisible until 16 Aug 2026. PostgREST reserves SQLSTATEs starting `PT` and
reads the rest as an HTTP status, so `PT003` asked for HTTP status 3 — the
response never framed and the screen hung instead of showing the refusal. Only
success paths worked, which is why it survived three milestones. Codes are now
`CL0xx`; see `BUILD.md` §8.

**Not done, and not code:** `BUILD.md` §1.3 — LAN HTTPS, the root CA on both
tablets, PWA install, the printer's Android print service plugin, one real
prescription printed, and one real bill on each paper size. The **80mm roll
printer has not been bought yet** (§18 Q9), so that layout has never met a
thermal printer. All of it happens in the clinic; `scripts/lan-https.sh` is the
runbook and carries the checklist.

**Still to build, and it is all go-live tooling:** opening-stock import (this
one loads drugs and suppliers; stock is batches, and it goes through goods
receipt), a settings screen (consult fee, hours, licence numbers and GSTIN are
SQL-only today), staff and device admin, and the two screens M8 implied —
editing a patient's address, and voiding a bill. `BUILD.md` §14 lists them.

Build continues after `PLAN.md` §20 is signed off.

| | |
|---|---|
| Client wants | doctor-room ↔ pharmacy live link · inventory with batches and expiry · low-stock alerts · supplier orders over WhatsApp · patient WhatsApp with booking, token, prescriptions and doctor-in-clinic status |
| Developer constraints | free hosting · tablets are the devices · inventory is the centrepiece |
| Stack | Next 16 · React 19 · TypeScript · Tailwind 4 · Supabase free (Postgres + Realtime + Auth, ap-south-1) · `plpgsql` transitions · Meta WhatsApp Cloud API · **Cloudflare Workers** |
| Hosting cost | **₹0/month.** Total running cost ~₹390, most of it the 4G router backup. Patient WhatsApp is a reactive bot inside the free service window; supplier orders go by deep link |
| Build estimate | ~71 working days · **14–16 weeks calendar** — Meta verification and the client's drug master are still the long poles |

## Before anything is built

1. ~~§3 assumptions A1–A8 confirmed~~ — A2 and A3 confirmed 16 Aug 2026; the rest still open
2. ~~§18 questions 1–12 answered~~ — 9 of 12 answered 16 Aug 2026. Q7, Q12 and the WhatsApp session (§18.2) remain
3. ~~§10.4 supplier send mode chosen~~ — **one-tap approval**, chosen 16 Aug 2026
4. The §18.2 WhatsApp session with the doctor — six decisions, ~30 minutes, gates Meta verification
5. Free-tier risks accepted in writing (`HOSTING.md` §9)
6. ~~Check the model number of the clinic's A4 printer~~ — **settled 16 Aug 2026: it is Bluetooth *and* Wi-Fi, so nothing to buy.** Bluetooth alone would not have worked (`TABLET.md` §1)
7. Meta business verification started (day 1, and `WHATSAPP.md` §0 may show it is not needed at all)
8. ~~**`BUILD.md` §0 — Q15, multi-tenant or not**~~ — **single-tenant, decided 16 Aug 2026.** The first migration is applied
9. §20 signed
