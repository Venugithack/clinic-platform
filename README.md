# Clinic platform

Custom build for a single-doctor clinic with an in-house pharmacy. Separate
product from the hospital prototype in `../hospital al in one platform` — that
one is a demo, this one has a paying client and a real drug shelf behind it.

**No code yet.** Six documents:

| File | Audience | |
|---|---|---|
| [`PLAN.md`](PLAN.md) | **you only** | the full build plan — architecture, data model, day estimates, risk register, your pricing anchors, and the questions you need to answer yourself. Not for the client |
| [`PROPOSAL.md`](PROPOSAL.md) | **the client** | the same plan written for the doctor — what he gets, what it costs him, what he must supply, what he must decide. Safe to send as-is once the bracketed placeholders are filled |
| [`WHATSAPP.md`](WHATSAPP.md) | **you only** | why WhatsApp automation is a grey area — six separate ambiguities, how to spot an unofficial vendor, and every message in this build classified by risk. Decides the supplier-send question |
| [`HOSTING.md`](HOSTING.md) | **you only** | how this runs for ₹0/month, what free costs in reliability, the backup rig that replaces what free tiers omit, and the one-day exit ramp to paid |
| [`INVENTORY.md`](INVENTORY.md) | **you only** | the inventory design brief — base units, barcode, costing, blind stock-take, expiry returns, salt-based substitution, reorder intelligence |
| [`TABLET.md`](TABLET.md) | **you only** | the tablet-first UI/UX brief — layout, touch rules, the three interactions that decide whether it feels good, and the USB-printer trap |

Placeholders to fill in `PROPOSAL.md` before sending: clinic name, date, build
fee (§10). Everything else is complete.

Build starts after `PLAN.md` §20 is signed off.

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
6. Check the model number of the clinic's A4 printer — **a tablet cannot print over USB** (`TABLET.md` §1)
7. Meta business verification started (day 1, it gates two modules)
8. §20 signed
