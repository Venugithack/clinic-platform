# Next session — 29 Aug 2026 (small hours)

**Audience: you only.** The previous version of this file was written on 27 Aug
and was overtaken within a day: 117 commits arrived from the other device, the
auth model was replaced twice, and CI stopped running without saying so. This is
what replaced it.

**The app is live.** https://app.jayamuruganclinic.online

---

## 1. Where things stand

| | |
|---|---|
| App | Cloudflare Workers, static export, builds `main` automatically |
| Repo | **Now PUBLIC** (`Venugithack/clinic-platform`) — done deliberately, see §3 |
| Database | Supabase `quqygjzcvtpnhhsfsora`, ap-south-1. **47 migrations local, 36 pushed — 11 owed** |
| Backups | Working again, verified 28 Aug: `pg_dump·age·R2` 1m18s, restore drill 1m28s |
| CI | Runs again. `main` is **red** until the working tree below is committed |
| Local gates | typecheck ✅ lint ✅ 69 unit ✅ 33/33 pgTAP ✅ — all verified locally |
| Clinic data | Real medicine master (82). **No stock, no supplier links, no opening hours** |

**The working tree is uncommitted**: 32 files changed, +492/−37, plus one new
file `lib/whatsapp/index.test.ts`. Nothing has been pushed. That is the first
decision waiting for you.

---

## 2. The auth model is not the one you remember

Device trust is **gone**. It was replaced twice on 27 Aug — first by email device
trust (PR #27), then about three hours later by PR #29, which is what is live:

- **Owner** = verified Supabase email OTP, bound to the administrator staff row.
- **Everyday staff** = name + 6-digit PIN from any browser. No registration, no
  device. `app.unlock_pin` is SECURITY DEFINER, granted to `anon`, rate-limited
  in Postgres via `staff.pin_failed_attempts` / `pin_locked_until`.
- `staff_sessions.device_id` is now nullable.

**`app.current_staff_id()` changed underneath everything.** Its `auth.uid()`
fallback now requires `role = 'admin'`; every other role must arrive with an
`app.staff_session` token. That one clause is what broke 21 of 33 pgTAP files —
see §4.

**Undocumented production blocker:** `app.first_run_owner` raises `CL005` unless
the email already exists in `app.bootstrap_owner`. Nothing seeds that table — no
migration, no script, no doc, only the pgTAP fixture. It is
`revoke all … from public, anon, authenticated`, so it needs the SQL editor.
**`GO_LIVE.md` §5 does not mention this and still says "Register the first clinic
tablet".** Fix the runbook before go-live.

---

## 3. CI and backups had stopped, silently

Every Actions job refused to start from 27 Aug 15:00 UTC: *"recent account
payments have failed or your spending limit needs to be increased."* A billing
block, not broken code.

It cost more than it looked. **PRs #29–#33 — the whole auth rework, 35 commits —
merged with no CI at all**, and `backup.yml` runs in Actions, so the hourly
backup series has a permanent ~26-hour hole in it.

**Resolved by making the repo public** (free unlimited Actions), after a clean
audit: no secrets anywhere in full history, no real `.env` ever committed, `out/`
untracked, the Supabase project ref in no tracked file, `ci.yml` uses no secrets,
and `backup.yml` is `schedule`/`workflow_dispatch` only — so fork PRs cannot
reach the R2 or DB credentials. No `pull_request_target` anywhere; keep it that
way.

**Still open: `main` has no branch protection**, and now anyone can open a PR.
Worth a required-CI rule now that CI is free.

---

## 4. What the first restored CI run found

It failed, and both failures were real staleness the rework left behind.

**`scripts/dev-stack.sh`, one word.** It required PostgREST to expose `unlock`,
which `20260827224500` revokes from `authenticated`; PostgREST only publishes
what the role may execute, so the stack aborted before Chromium installed. Now
requires `unlock_pin`. *Ignore the log's "schema cache is stale" hint — it is a
red herring here.*

**21 of 33 pgTAP files.** Pre-rework fixtures set the actor with
`set_config('request.jwt.claim.sub', …)` and no session, so every non-admin
resolved to NULL and raised `CL005 no active staff member is signed in`. Fixed by
seeding a session per staff row and pairing every actor switch with its token:

```sql
insert into staff_sessions (staff_id, token_hash, expires_at)
select id, encode(digest('sess-' || auth_user_id::text, 'sha256'), 'hex'),
       now() + interval '10 hours'
  from staff where auth_user_id is not null;
```

**The session branch is checked *before* the `auth.uid()` one**, so a stale token
silently impersonates the previous actor — the two must always move together.
`A2_presence` was the exception; it manages its own tokens and deliberately
clears the session, so it needed one line.

**Then a second bug surfaced underneath the first.** With CL005 gone, three files
went red at IST midnight: `40_clinic_core`, `90_expiry_returns`, `A2_presence`.
They write `current_date` (UTC on CI) and assert against `app.clinic_today()`
(clinic-local). They pass 18½ hours a day and fail **18:30–24:00 UTC** — the same
divergence as the old H1 register specs. `A2_presence` already carried the fix on
*one* test, with a comment explaining exactly this; it had never been carried to
the rest of the file. All 11 occurrences now use `app.clinic_today()`, verified
green at **19:11 UTC — inside the window that broke them**.

> Lesson worth keeping: fixing one layer of staleness exposed the next. Re-run
> the suite **after 18:30 UTC** before believing it is green.

---

## 5. Driving the live app as all four roles

Signed in as admin, doctor, nurse and pharmacy (**all four share PIN 120203** —
which `GO_LIVE.md` §9 forbids in production, because per-staff PINs are what the
audit trail rests on). Ran a full journey: register → consult → diagnosis →
signed Rx → pharmacy queue. **The chain works.** Role-adapted UI on one `/queue`
route is genuinely well done.

### Fixed this session

| | |
|---|---|
| `/admin` had no guard | Added the mirror of the admin guard; non-admins go to their own home. *(The Reset PIN / Deactivate buttons were already `disabled` — the exposure was the roster, and the asymmetry.)* |
| Supplier WhatsApp numbers | `isDeliverable()` / `numberProblem()` in `lib/whatsapp` + **8 new unit tests** for a module that had none. Enforced on the Suppliers form, and in Orders **before** the PO is numbered |
| Rx registration number | Not a template bug — **two** fields exist. Settings' "Doctor registration number" feeds *bills*; the Rx reads `staff.reg_no`, blank for Dr.Boopathi. `encounters.ts` now falls back to the clinic's |
| Device wording | "This tablet cannot scan" → "This device…", "Lock tablet" → "Sign out", "People & tablets" → "Staff access", "every clinic tablet" → "every clinic screen", Suppliers' "Back to queue" → "Control panel" (it pointed where the guard forbids) |
| Silent PIN mismatch | Says "The two PINs do not match" once the second box has six digits |
| Add-staff default | No longer defaults to Pharmacy/Counter — an explicit choice |

### Found, not fixed

- **Your three supplier numbers are still wrong in the database** — cipla
  `6383187889`, FDC `9360976118`, sun pharama `7904194033`, all missing `+91`.
  Validation only guards writes; Orders now flags them. **I did not auto-prefix
  91** — guessing a country code could send a real order to a stranger.
- **Duplicate supplier**: "sun pharama" and "Sun Pharma". Needs a merge decision.
- **No cross-check between dosing and quantity** — "1 · 1-0-1 · 5 days" accepted
  with Qty 1. Quantity starts at 0 and must be typed.
- OUT-of-stock shows in medicine search but not in the prescribing editor.
- Vitals can be recorded after a visit is DONE, with no sign it is closed.
- No way to rename staff — your admin is named "Jayamurugan Clinic" permanently.
- Medicine search is a full-screen takeover that hides all patient context.
- Nurse can view `/consult` (diagnosis + prescription). The diagnosis box renders
  on a signed visit but is **inert** — tested, it does not write.

### Go-live data gaps

Opening hours are **empty for all seven days**, and the settings page itself
warns the hours drive the public page — so it currently reads closed every day.
No address, no phone, consultation fee ₹0. 82 medicines but **no stock** and **no
medicine→supplier links**, so reorder/PO cannot route anything yet.

**Test data to clean up:** patient "QA Walkthrough Patient" (9876500011, token 1,
29 Aug), diagnosis "Viral fever", signed Rx Dolo 650 qty 1, vitals
128/84 · 96 · 101.2 °F · 97%.

---

## 6. Next, in order

1. **Commit the working tree to a branch and push** — CI is free now and this is
   the last thing standing between `main` and green.
2. **The E2E suite has never run against the new auth.** 21 of 24 specs sign in
   with `localStorage['clinic.deviceToken']`, which PR #29 deleted from the app
   entirely. Expect that to be the next red.
3. `supabase db push` — 11 migrations owed. Blocked by the auto-mode permission
   classifier, so run it yourself:
   `! ./node_modules/.bin/supabase db push`
4. Fix `GO_LIVE.md` §5 — drop tablet registration, document the
   `app.bootstrap_owner` seed. This is the actual go-live blocker.
5. Add branch protection requiring CI.
6. Fix the three supplier numbers, and give staff real individual PINs.

---

## 7. Local machine, as left

Docker Desktop is **running** and the Supabase stack is **up**. `supabase db
reset` brought the local DB from 36 to 47 migrations and re-seeded it. A scratch
database **`clinic_ci`** is still in the container — that is the CI-shaped bare
cluster the pgTAP runs used; drop it whenever.

**How to run pgTAP on Windows** (the bash db scripts are Linux-only): create
`clinic_ci`, pipe all migrations in filename order through
`docker exec -i supabase_db_clinic-platform psql -U postgres -d clinic_ci -X -q
-v ON_ERROR_STOP=1 --single-transaction -f -`, add `pgtap`, then pipe each test
file the same way. The first migration creates its own roles, `auth` schema and
extensions, so this reproduces CI exactly. **Create `schema_migrations` by hand
or `A5_permissions` test 5 fails** — that one is the harness, and A5 is green in
CI.

A stale `.next/` makes `pnpm typecheck` invent "not assignable to type `Route`"
errors for routes added since it was generated. Delete it before believing them;
CI checks out fresh, which is why it never sees them.
