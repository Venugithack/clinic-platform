# Rollout

**Jayamurugan Clinic — Slices 2.1.1 to 6**
**Written 12 September 2026, brought up to date 27 October 2026. Nothing in it
has been run against the clinic.**

This is the operating document for taking the work in this branch to the clinic:
what to check before, what to run, what to check after, and what to do when it
goes wrong. It is deliberately not a summary of the slices — `SCHEMA_AND_TYPES.md`
is that — and it assumes the reader is at a terminal with the clinic's database
in front of them and the pharmacy closed.

Read §1 before doing anything else.

---

## 1. What is and is not true today

| | |
|---|---|
| Branch | `slice-0-staging-foundation` |
| Pushed | **Yes**, on 26 October 2026, and proposed for `main` as a pull request. Merging it deploys nothing: no workflow deploys, and both halves go out by hand (§3). |
| Deployed | **No.** No migration has been applied to the clinic, no function deployed, no secret changed. |
| What the clinic runs | `main` as of 9 September 2026. Checked from outside on 27 October 2026, without signing in: the page at `app.jayamuruganclinic.online` carries none of this branch's screens, and of the sixteen functions only `main`'s nine answer — `workspace`, `inventory`, `reports`, `results` and `images` return *not found*. The database should therefore hold `main`'s nine migrations; preflight §2 is what confirms it. |
| Verified | On guarded local staging: a disposable PostgreSQL 17, synthetic fixtures, and the real code. |
| Not verified | Anything that needs the clinic's own data, a real printer, real tablets on clinic Wi-Fi, Supabase's Storage bucket policy, a CI runner, or the clinic accountant — the recovery/write-off workflow for a bill under financial review (over-refunded, or cancelled and not at ₹0, which is also what the refusals on a voided bill wait for) and the GST credit/debit-note treatment are theirs to settle and neither has been read by one. §7 lists every one. |

Applied migrations are immutable. Everything here is forward-only.

---

## 2. Before anything: the preflight

**Run these against production. Every one is a COUNT and reads nothing
identifiable.** They exist to turn "this should be fine" into a number, and two
of them decide how long the cutover takes.

```sql
-- ── 1. How much history each backfill has to work through ─────────────────
select
  (select count(*) from jmc.prescriptions)            as prescriptions,
  (select count(*) from jmc.bills)                    as bills,
  (select count(*) from jmc.otc_sales)                as counter_sales,
  (select count(*) from jmc.batches)                  as batches,
  (select count(*) from jmc.stock_movements)          as stock_movements,
  (select count(*) from jmc.medicines)                as medicines,
  (select count(*) from jmc.encounters)               as encounters;

-- ── 2. THE ONE THAT DECIDES THE TIMETABLE ────────────────────────────────
-- Every prescription line nobody can read. Each needs a DOCTOR, one at a
-- time, and the pharmacy cannot supply any of them until it has been done.
-- Five is an afternoon. Five hundred is a different plan.
select medicine_state, quantity_state, count(*)
  from jmc.prescription_lines group by 1, 2 order by 3 desc;

-- If `jmc.prescription_lines` does not exist yet, Slice 2 has not been
-- applied and this is the same question asked of the JSON it is built from:
select
  count(*) filter (where not exists (
    select 1 from jmc.medicines m where m.id = item->>'medicineId')) as medicine_gone,
  count(*) filter (where (item->>'quantity') !~ '^[1-9][0-9]*$')     as quantity_unreadable,
  count(*)                                                           as items_total
from jmc.prescriptions p
cross join lateral jsonb_array_elements(p.items_json::jsonb) item;

-- ── 3. Money that will be carried across ─────────────────────────────────
select status, count(*), sum(amount) from jmc.bills group by 1;

-- ── 4. The setup work the clinic owes, which blocks the counter ──────────
-- An unclassified medicine cannot be sold anonymously. A medicine with no
-- verified package cannot receive stock. Both are refusals staff will meet on
-- day one if these are not zero.
select
  count(*) filter (where schedule = 'unset' or schedule_verified_at is null)
    as unclassified,
  count(*) as active_medicines
from jmc.medicines where active = 1;

-- ── 5. Does the shelf already disagree with the ledger? ──────────────────
-- If this is not zero BEFORE the migration, it was not zero after it either,
-- and the opening count is the thing that fixes it — not a migration.
select count(*) from jmc.batches b
  where b.available_quantity <>
        coalesce((select sum(m.quantity_delta) from jmc.stock_movements m
                   where m.batch_id = b.id), 0);

-- ── 6. Who can let everybody else back in ────────────────────────────────
-- Policy register, item 4. Never infer this role and never grant it silently.
select count(*) from jmc.staff where active = 1 and roles_json like '%"admin"%';

-- ── 7. What the database will actually let the application do ────────────
-- docs/SCHEMA_AND_TYPES.md §7.4: the deployed role's attributes have never
-- been read, because nothing in this programme queries production.
select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
  from pg_roles where rolname = current_user;

-- ── 8. The one guard that can stop the push on the clinic's own data ─────
-- 20260920000000 refuses to apply while two OPEN visits share a queue token.
-- Run this again just before `supabase db push`, with the queue closed for
-- the day; it must be empty. Finished and cancelled visits do not count.
select token, count(*) from jmc.appointments
 where status in ('waiting', 'in_consult') group by 1 having count(*) > 1;

-- ── 9. Which migrations the clinic actually has ──────────────────────────
-- Expect main's nine, ending 20260909125237. §3 applies everything after.
select version from supabase_migrations.schema_migrations order by 1;
```

Write the answers down. §6 compares against them.

---

## 3. Applying it

Twenty-one migrations — everything after `main`'s last,
`20260909125237_harden_active_clinic.sql` — in this order, each once:

```text
20260910120000_pin_format.sql
20260910130000_vitals_not_measured.sql
20260911045325_slice2_doctor_nurse_workspaces.sql
20260911120000_slice2_clinical_vocabulary.sql
20260911190000_slice2_1_unresolved_prescription_history.sql
20260911210000_slice2_1_1_resolution_scope.sql
20260912000000_slice3_identity_packages_stock.sql
20260913000000_slice4_dispensing_billing_payments.sql
20260914000000_slice5_clinical_images.sql
20260915000000_financial_edge_states.sql
20260916000000_void_balance_and_review_queue.sql
20260917000000_staff_theme_and_draft_follow_up.sql
20260918000000_consultation_idempotency.sql
20260919000000_slice1_read_model_indexes.sql
20260920000000_slice2_appointments_and_reconciliation.sql
20260921000000_slice2_acceptance_correction.sql
20260922000000_same_attendance_closes_the_visit.sql
20260923000000_a_reconciled_visit_stays_reconciled.sql
20260924000000_slice3a_communication_truth.sql
20260925000000_slice3b_provider_events.sql
20260926000000_slice4_diagnostics.sql
```

If preflight 9 shows the clinic somewhere other than `main`'s nine, apply from
wherever it actually is.

**Every one must run inside a transaction**, so that a file which fails halfway
leaves nothing behind.

Ten of the twenty-one begin with `set local search_path = jmc` — the first
three, and every one from `20260920000000` on. That line is the reason the
transaction rule was written down: `SET LOCAL` outside a transaction block does
nothing at all, and Postgres warns and then creates the tables in `public`,
where the retired application lives and eight table names collide exactly.
`supabase db push` wraps each file, and the clinic's own nine went in that way
and landed in `jmc`; nothing else is guaranteed to. Do not paste these files
into the SQL editor. `docs/operations/STAGING.md` §3.1 is the long version.

A transaction per *file* is not one transaction for the push. If a file
refuses, the files before it stay applied and the ones after it do not, and the
clinic is then half-migrated under functions that expect either all of it or
none. Of every refusal in these twenty-one, exactly one can meet the clinic's
own data: `20260920000000` stops if two open visits share a queue token. The
others guard tables that arrive empty in this same push. Preflight 8, run with
the queue closed, is what makes that one impossible.

Then, in this order, with the clinic closed:

```bash
# Rehearse first. Not optional. This applies every migration above to a
# representative history; it is not the clinic's own data.
npm run staging:rehearse

# With a backup taken and verified in the last hour, and preflight 8 empty.
# The dry run lists what will be applied; it must be exactly the list above.
npx supabase db push --project-ref <ref> --dry-run
npx supabase db push --project-ref <ref>

# The fourteen functions a person uses. `whatsapp` and `worker` wait for §9.
# --no-verify-jwt is NOT optional — see below.
npx supabase functions deploy --project-ref <ref> --no-verify-jwt \
  bootstrap command csv images inventory login logout record register \
  reports results snapshot staff workspace

# The page last, built against the clinic's functions — not the staging URL,
# which is what everything else in this repository builds against — and
# checked before it is uploaded.
NEXT_PUBLIC_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1 npx next build
grep -rl "127.0.0.1" out/ && echo "STOP: out/ points at staging" || npx wrangler deploy
```

**`--no-verify-jwt` on every deploy.** Without it Supabase's gateway demands a
Supabase-issued JWT before the request reaches the function, and this
application never sends one: the bearer token is the clinic's own session
(`docs/README.md` §1). Every tablet would be refused at the gateway with the
functions themselves never running — the whole clinic signed out at once. The
deployed functions run with the check off; that was confirmed from outside on
27 October 2026, when an unauthenticated request to `snapshot` was answered by
the function's own *Sign in required* rather than by the gateway. There is no
`supabase/config.toml` to carry the setting, so the flag on the command is the
only thing that does.

The page goes last, straight after the functions. The new page calls five
functions the old backend does not have, so it must never be live before them;
with the clinic closed nobody is using the old page in the minutes between.

### What each migration does to existing rows

| Migration | Touches history |
|---|---|
| PIN format | Adds `staff.pin_format` and marks every existing account `legacy_six`, so everyone keeps the PIN they have until they are reset (§4.1). No PIN is changed. |
| Vitals not measured | Lets each of the five readings be empty, turns blank `bp` strings into NULL, and adds a check that a vitals row holds at least one reading. Every existing row already does: the other four columns were `not null` until this file. |
| Slice 2 workspaces | Gives the existing doctor-and-admin account the clinic-template publishing flag. Numbers every existing prescription `RX-000001` upwards in signing order. Builds `prescription_lines` from `items_json` beside it and leaves the JSON — the signed record — untouched. Twelve new tables. |
| Slice 2 vocabulary | Seeds the owner-approved starter phrases as release `en-2026.09`. Touches no existing row. |
| Slice 2.1 | Any prescription item whose medicine no longer exists, or whose quantity cannot be read, becomes an explicit unresolved line instead of a guess. Those lines are preflight 2's count and §4.6's work for a doctor. |
| Slice 2.1.1 | Nothing. Adds a trigger and asserts no existing resolution is out of scope. |
| Slice 3 | Converts **every money column** from `real` to `numeric(12,2)`, rounding to the paisa. Gives every batch and medicine a base unit, taken from the `unit` column that quantity was always counted in. Adds no package to any existing batch — inventing one would be a guess frozen onto the batch. |
| Slice 4 | Gives every prescription a `valid_until` of signing + 7 days. Moves every `bills` row into an invoice, a line and (where paid) a payment; **empties `jmc.bills` and leaves it standing** as a tombstone. Sets the clinic consultation fee to ₹300 only where none is configured. Builds `otc_lines` from `lines_json`. |
| Slice 5 | Nothing. New tables only. |
| Theme and draft follow-up · consultation idempotency · read-model indexes | New columns with defaults, a unique index on a column that arrives empty, and seven ordinary indexes. No existing value changes. |
| Appointments and reconciliation | Five new tables, and a unique index on the token of every **open** visit. **Refuses** if two open visits share a token — preflight 8. Finished and cancelled visits are left exactly as they are. |
| Acceptance correction · same attendance · reconciled visit | Triggers, functions, one new table and two new columns. The one `update` touches `appointment_bookings`, which is empty in the clinic until this push, and the two refusals guard tables that are too. |
| Slice 3B (provider events) | **Nothing.** One new table, empty. |
| Financial edge states | **Nothing, and that is the point.** Views only: `invoice_balances` and `patient_balances` are replaced and `financial_review_queue` is created. No table, column, constraint or row is touched. Any over-refunded bill it puts on the queue was already over-refunded before it ran; what changes is that the application can now say so. |
| Slice 3A (communication truth) | **Nothing.** Five new tables and two trigger functions; no existing table, column, index or row is touched, and **nothing is backfilled** — least of all a consent. `patients.whatsapp_consent` names no purposes, so it is not per-purpose consent and turning it into one would be inventing evidence about what patients were told. The five tables therefore arrive empty and stay empty until somebody records an opt-in and a doctor approves a wording. Nothing in this release sends a message, so there is no cutover step and no staff instruction that goes with it. |
| Slice 4 (diagnostics) | **Nothing.** Six new tables, one sequence, and a widened value list: `result_ready` is admitted to the purpose check on four Slice 3A tables, `result_ready` to the schedule kinds, `investigation_result` to the source types, and two suppression reasons to the outbox. Widening a check admits a value and changes no existing row. **Nothing is backfilled** — there is no investigation in this clinic's past to migrate, and turning a clinical image into a result would invent evidence. The six tables arrive empty and stay empty until a doctor approves a catalogue entry. Note the name collision in this table and nowhere else: this row is the **backend programme's** Slice 4, `20260926000000`; the row above it is the original dispensing Slice 4, `20260913000000`. |
| Void balance and review queue | **Nothing either, and for the same reason.** Views only: `invoice_balances` and `patient_balances` are replaced again, and `financial_review_queue` is **dropped and rebuilt** — its `over_refunded_by` column is gone, replaced by `review_state`, a signed `paid` and `out_of_balance`. No table, column, constraint or row is touched. Any cancelled bill it puts on the queue was already off zero before it ran. The drop takes the view's grants with it, so the migration re-states the `revoke` rather than assuming it survived — §6's last query is the one that proves it did. |

The `valid_until` backfill deserves a sentence: every existing prescription is
long past signing + 7, so on the morning after the migration the pharmacy
cannot supply a remainder against any of them. That is correct — it is the rule
the clinic chose — and it is also a thing staff will meet, so tell them before
they meet it.

---

## 4. The setup the clinic has to do, in order

Nothing below can be done for them, and the counter is partly refused until it
is.

1. **Reset the PINs.** `docs/operations/PIN_RESET_RUNBOOK.md`. Confirm an admin exists
   first (preflight 6). Until a staff member is reset they keep their
   six-digit PIN; the legacy count must reach zero before six-digit
   compatibility comes out of the code.
2. **Classify every medicine.** Formulary → each medicine → Classification.
   Until then it is `Unknown — pharmacist review required` and the anonymous
   counter path refuses it. The Package audit report lists what is left.
3. **Build and verify a package for every medicine that will receive stock.**
   Formulary → Build a package → Verify against the pack. A draft cannot
   receive stock; that is the control, not an obstacle.
4. **Map the barcodes** that exist. Unknown scans queue for an admin.
5. **Do the blind opening count**, after closing. Pharmacist counts without
   seeing the expected figure; admin reviews the variances; approved
   differences post as append-only opening adjustments. This is what makes
   preflight 5 zero.
6. **Clear the doctor review queue.** Consult → Review queue. Every unreadable
   line, one at a time, by a doctor. Preflight 2 said how many.

---

## 5. The parallel period

The owner's condition, and the brief's: run paper and system side by side and
reconcile daily **before** cutover. Every figure below has a report behind it.

| Reconcile daily | Report | Against |
|---|---|---|
| Stock on hand | `stock_on_hand` | The shelf, spot-checked |
| Stock movements | `stock_movements` | The day's receipts and sales |
| Consultation fees | `consultation_fees` | The doctor's own count of visits |
| Medicine and counter sales | `sales` | The paper bill book |
| Cash, UPI and card | `payments` + Day book | The drawer and the UPI statement |
| Patient dues | `patient_dues` | The credit register |
| Outstanding prescriptions | `outstanding_prescriptions` | What is waiting behind the counter |
| Over-refunded bills | `financial_review`, rows reading `over_refunded` | The refund receipts and the drawer/UPI statement they went out on. Not a counter's to clear: the admin or accountant, and §8 |
| Cancelled bills not at ₹0 | `financial_review`, rows reading `void_with_balance` | The void reason and every receipt behind the bill. `paid` is signed: above zero is money the clinic is holding against a bill it says was never owed, below zero is money refunded past one. Neither is a counter's to clear either |

A day that does not reconcile is a day to stop and find out why, not a day to
carry forward.

The last two lines are the exception to that instruction, and only that far: a
row on `financial_review` is not a day's reconciliation failure to be chased
before closing. It is a bill whose money does not agree with the document it is
attached to — more went out than came in, or it was cancelled and did not land
on zero — it may well be older than the system, and it stops being the counter's
business the moment it appears. Note it, carry the day forward, and give it to
whoever keeps the books. `review_state` on the row says which of the two it is,
so nobody has to work it out from the sign of a number.

---

## 6. After the migration: the same questions again

```sql
-- Nothing was dropped on the floor.
select count(*) from jmc.prescription_lines;                 -- >= items_total
select count(*) from jmc.invoices;                           -- = bills
select coalesce(sum(amount), 0) from jmc.invoice_lines;      -- = sum(bills.amount)
select count(*) from jmc.bills;                              -- 0, emptied on purpose

-- The shelf still agrees with the ledger.
select count(*) from jmc.batch_ledger_reconciliation
 where available_drift <> 0 or quarantine_drift <> 0 or blocked_drift <> 0;   -- 0

-- Nobody was ever given more than was prescribed.
select count(*) from jmc.prescription_line_supply
 where supplied > coalesce(effective_quantity, 0);                            -- 0

-- No encounter carries two consultation fees.
select count(*) from (
  select encounter_id from jmc.invoice_lines
   where source = 'consultation_fee' group by 1 having count(*) > 1) d;       -- 0

-- No bill has had more money taken back out of it than ever went in, and no
-- cancelled bill is off zero. Two different wrongnesses, and four figures: one
-- for each, then their union, then the queue that has to equal the union.
--
-- `paid` below zero and a `due` larger than the bill are the same fact said
-- twice, which is why the first figure asks for both: if they ever disagreed
-- the arithmetic in the view would be broken, not the data. The second is the
-- voids that did not land on zero in EITHER direction — above zero is money
-- held against a bill that says nothing was owed, below zero is money refunded
-- past one — and since a void is only ever permitted at exactly ₹0, any of
-- these came out of the carried-over history rather than out of this system.
--
-- A non-zero here is not a migration failure. It is history, and these are the
-- lines in this list nobody at the counter can clear: voiding an over-refund is
-- refused, taking payment against one would charge the patient for the clinic's
-- own error, and on a cancelled bill both reversing one of its receipts and
-- refunding the balance away are refused too. Every one of them, with the
-- receipts behind it, is in jmc.financial_review_queue, which is what the admin
-- `financial_review` report reads. It goes to the accountant (policy register
-- 52 and 56–63).
--
-- The third figure is the queue's own membership test asked of the balances, so
-- it and the queue must agree whatever they are. It is NOT the first two added
-- together: a cancelled bill that is also over-refunded is in both of those and
-- on the queue exactly once.
select
  (select count(*) from jmc.invoice_balances
    where paid < 0 or due > total)                     as over_refunded,
  (select count(*) from jmc.invoice_balances
    where status = 'void' and paid <> 0)               as void_off_zero,
  (select count(*) from jmc.invoice_balances
    where paid < 0 or (status = 'void' and paid <> 0)) as under_review,
  (select count(*) from jmc.financial_review_queue)    as on_the_review_queue;
  -- 0, 0, 0, 0 — and under_review = on_the_review_queue even when they are not

-- No document number was issued twice.
select count(*) from (
  select invoice_number from jmc.invoices group by 1 having count(*) > 1) d;  -- 0
select count(*) from (
  select receipt_number from jmc.payments group by 1 having count(*) > 1) d;  -- 0

-- The Data API still cannot reach the clinic schema.
select count(*) from information_schema.role_table_grants
 where table_schema = 'jmc' and grantee in ('anon','authenticated','service_role','PUBLIC');  -- 0
```

---

## 7. What has NOT been verified, and cannot be from here

| | Why not | Who closes it |
|---|---|---|
| Real supplier invoices and GRNs | None supplied. Receiving is built against synthetic examples. | Clinic — policy register I.1 |
| Real package examples, including a changed pack size and real barcodes | None supplied. | Clinic — I.2 |
| The classification of the clinic's actual medicines, and the controlled-drug register | Cannot be invented. | Pharmacist — I.3 |
| Dr. Jayamurugan's production admin role | Nothing here queries production. | Owner — I.4 |
| A4 and 80 mm printing: margins, long medicine names, page breaks, reprint marking | No printer here. Print layout is checked only in a browser. | Clinic — I.5 |
| How a bill under financial review is finally cleared — over-refunded, or cancelled and not at ₹0 | The recovery/write-off workflow is neither designed nor built. `financial_review` reports the queue; no command in the application closes a row on it, and none invents a balancing entry. The same missing workflow is what the refusals on a **voided** bill are waiting for: no receipt allocated to one may be reversed and nothing may be refunded against one, so a cancelled bill carried across off zero has no approved way forward at all until an accountant defines one. That is deliberate — every available repair would be a correction nobody has signed off — but it does mean the queue is a list with no exit in this release. | Clinic accountant — I.6, policy items 56 and 59 |
| The GST treatment of a refund that exceeds the payment it reverses | Whether a credit or debit note is required, against which original document, and in whose name. Nothing in this release issues, reverses or adjusts a tax document, and no accountant has read any of it. | Clinic accountant — I.7, policy item 57 |
| Supabase Storage bucket policy: private, anonymous reads refused, service key not exposed | Staging writes to a directory; it exercises this application's rules, not Supabase's. | Deployment |
| The deployed database role's attributes | §7.4 of `SCHEMA_AND_TYPES.md`. The application is tested against the pessimistic case — `NOSUPERUSER NOBYPASSRLS` — so it works either way, but what the role actually is has never been read. | Deployment |
| **That a stored R2 backup can actually be recovered** | The *tooling* now exists and is tested: `scripts/db-restore-archive.sh` fetches one object, verifies it against the remote size and checksum, decrypts it, checks the gzip stream, restores it into a generated loopback scratch database and validates it by structure and counts, and `npm run staging:archive-drill` rehearses all of that — 85 checks — against a directory standing in for the bucket. **No object in R2 has been fetched.** Nothing here has ever held a read-only R2 credential or the age private identity, and this task was not authorized to create one. So the archive's readability is still unproven, exactly as before; what has changed is that proving it is now one approved workflow run rather than an afternoon of improvisation on the day it matters. §8.1 is the procedure. **Production must not go live before it has been done once.** | Owner, then Deployment — W9 |
| **Everything about actually sending a WhatsApp message** | Slice 3A built the durable contract and no transport. Meta's live policy has not been re-read against `reference/WHATSAPP.md` §0 and §11 — including whether an unverified WABA may send a template to a non-test recipient at all — no template has been submitted to Meta or approved by it, no credential exists, and the clinic has no published privacy notice, which Meta requires and DPDP requires separately. No number in the clinic's own records has been checked for whether it is a WhatsApp number. None of this is a defect in the release: with the connection unconfigured every scheduled message is suppressed into the admin's queue with a reason. It is the list of what a later slice has to close before one is ever sent. | Owner and clinic — policy section M's closing paragraph |
| **A clinic-local closing time** | Owner item 87 escalates an unreviewed result after four clinic hours **or at clinic closing, whichever is earlier**, and this application holds no closing time: `clinic_settings` has no such column, and `provider_availability` is one doctor's optional consulting windows rather than the clinic's day. The implementation uses owner item 77's 20:00 messaging dispatch cutoff as a conservative technical ceiling, under its own constant and described as one. The four-hour half is exact and usually fires first; the ceiling half is later than item 87 intends for a clinic that shuts at six. One owner value closes it. | Owner — policy item 87 |
| **A configured backup doctor** | Item 87 names "any explicitly configured backup doctor" for a critical result unacknowledged after fifteen minutes. The clinic has configured none and this application has nowhere to hold one, so the escalation reaches the owner-doctor alone and the read model returns `backupDoctorConfigured: false` rather than letting a screen imply otherwise. | Owner — policy item 87 |
| **That an authorized doctor is a registered doctor** | Owner item 84 requires a registered doctor to approve clinical catalogue content. What this application can prove is the doctor role plus the explicitly-set authorization flag; it holds no evidence of anybody's professional registration and does not claim to check one. | Clinic — onboarding and governance, policy item 84 |
| **A result-ready template approved by Meta**, and the whole of the row above about sending | Owner item 88 fixes the wording — "Your investigation result has been reviewed and is ready. Please contact the clinic." — and the clinic can approve it internally today. Meta has approved nothing, and the connection is unconfigured, so every authorized notice is suppressed into the admin's queue with `channel_not_configured` exactly as every other purpose is. | Owner and clinic — section M's closing paragraph |
| **A laboratory's real report format** | Every result in this release was typed in or attached by a member of staff. No analyzer feed, no laboratory portal, no HL7 and no results inbox exists or is planned in it, and `imported_structured_feed` is a provenance value a human records rather than a connection. Whether the clinic's laboratory can supply a machine-readable report at all is unknown. | Clinic |
| The browser CI job | Has never run; nothing has been pushed. | First green run |
| Tablets on clinic Wi-Fi | Not simulated. | Clinic |

---

## 8. When it goes wrong

**Before anything.** Take a backup and prove you can restore it:

```bash
# Needs BACKUP_DB_URL, BACKUP_AGE_RECIPIENT and the four RCLONE_CONFIG_R2_*
# values — the same ones .github/workflows/backup.yml passes from secrets.
./scripts/db-backup.sh daily

# The same two scripts, rehearsed against a scratch database. Needs no secret
# and reaches nothing outside this machine.
npm run staging:drill

# The STORED-object restore path, rehearsed against a directory standing in for
# the bucket. Also needs no secret and reaches no network. What it does not do
# is touch R2 — see 8.1.
npm run staging:archive-drill
```

One thing that drill does **not** prove, and it is worth knowing before you
lean on it: neither it nor the nightly CI job ever downloads the encrypted
object from R2 and decrypts it. Both take a fresh dump and restore that. The
dump-and-restore path is proven; the archive sitting in R2 is not. §8.1 at the
end of this section is what to do about that, and that object is the backup you
will actually reach for.

**A migration failed part-way.** It cannot have. Each runs in one transaction,
so it either applied or it did not. The *push* can stop part-way, though — the
files before the refusal stay applied (§3). Check which of the twenty-one are
present (`select * from supabase_migrations.schema_migrations`) and fix
forward.

**The application is broken and the data is fine.** Roll back the functions
and the page, not the database:

```bash
git checkout 6321415   # the previous release: main as of 9 September 2026
npx supabase functions deploy --project-ref <ref> --no-verify-jwt \
  bootstrap command csv login logout record register snapshot staff
NEXT_PUBLIC_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1 npx next build
npx wrangler deploy    # the old page as well: the new one calls five functions
                       # the old release does not have
```

The schema is additive except for one thing — `jmc.bills` is emptied — so the
previous release will run against the new schema with one exception: it reads
`bills`, and will show no bills. That is a visible, harmless wrongness for the
length of a rollback, and the money is in `invoices` throughout.

That paragraph was reasoned for the six migrations this section was first
written against. Fifteen more have been added since, and **nobody has run the
9 September functions against the full new schema**. Two changes matter to an
old reader and the paragraph above covers neither: vitals readings that may now
be NULL, and money that Slice 3 turned from `real` into `numeric`. Treat this
rollback as unrehearsed until it has been tried once on staging.

**The data is wrong.** Nothing here rewrites history, so the fix is always a
compensating event rather than an UPDATE: an adjustment movement, a credit
line, a refund, a reversal, another resolution. Every one of them is a command
the application already has, and every one leaves both the mistake and the
correction on the record. If you find yourself reaching for `UPDATE`, the
trigger will stop you, and it is right to.

**A bill says `over_refunded`.** More money has gone back out on it than ever
came in — classically a refund that stands and a receipt that turned out never
to have settled — and it is one of the two wrongnesses on this page that the
application will not let you correct (the other is below, and both end up on the
same queue). Voiding it is refused: a void would close the only record of where
the money went. Taking payment against it is refused too, since `due` on such a
bill is larger than the bill and collecting it would charge the patient for the
clinic's own error. Both refusals say the same thing —
*Over-refunded — financial correction required* — and neither changes anything.

So do not invent a balancing entry. There is no adjustment line, no ₹0
"correcting" receipt and no write-off command for this, deliberately: both
events are real, both stay, and inventing a third to make the arithmetic look
tidy destroys the only evidence of what happened. Open `financial_review`
(admin), which lists every such bill worst first with all its receipts, and
give it to the admin or accountant. Clearing it — recovery, or a write-off, and
the GST treatment if GST applies — is theirs and is not yet decided: policy
register 56 and 57, §7 above.

One case is worth recognising, because it is the one that can be undone: if the
bill went negative because a receipt was reversed *after* a refund was taken
against it, the refund should have been reversed first. Reversing a receipt now
refuses when it would take any of its bills below zero and names the refunds to
reverse first, so this cannot be created going forward — but a bill that
acquired it before the migration, or carried it across from the old data, is
still on the queue and still the accountant's.

Reversing a **refund** is never refused for this reason, and that is worth
knowing before you conclude the bill is stuck. Money going back out only ever
moves a bill towards zero, so a bill at −₹80 carrying two ₹40 refunds is walked
back one refund at a time even though the first step lands on −₹40 and is still
an over-refund. An earlier commit in this branch did refuse that step, which
left the only way out of the state blocked by the rule meant to stop anybody
entering it. It never reached the clinic — nothing here has — and policy
register 58 settles it: the refusal is gone.

**A bill says `void_with_balance`.** It was cancelled, and it is not at zero.
`paid` is signed and says which way: above zero is money the clinic took and is
still holding against a bill that says nothing was owed; below zero is money
refunded past a cancelled bill. A void is permitted only at exactly ₹0, so this
cannot be created here — every one of them came across with the history, and the
reason it has a word at all is that `void` would otherwise have filed it under
closed and nobody would have looked at it again.

Both obvious repairs are refused, and it is worth knowing why before going to
find the button. **Reversing one of its receipts** is refused, whichever
direction that receipt went: the receipts behind a bill voided at zero net to
nothing, so undoing any one of them is precisely what moves the bill off zero.
That is how this state used to be reachable, not how it is escaped.
**Refunding the balance away** is refused too, and that one looks much more like
a repair — the clinic is holding ₹100 nobody owed, hand it back. But it is a
correction posted against a cancelled document, and which document the money
should go back on, whether it is a refund at all rather than a write-off, and
what it does to a tax return where GST applies are the accountant's questions,
not the counter's. Both refusals name the bill, change nothing, and say the bill
is on the financial review queue.

So the same instruction as above, for the same reason: open `financial_review`
(admin), where these rows read `void_with_balance`, worst first with every
receipt attached, and give it to whoever keeps the books. Clearing it needs item
56's workflow, which does not exist: policy register 56, 59 and 61, and §7.

**Somebody lost a tablet.** Admin → Staff → revoke that person's sessions and
reset their PIN. Image tickets die with the session; patient data is
server-side; no clinical photograph is in local storage or a device gallery.
Then read the image access report for anything that happened after the loss.

---

### 8.1 Proving the archive in R2 can be restored — W9

**Status: the tooling is built and tested. No object in R2 has been fetched.
Do not treat W9 as closed until the run below has been done once.**

Three different things, and they are easy to confuse:

| | Proves | State |
|---|---|---|
| `npm run staging:drill`, and the nightly `restore-drill` job | A `pg_dump` can be restored. | Green, and has been for a while. |
| `npm run staging:archive-drill` | The stored-object restore path works, including every refusal, against a directory standing in for the bucket. 85 checks, no network, synthetic data, a throwaway age identity. | Green. |
| One approved run of `.github/workflows/archive-restore.yml` | **That the clinic's own archive is readable.** | **Never run.** |

#### What the owner has to do, in order

None of it has been done, and none of it was done by the work that built this.

1. **Create a read-only R2 API token** scoped to the one clinic backup bucket,
   with Cloudflare's **"Object Read only"** permission — in their words it
   "allows the ability to read and list objects in specific buckets", and it
   cannot write, delete, or change bucket configuration. **It must be a
   different token from the one `backup.yml` uploads with.** Keep the Access
   Key ID and Secret Access Key; Cloudflare shows the secret once.
2. **Create a GitHub environment named `archive-restore`** on this repository
   and add an **owner-approved required reviewer** to it. Limit its deployment
   branches to the default branch. This is not decoration: GitHub withholds an
   environment's secrets from a job until the protection rules pass, so the
   required reviewer is what stands between the workflow file and a credential
   that can read every clinical record the clinic has.
3. **Add five secrets to that environment**, and to nowhere else:
   `R2_RESTORE_ACCESS_KEY_ID`, `R2_RESTORE_SECRET_ACCESS_KEY`,
   `R2_RESTORE_ENDPOINT` (`https://<account>.r2.cloudflarestorage.com`),
   `R2_RESTORE_BUCKET` (the bucket name alone) and `BACKUP_AGE_IDENTITY`.
   The last one is the **private** identity, beginning `AGE-SECRET-KEY-1`. It
   is not `BACKUP_AGE_RECIPIENT`, which is the public half and cannot decrypt
   anything; the script refuses the recipient by name if it is handed one.
4. **Dispatch `Archive restore proof` manually**, leaving the retention kind at
   `daily`, and approve it when GitHub asks. GitHub only offers a manual run
   for a workflow that exists on the default branch, so this step waits for
   the branch to be merged into `main`; until then the workflow cannot be
   found, let alone run.
5. **Read the report.** It is the only artifact, and it carries the retention
   kind, the object basename, the remote and downloaded byte sizes, the
   encrypted object's SHA-256, the decrypted size, the restored schema names,
   the table and row counts, the maximum `jmc.clinic_revision`, and the stage
   reached. No clinic data, no SQL, no connection string, no bucket name, no
   key. Check that the object basename is a recent one and that the counts are
   the size of the clinic rather than the size of an empty schema.
6. **Record the run URL and the object basename** in this file and in
   `reference/BACKEND_PROGRAMME_REGISTER.md` under W9, and only then mark W9
   closed.
7. **Decide what happens to the token.** Revoking it after the run is the safe
   default and costs one token creation to repeat the proof. Retaining it makes
   the proof repeatable and leaves a readable credential in existence; if it is
   retained, it stays on the `archive-restore` environment behind the required
   reviewer and nowhere else, and it is rotated on the same schedule as the
   writer.

#### What the run will and will not do

It fetches exactly one object and writes nothing. It never dumps, never calls
`pg_dump`, never receives `BACKUP_DB_URL` — the script refuses to start if that
variable is merely present in its environment, along with the backup writer's
own R2 credentials — and issues no rclone subcommand that can write, delete,
rename or prune. It restores only into a database it generates, named
`clinic_restore_drill_archive_<random>`, on the runner's own loopback; it
refuses `clinic`, `clinic_staging` and `postgres` by name, refuses any
non-loopback target before it opens a single database connection, and refuses
outright if a database of its generated name already exists rather than
dropping one it did not create. The decrypted archive lives in a `mktemp -d`
directory at mode 700 and is removed on success, on failure and on interrupt.

And what a green run still does not prove, which the report says itself: who
uploaded the object. age authenticates the ciphertext against its recipient, so
an altered, spliced or truncated object is refused rather than decrypted, but
anybody holding the public recipient could have produced a file that decrypts.
The SHA-256 in the report names those exact bytes for a later run to compare
against; there is no trusted stored digest or signature to check them against
today.

---

## 9. Patient messaging: what to provision, and what has to be true first

**None of this has been run.** Slice 3B built the adapter, the webhook and the
protected worker endpoint; it provisioned no scheduler, created no credential,
submitted no template and has never contacted Meta. This section is the
procedure for when the owner decides to switch patient messaging on, written
while it is still fresh, and deliberately not executed.

Until it is run the clinic behaves exactly as it does today: every due reminder
and recall is suppressed into the admin's queue with `channel_not_configured`
against it, and the worker endpoint refuses every request. Nothing is silently
dropped and nothing pretends to send.

### 9.1 Gates that must close before any of it

These are release gates, not a checklist to work around. Owner section M's
closing paragraph names most of them and this slice does not waive any.

1. **A verified WhatsApp Business account**, a dedicated number, and an
   approved display name. Read `reference/WHATSAPP.md` §0 first: the question
   of whether an *unverified* account may send a template to a non-test
   recipient at all is **still open**, and §9.5 below records exactly how far
   this slice's research got.
2. **The clinic's published privacy notice.** Required by Meta for the account
   and by DPDP regardless. Cloud API messages are not end-to-end encrypted —
   `WHATSAPP.md` §6 — so Meta is a processor in the chain and the notice has to
   say so.
3. **Approved templates, on both sides.** The clinic's own approval is a
   doctor's (owner item 81) and is recorded by `approve_message_template`;
   Meta's is recorded separately by `record_provider_template_state`. A message
   needs both, and either can be withdrawn alone.
4. **The parameter format confirmed.** The adapter sends *named* body
   parameters, matching the clinic's own `{{lower_snake_case}}` bodies. If the
   templates are registered with Meta positionally, change
   `BODY_PARAMETER_FORMAT` in `_shared/whatsapp-cloud.ts` before the first
   send. This is the one provisional constant in the payload.
5. **One real message, to a staff member's own phone**, before any patient
   number is in the system. Nothing in this repository has ever been answered
   by Meta.

### 9.2 Secrets, and where they go

Six values, none of which exists in this repository, in `.env.example`, in any
migration or in any test:

```text
WHATSAPP_ACCESS_TOKEN      the system-user token
WHATSAPP_PHONE_NUMBER_ID   the business number's id
WHATSAPP_APP_SECRET        signs the webhook; the app's secret, not the token
WHATSAPP_VERIFY_TOKEN      a string you choose, given to Meta once
WHATSAPP_API_VERSION       optional; defaults to v23.0
CLINIC_WORKER_TOKEN        a long random string, for the scheduler only
```

```bash
npx supabase secrets set --project-ref <ref> WHATSAPP_ACCESS_TOKEN=... \
  WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_APP_SECRET=... \
  WHATSAPP_VERIFY_TOKEN=... CLINIC_WORKER_TOKEN=...
```

`CLINIC_WORKER_TOKEN` is not a staff credential and must never be given to a
person or put on a tablet. Anyone holding it can make the clinic run a dispatch
cycle — not send anything the clinic had not already decided to send, but
sooner than it meant to.

**The four `WHATSAPP_*` values are all-or-nothing.** There is no partial mode:
until all four are set the adapter is fully disabled and the webhook refuses
every request including a correctly signed one.

### 9.3 Deploying the two new functions

```bash
npx supabase functions deploy whatsapp --project-ref <ref> --no-verify-jwt
npx supabase functions deploy worker   --project-ref <ref> --no-verify-jwt
```

Then give Meta the webhook URL — `https://<ref>.supabase.co/functions/v1/whatsapp`
— and the verify token, and subscribe to the **messages** field. Meta calls
the URL with `hub.mode=subscribe` and expects `hub.challenge` back; if the
token does not match exactly the endpoint answers 403 and the subscription
fails, which is the correct outcome for a wrong token.

Verify before going further: the challenge succeeds, and a deliberately
mis-signed POST is refused with 403 and changes nothing.

### 9.4 The scheduler — the part that is not built

Supabase's documented answer is `pg_cron` calling `pg_net`, with the token in
Vault. An external scheduler calling the same endpoint with the same header is
equivalent and is the better choice if one already exists, because it keeps the
secret out of the database.

**Supabase documents no protection against overlapping runs**, which is why the
worker is built to be safe under them rather than relying on the scheduler not
to produce them.

Never put the token or the deployment URL in a migration. Both are
deployment-specific, and a migration is committed.

```sql
-- Run BY HAND against the clinic database, never as a migration.
-- Requires the pg_cron and pg_net extensions and a Vault secret named
-- 'clinic_worker_token' holding CLINIC_WORKER_TOKEN.
select cron.schedule(
  'clinic-dispatch',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://<ref>.supabase.co/functions/v1/worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets
          where name = 'clinic_worker_token')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Five minutes is the coarsest interval that still honours the rules: an 18:00
reminder and a 09:00 recall both have to go out close to the minute they are
due, and item 79's three attempts have to fit inside two hours.

The cycle is cheap when there is nothing to do — two indexed queries over
`status = 'scheduled'` and the dispatchable set — so running it through the
night costs almost nothing, and it dispatches nothing outside 08:00–20:00
anyway.

**Rollback.** One statement, effective immediately, and it loses nothing:

```sql
select cron.unschedule('clinic-dispatch');
```

Messages then accumulate at `scheduled`. The first cycle after it is restored
suppresses the ones whose moment has passed with `past_useful_by` rather than
sending a morning's worth of stale reminders at once. To stop sending without
touching the scheduler, unset `CLINIC_WORKER_TOKEN` — the endpoint then refuses
every call — or unset the `WHATSAPP_*` values, which sends every due message to
the admin's queue with a truthful reason. All three are safe and all three are
reversible.

### 9.5 The WABA question, narrowed but not closed

`reference/WHATSAPP.md` §0 lists four questions. This slice's reading of Meta's
own current documentation resolved the second and narrowed the first:

- **Resolved.** The messaging limit counts "the maximum number of unique
  WhatsApp user phone numbers your business can deliver messages to … within a
  moving 24-hour period", and "newly created business portfolios have a
  messaging limit of 250". It is unique recipients, not messages, and the
  clinic sees about 60 patients a day.
- **Narrowed, not closed.** Meta's messaging-limits page does not state
  explicitly whether an unverified account may send a template to a non-test
  recipient at all. The existence of a 250 tier for a new portfolio points
  strongly that way, and other official pages describe verification as
  *raising* the ceiling rather than unlocking sending. That is an inference,
  and it is not good enough to switch a clinic's patient channel on.
- **Still open.** Whether the privacy-policy URL gates template *approval* or
  template *sending*, and whether display-name approval requires business
  verification first.

**So it remains a release gate.** Resolve it from Meta's own account and
documentation at the time, not from this paragraph and not from a vendor blog —
`WHATSAPP.md` rule 10 exists because Meta changed this twice in 2026.
