# Clinic platform

Custom build for a single-doctor clinic with an in-house pharmacy. Separate
product from the hospital prototype in `../hospital al in one platform` — that
one is a demo, this one has a paying client and a real drug shelf behind it.

**No code yet. [`PLAN.md`](PLAN.md) is the whole repo until §20 is signed off.**

| | |
|---|---|
| Client wants | doctor-room ↔ pharmacy live link · inventory with batches and expiry · low-stock alerts · supplier orders over WhatsApp · patient WhatsApp with booking, token, prescriptions and doctor-in-clinic status |
| Stack (planned) | Next 16 · React 19 · TypeScript · Tailwind 4 · Supabase (Postgres + Realtime + Auth, ap-south-1) · Meta WhatsApp Cloud API · Vercel |
| Build estimate | 46 working days · **10–12 weeks calendar** — Meta verification and the client's drug master are the long poles |

## Before anything is built

1. §3 assumptions A1–A8 confirmed by the client
2. §18 questions 1–12 answered
3. §10.4 supplier send mode chosen — one-tap approval is recommended over
   unattended send, for reasons that are worth reading before agreeing
4. Meta business verification started (day 1, it gates two modules)
5. §20 signed
