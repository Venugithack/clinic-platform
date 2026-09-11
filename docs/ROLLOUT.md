# Rollout

**Jayamurugan Clinic — Slices 2.1.1 to 6**
**Written 12 September 2026. Nothing in it has been run against the clinic.**

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
| Pushed | **No.** Nothing in this programme has left this machine. |
| Deployed | **No.** No migration has been applied to the clinic, no function deployed, no secret changed. |
| Verified | On guarded local staging: a disposable PostgreSQL 17, synthetic fixtures, and the real code. |
| Not verified | Anything that needs the clinic's own data, a real printer, real tablets on clinic Wi-Fi, Supabase's Storage bucket policy, or a CI runner. §7 lists every one. |

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
```

Write the answers down. §6 compares against them.

---

## 3. Applying it

Five migrations, in this order, each once:

```text
20260911210000_slice2_1_1_resolution_scope.sql
20260912000000_slice3_identity_packages_stock.sql
20260913000000_slice4_dispensing_billing_payments.sql
20260914000000_slice5_clinical_images.sql
```

(Slice 2 and 2.1 are already in the set; if the clinic is behind, apply from
wherever it actually is.)

**Every one must run inside a transaction.** Each begins `set local search_path
= jmc`, and `SET LOCAL` outside a transaction block does nothing at all —
Postgres warns and then creates the tables in `public`, where the retired
application lives and eight table names collide exactly. `supabase db push`
wraps each file; nothing else is guaranteed to. `docs/STAGING.md` §3.1 is the
long version.

```bash
# Rehearse against a restored copy first. Not optional.
npm run staging:rehearse

# Then, with a backup taken and verified in the last hour:
supabase db push
supabase functions deploy      # command, snapshot, login, logout, register,
                               # record, staff, csv, bootstrap, inventory,
                               # images, reports
```

### What each migration does to existing rows

| Migration | Touches history |
|---|---|
| Slice 2.1.1 | Nothing. Adds a trigger and asserts no existing resolution is out of scope. |
| Slice 3 | Converts **every money column** from `real` to `numeric(12,2)`, rounding to the paisa. Gives every batch and medicine a base unit, taken from the `unit` column that quantity was always counted in. Adds no package to any existing batch — inventing one would be a guess frozen onto the batch. |
| Slice 4 | Gives every prescription a `valid_until` of signing + 7 days. Moves every `bills` row into an invoice, a line and (where paid) a payment; **empties `jmc.bills` and leaves it standing** as a tombstone. Sets the clinic consultation fee to ₹300 only where none is configured. Builds `otc_lines` from `lines_json`. |
| Slice 5 | Nothing. New tables only. |

The `valid_until` backfill deserves a sentence: every existing prescription is
long past signing + 7, so on the morning after the migration the pharmacy
cannot supply a remainder against any of them. That is correct — it is the rule
the clinic chose — and it is also a thing staff will meet, so tell them before
they meet it.

---

## 4. The setup the clinic has to do, in order

Nothing below can be done for them, and the counter is partly refused until it
is.

1. **Reset the PINs.** `docs/PIN_RESET_RUNBOOK.md`. Confirm an admin exists
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

A day that does not reconcile is a day to stop and find out why, not a day to
carry forward.

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
| Real supplier invoices and GRNs | None supplied. Receiving is built against synthetic examples. | Clinic — policy register H.1 |
| Real package examples, including a changed pack size and real barcodes | None supplied. | Clinic — H.2 |
| The classification of the clinic's actual medicines, and the controlled-drug register | Cannot be invented. | Pharmacist — H.3 |
| Dr. Jayamurugan's production admin role | Nothing here queries production. | Owner — H.4 |
| A4 and 80 mm printing: margins, long medicine names, page breaks, reprint marking | No printer here. Print layout is checked only in a browser. | Clinic — H.5 |
| Supabase Storage bucket policy: private, anonymous reads refused, service key not exposed | Staging writes to a directory; it exercises this application's rules, not Supabase's. | Deployment |
| The deployed database role's attributes | §7.4 of `SCHEMA_AND_TYPES.md`. The application is tested against the pessimistic case — `NOSUPERUSER NOBYPASSRLS` — so it works either way, but what the role actually is has never been read. | Deployment |
| **That a stored R2 backup can actually be recovered** | Neither the staging drill nor the nightly CI job downloads the encrypted object, decrypts it with the age identity, and restores it — both take a *fresh* dump and restore that. The dump-and-restore path is proven; the archive is not. **Production must not go live before this is done once, by hand.** | Deployment |
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
```

One thing that drill does **not** prove, and it is worth knowing before you
lean on it: neither it nor the nightly CI job ever downloads the encrypted
object from R2 and decrypts it. Both take a fresh dump and restore that. The
dump-and-restore path is proven; the archive sitting in R2 is not. Before
cutover, pull one object down by hand, decrypt it with the age identity, and
restore it. That is the backup you will actually reach for.

**A migration failed part-way.** It cannot have. Each runs in one transaction,
so it either applied or it did not. Check which of the five are present
(`select * from supabase_migrations.schema_migrations`) and fix forward.

**The application is broken and the data is fine.** Roll back the functions,
not the database:

```bash
supabase functions deploy --project-ref <ref>   # from the previous commit
```

The schema is additive except for one thing — `jmc.bills` is emptied — so the
previous release will run against the new schema with one exception: it reads
`bills`, and will show no bills. That is a visible, harmless wrongness for the
length of a rollback, and the money is in `invoices` throughout.

**The data is wrong.** Nothing here rewrites history, so the fix is always a
compensating event rather than an UPDATE: an adjustment movement, a credit
line, a refund, a reversal, another resolution. Every one of them is a command
the application already has, and every one leaves both the mistake and the
correction on the record. If you find yourself reaching for `UPDATE`, the
trigger will stop you, and it is right to.

**Somebody lost a tablet.** Admin → Staff → revoke that person's sessions and
reset their PIN. Image tickets die with the session; patient data is
server-side; no clinical photograph is in local storage or a device gallery.
Then read the image access report for anything that happened after the loss.
