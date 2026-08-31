# Hosting this for ₹0 — what works, what it costs, how to leave

Venu's constraint: **host it online, free.** This document is the answer. It is
achievable, the architecture it forces is *better* in one important way, and it
has three real costs that have to be accepted in writing before build.

Verified August 2026. Free tiers move — §8 is the re-check list.

---

## 1. The tension, stated once

`PLAN.md` §16 promises "no room for error" on a system holding a drug shelf and
a patient register. Free tiers offer no SLA, no support queue, and **no
backups**. Those two sentences are in conflict.

The resolution is not to pretend otherwise. It is:

1. Take free hosting where free hosting is genuinely production-grade (it is,
   for a workload this small).
2. **Build the backup and monitoring rig ourselves**, because that is the part
   the free tier removes and it is the part a clinic cannot go without.
3. Keep the exit ramp to paid at one day of work, not one month (§7).

Free is then a real engineering position, not a hope.

---

## 1a. Decided 16 Aug 2026: build local first, choose hosting after

Venu's call, and it is the right one. The whole of §2 onward is a decision that
does not have to be made until there is something worth deploying.

**What runs with no internet and no accounts:** `supabase start` brings up
Postgres, Auth, Realtime and Studio in Docker on the dev machine. Next runs on
`0.0.0.0`. Both tablets hit it over the clinic Wi-Fi. The doctor↔counter live
link — the headline feature — demos fully offline, on the real devices, in the
real rooms.

| Module | Local? |
|---|---|
| M0 foundations · M1 clinic core · M2 **live link** · M3 inventory · M4 billing · M6 presence · M8 registers | **yes, entirely** |
| M5 supplier WhatsApp | yes in **deep-link mode** (`WHATSAPP.md` §0) — no Meta account needed at all |
| M7 patient WhatsApp | **no.** Needs Cloud API, a real number and a public webhook URL |
| M9 hardening | partly — backups and restore drills are local; the deploy rig waits |

So roughly **80% of the build proceeds with no hosting decision, no Meta
account and no spend.**

### The trap that will cost a day if it is not handled in M0

**`http://192.168.1.x:3000` is not a secure context.** Only `localhost` is. On
the tablets, over plain HTTP on the LAN, these fail silently:

| Feature | Needs |
|---|---|
| Barcode scanning from the camera (`INVENTORY.md` §2) | `getUserMedia` — secure context |
| PWA install, fullscreen (`TABLET.md` §6) | service worker — secure context |
| The offline write queue (`PLAN.md` §5.2) | service worker — secure context |

Three of the features the client is paying for. Discovering this in M3, when
barcode scanning "doesn't work on the tablet," wastes a day and looks bad.

**Fix it on day one of M0:**

1. `mkcert` a certificate for the dev machine's LAN hostname.
2. Install the root CA on both tablets — once, five minutes each.
3. Give the dev machine a **static DHCP reservation** on the router, so the
   address does not move between sessions.

### What deferring hosting must not defer

| | Why |
|---|---|
| **Keep the adapters** (§7) — `lib/realtime/*`, `lib/auth/*`, standard Postgres only | The whole point. Local Supabase → any host is `supabase db push` |
| **The `plpgsql` transitions decision (§3) stands** | It is better regardless of host, and it is identical locally and deployed |
| **Deploy once, early, to a throwaway environment** | "Works on my machine" is a real risk here. Realtime latency, certificate behaviour, PWA install from a real origin and printing all differ once deployed. Do it around M4, not at M9 |
| **Backups are practised locally too** | The restore drill (§5) is a habit, not a deployment step |

The hosting conversation then happens with a working system in the room, which
is a much better conversation than this document alone.

---

## 2. The stack

| Layer | Free choice | Ceiling | Headroom for this clinic |
|---|---|---|---|
| App hosting | **Cloudflare Workers / Pages** | commercial use explicitly permitted; 100k req/day | ~2k req/day expected. 50× |
| DB + Auth + Realtime | **Supabase free, ap-south-1 (Mumbai)** | 500 MB DB · 200 realtime conns · 50k MAU | see §4. Two years, with one design rule |
| Server-side logic | **Supabase Edge Functions** | 500k invocations/month | ~15k/month. 30× |
| Scheduled jobs | **pg_cron** in-database | none meaningful | nightly reconcile, 8am digest |
| Backups | **GitHub Actions → Cloudflare R2** | 2,000 min/mo · 10 GB R2 | §5. Uses ~600 min, ~2 GB/yr |
| Errors | **Sentry free** | 5k errors/month | fine, and if we exceed it we have worse problems |
| Uptime alerts | **UptimeRobot free** | 50 monitors, 5-min checks | 3 monitors |
| **Total** | | | **₹0/month** |

Data residency is preserved — Supabase ap-south-1 is Mumbai, so the DPDP
argument in `PLAN.md` §15.1 is unchanged by going free.

### Why not Vercel Hobby

The obvious free choice is ruled out on licence, not on limits. Vercel's fair
use guidelines restrict Hobby to non-commercial personal use, and define
commercial usage to include **"a paid employee or consultant writing the
code."** A freelancer build for a paying clinic is commercial on that
definition even before the clinic bills a patient. Hobby is not an option here;
Pro is ₹1,700/month.

Cloudflare's Workers free plan, by contrast, **permits commercial products
outright**. That single ToS difference is why the app moves off Vercel.

---

## 3. What free forces — and why it makes the build better

Cloudflare's free plan caps a Worker at **3 MiB compressed**. A full Next.js
server bundle with the Supabase client and every route handler will fight that
limit and eventually lose.

So the architecture changes shape:

```
BEFORE (paid assumption)          AFTER (free)
────────────────────              ────────────
Next SSR on Vercel                Next, mostly client-rendered, static on Cloudflare
  ↓ server actions                  ↓ direct, RLS-enforced
lib/db/* (TypeScript)             Postgres RPC — plpgsql, SECURITY DEFINER
  ↓                                 ↓
Supabase                          Supabase (same DB, same Realtime)

WhatsApp webhook: Next route      WhatsApp webhook: Supabase Edge Function
Cron: Vercel Cron                 Cron: pg_cron + pg_net
```

**The part that is genuinely better.** `PLAN.md` §5.3 rules 2 and 3 — one
writer, in a transaction, with its audit row — were previously enforced *by
convention*: a TypeScript function everyone agreed to route through. Nothing
stopped a future edit from writing around it.

Moving the twelve money-and-stock transitions into `plpgsql` functions with
`SECURITY DEFINER`, and revoking direct write grants on those tables, means
**the database refuses** the bypass. Dispense, counter sale, GRN, adjustment,
stock-take post and the six PO transitions become atomic by construction. An
audit row is not something the caller remembers to write; it is inside the
function.

| | Cost | Benefit |
|---|---|---|
| 12 transitions in plpgsql, not TS | +4 days · pgTAP tests instead of Vitest · worse DX | Rules 2 and 3 become impossible to break, not merely discouraged |

Recommendation: **do it.** Reads and simple writes stay client-side under RLS;
only the transitions that move money or stock go into the database. This is the
right split anyway — the free constraint just forced us to find it.

---

## 4. Will 500 MB hold? Yes, with one rule

Two years, at the clinic's own numbers (~60 consults/day, 300 days/year):

| Table | Rows in 2 yrs | Est. size |
|---|---|---|
| `audit_log` | 240,000 | **96 MB** ← the driver |
| `consultations` | 36,000 | 36 MB |
| `stock_movements` | 150,000 | 37 MB |
| `prescription_lines` | 144,000 | 29 MB |
| `messages` | 60,000 | 18 MB |
| patients, drugs, batches, suppliers, POs | — | ~10 MB |
| Indexes (~40%) | | ~90 MB |
| **Total** | | **~316 MB** |

Comfortable, but `audit_log` decides it. **The rule: audit rows store the
changed fields only, never a full row snapshot.** Snapshotting every write
triples the number above and puts the ceiling inside 18 months.

Second lever, if it is ever needed: archive `audit_log` and `stock_movements`
older than 12 months to R2 as compressed JSONL, keeping a queryable summary in
Postgres. The registers under `PLAN.md` §15.2 are the legal retention
obligation and they are far smaller than the raw log — nothing legally required
leaves the database.

No files are stored in v1 (document upload is out of scope, §2), so the
separate 1 GB storage quota is untouched. Prescriptions and bills render to
print on demand rather than being stored as PDFs.

---

## 5. The backup rig — the part we build because free removes it

Supabase free has no PITR and no downloadable backups. This is the single
serious gap, and it is entirely fixable.

| | Design |
|---|---|
| **What** | `pg_dump` of the whole database, gzipped, age-encrypted |
| **Where** | Cloudflare R2, 10 GB free, zero egress |
| **When** | Hourly during clinic hours, plus one nightly full |
| **Retention** | 24 hourly · 30 daily · 12 monthly |
| **Runner** | GitHub Actions cron — ~1 min/run, ~600 of 2,000 free minutes |
| **Worst-case loss** | **≤ 1 hour** of consults and dispenses |
| **Proof** | Weekly automated restore into a scratch Supabase project, row counts asserted, failure pages Venu |

A backup that has never been restored is a belief, not a backup. The weekly
restore test is not optional garnish — it is the thing that makes the rest of
this document honest.

**Keep-alive.** Supabase free pauses a project after 7 days with no database
request. A daily clinic will never hit that, but a Diwali closure plus a weekly
off could. The same GitHub Actions workflow pings the database daily, so the
pause window is never approached.

**Monitoring.** UptimeRobot on three URLs — the app, the `/now` status page,
the WhatsApp webhook. Sentry on the client. Both free, both alerting to Venu,
because nobody will be sitting in the clinic when it breaks.

---

## 6. What is not free, and cannot be made free

| Item | ₹/month | Why it resists |
|---|---|---|
| **WhatsApp messages** | 300–800 | Meta charges per template. Paid by the clinic to Meta directly |
| **4G router backup** | ~300 | `PLAN.md` §5.2 prerequisite. A clinic expense, not a hosting one |
| **Domain (.in)** | ~70 | Optional — a `*.pages.dev` URL is free and works |
| **Total** | **~370–870** | Down from ~₹4,700 in `PLAN.md` §17 |

On WhatsApp: the design already exploits the one free lane Meta leaves open —
patient-initiated service messages inside the 24-hour window cost nothing
(`WHATSAPP.md` rule 6), and supplier orders in deep-link mode cost nothing at
all. What remains is genuinely unavoidable.

On the domain: worth the ₹70. A QR code on the clinic door pointing at
`clinic-platform-a7f.pages.dev` undoes some of what the build is for. This is
the one line item to argue for.

**Hosting itself is ₹0, permanently, at this clinic's scale.**

---

## 7. The exit ramp — the reason free is safe here

Free tiers get cut. Two days from now, on **18 August 2026**, Oracle halves its
Always Free ARM allowance from 4 OCPU / 24 GB to 2 / 12, and terminates
instances above the new ceiling. Anyone who put a business on it is migrating
this week.

So the rule is: **nothing in this build may depend on a free tier's
particulars.**

| Guarantee | How |
|---|---|
| Standard Postgres only | No Supabase-proprietary SQL. `pg_dump` restores anywhere |
| Realtime behind one adapter | `lib/realtime/*` — swap for a WS server without touching a screen |
| Auth behind one adapter | `lib/auth/*` |
| Build output is standard Next | Deploys to Vercel, a VPS or Cloudflare unchanged |
| Backups already off-platform | R2 dumps are the migration artefact, already tested weekly |

**Escalation, if free ever stops being viable:**

| Trigger | Move | Cost | Effort |
|---|---|---|---|
| DB approaching 400 MB | Supabase Pro (PITR arrives with it) | +₹2,100/mo | 1 hour |
| Cloudflare limits or ToS change | Vercel Pro | +₹1,700/mo | half a day |
| Both, or a demand for full control | Mumbai VPS, all of it | ~₹1,200/mo | 1 day |

Every row is a configuration change. None is a rewrite. That is what makes
starting free defensible rather than reckless.

---

## 8. Re-verify before the contract is signed

Same discipline as `WHATSAPP.md` §10 rule 10.

- [ ] Cloudflare Workers free still permits commercial use, still 3 MiB
- [ ] Supabase free still 500 MB, still ap-south-1, still pauses at 7 days
- [ ] Supabase Edge Functions still 500k/month free
- [ ] GitHub Actions still 2,000 private minutes
- [ ] R2 still 10 GB, still zero egress
- [ ] Meta's India rate card, for the §6 number

---

## 9. What the doctor has to accept, in writing

Free is his saving — ~₹4,300/month against the paid design — so the risk is his
to accept, explicitly, not something to be absorbed quietly on his behalf.

1. **No vendor SLA.** If Supabase or Cloudflare has an incident, there is no
   support ticket that makes it go faster. `PLAN.md` §5.2 fallback applies:
   paper prescriptions, backfilled after.
2. **Up to one hour of data loss** in a total-loss scenario, versus the
   five-minute PITR window a paid plan would give.
3. **Free tiers can change.** If one is withdrawn, §7 is the plan, and the
   migration is billable time.

If any of the three is unacceptable to him, the answer is Supabase Pro alone —
₹2,100/month buys PITR and an SLA on the half that actually matters, while
hosting stays free on Cloudflare. That is the middle option, and it is a good
one.

---

## Sources

Vendor pricing pages are the only authority; re-check them at §8 before signing.

- [Vercel Hobby — commercial use limits (2026)](https://www.promptstoproduct.com/vercel-free-tier-limits)
- [Vercel Hobby — what counts as commercial](https://zplatform.ai/guides/is-vercel-free/)
- [Cloudflare Workers pricing (official)](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers free — commercial use permitted, 3 MiB](https://www.morphllm.com/comparisons/cloudflare-workers-vs-vercel)
- [OpenNext for Cloudflare (1.0 GA, Feb 2026)](https://opennext.js.org/cloudflare)
- [Supabase free tier — 500 MB, pause, no backups (2026)](https://www.itpathsolutions.com/supabase-free-tier-limits)
- [Supabase Realtime limits (official)](https://supabase.com/docs/guides/realtime/limits)
- [Cloudflare R2 free tier — 10 GB, zero egress](https://www.cloudflare.com/products/r2/)
- [GitHub Actions billing (official)](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions)
- [Oracle Always Free ARM halved, 18 Aug 2026](https://zeli.app/en/story/49183750)
- [Oracle — idle instance reclamation (official)](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
