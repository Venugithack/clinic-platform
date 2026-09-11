# Schema and type mappings

What the database actually holds, what the tablets actually receive, and every
conversion in between. This is a characterization document, produced for Slice 0
of `CLAUDE_IMPLEMENTATION_BRIEF.md` §6. It describes the schema **as it is**, not
as it should be. Nothing here proposes a change.

Every column type, nullability, default, constraint and index in §1 was read out
of a live Postgres with the migrations applied, not out of the migration files.
That distinction matters: the migrations use `create table if not exists` and
then `alter table ... add column if not exists` in three later files, so the file
order is not the final column order and reading the SQL gives the wrong answer
about where `medicines.schedule` and `suppliers.return_window_days` sit.

**How it was verified.** A disposable local Postgres (`jmc-staging`, database
`clinic_staging`) with `supabase/migrations/` applied into schema `jmc`, queried
through `information_schema.columns`, `pg_constraint`, `pg_indexes` and
`information_schema.sequences`.

The column, constraint and index listings in §1.1–§1.29 were taken **before**
`20260909125237_harden_active_clinic.sql` could be applied — at the time it
could not be applied to a fresh database at all, which is one of the two
defects Slice 0 found (`docs/STAGING.md` §3.2). It applies now, via the
staging-only legacy stubs, and everything it adds is listed separately in
§1.31. So a `*_idx` marked "file-only" below is present in staging and in
production; it is simply not in the snapshot these tables were read from.

---

## 1. Schema inventory

29 tables and 5 sequences, all in schema `jmc`. There is not one `timestamptz`,
one `numeric`, one `boolean`, one `uuid` and one enum in the whole schema.
Everything is `text`, `integer` or `real`.

Tables are listed in dependency order: a table appears after everything it
references.

### 1.1 `staff`

Everyone who can sign in, their roles, and their PIN material.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `name` | text | no | | |
| `username` | text | no | | unique |
| `phone` | text | no | `''` | |
| `roles_json` | text | no | | JSON array of `Role`. No check |
| `pin_hash` | text | no | | scrypt, from `_shared/password.ts` |
| `pin_salt` | text | no | | |
| `active` | integer | no | `1` | no check — see §3.8 |
| `last_login` | text | yes | | |
| `created_at` | text | no | | |

PK `id`. Unique `username`. No foreign keys. Indexes: `staff_pkey`,
`staff_username_key`.

### 1.2 `pin_attempts`

One row per wrong PIN, charged to the caller (IP) rather than to the account, so
that anyone reading the staff list off a shared tablet cannot lock the doctor out
of his own clinic.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `staff_id` | text | yes | | FK -> `staff(id)`. Nullable on purpose: guessing a staff id must also cost an attempt |
| `caller` | text | no | | |
| `failed_at` | text | no | | |

Indexes: `pin_attempts_pkey`, `pin_attempts_caller (caller, failed_at)`.

### 1.3 `sessions`

Live sign-ins. The raw token never lands here; only `sha256(secret:token)`.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `token_hash` | text | no | | PK |
| `staff_id` | text | no | | FK -> `staff(id)` |
| `created_at` | text | no | | |
| `last_seen` | text | no | | |
| `expires_at` | text | no | | compared as a **string** — see §3.2 |

PK `token_hash`. Indexes: `sessions_pkey`. (`sessions_staff_id_idx` is file-only.)

### 1.4 `patients`

The patient register.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `name` | text | no | | |
| `age` | integer | no | | an age, not a date of birth |
| `sex` | text | no | | check in `('female','male','other')` |
| `phone` | text | no | | no index, no format check |
| `address` | text | no | `''` | never leaves the database except through `register` |
| `whatsapp_consent` | integer | no | `0` | boolean-as-integer, no check |
| `created_at` | text | no | | |

PK `id`. Indexes: `patients_pkey` only. There is no index on `name` or `phone`,
which is what Slice 1's duplicate-suggestion requirement will need.

### 1.5 `appointments`

Today's queue, plus anything still waiting from another day.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `patient_id` | text | no | | FK -> `patients(id)` |
| `token` | text | no | | **no unique index** — see §3.7 |
| `reason` | text | no | | |
| `scheduled_at` | text | no | | |
| `status` | text | no | | check in `('waiting','in_consult','done','cancelled')` |
| `created_at` | text | no | | |

Indexes: `appointments_pkey` only. Nothing indexes `scheduled_at` or `status`,
and the snapshot filters on both on every poll.
(`appointments_patient_id_idx` is file-only.)

### 1.6 `vitals`

Readings taken at the door.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `patient_id` | text | no | | FK -> `patients(id)` |
| `bp` | text | no | | free text, e.g. `"120/80"` |
| `temperature` | real | no | | |
| `pulse` | integer | no | | |
| `spo2` | integer | no | | |
| `weight` | real | no | | |
| `recorded_by` | text | no | | FK -> `staff(id)` |
| `recorded_at` | text | no | | |

Indexes: `vitals_pkey` only. All four numeric columns are `not null` with no
default, so there is no way to record "not measured" — Slice 2 requires one.

### 1.7 `encounters`

One consultation.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `patient_id` | text | no | | FK -> `patients(id)` |
| `doctor_id` | text | no | | FK -> `staff(id)` |
| `appointment_id` | text | yes | | FK -> `appointments(id)` |
| `diagnosis` | text | no | | free text |
| `notes` | text | no | | free text |
| `advice` | text | no | | free text |
| `created_at` | text | no | | |

Indexes: `encounters_pkey` only. No source/idempotency key: `save_consultation`
run twice writes two encounters, two prescriptions and two consultation bills.

### 1.8 `prescriptions`

One signed prescription. The lines are a JSON string; there is no lines table.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `patient_id` | text | no | | FK -> `patients(id)` |
| `encounter_id` | text | yes | | FK -> `encounters(id)` |
| `doctor_id` | text | no | | FK -> `staff(id)` |
| `items_json` | text | no | | JSON array of `PrescriptionItemView`. No check — see §3.4 |
| `signed_at` | text | no | | |
| `dispensed_at` | text | yes | | one binary timestamp for the whole prescription |

Indexes: `prescriptions_pkey` only.

### 1.9 `bills`

Money owed by a patient. One row is one whole charge; there is no payments table
and no bill-lines table.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `patient_id` | text | no | | FK -> `patients(id)` |
| `label` | text | no | | free text. Only value ever written is `'Consultation'` |
| `amount` | real | no | | check `amount >= 0` |
| `status` | text | no | | check in `('unpaid','paid')` |
| `payment_method` | text | yes | | **no check** — validated only in `commands.ts` |
| `created_at` | text | no | | |
| `paid_at` | text | yes | | |

Indexes: `bills_pkey` only. The snapshot filters `status = 'unpaid' or
created_at >= <day start>` on every poll against no index.

### 1.10 `beds`

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `label` | text | no | | unique |
| `status` | text | no | | check in `('available','occupied','cleaning','out_of_service')` |
| `patient_id` | text | yes | | FK -> `patients(id)` |
| `admitted_at` | text | yes | | |
| `notes` | text | no | `''` | |

Indexes: `beds_pkey`, `beds_label_key`.

### 1.11 `suppliers`

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `code` | text | no | | unique |
| `name` | text | no | | |
| `contact_person` | text | no | `''` | |
| `whatsapp` | text | no | `''` | no country-code normalization anywhere |
| `phone` | text | no | `''` | |
| `email` | text | no | `''` | |
| `address` | text | no | `''` | |
| `gstin` | text | no | `''` | |
| `active` | integer | no | `1` | no check |
| `created_at` | text | no | | |
| `return_window_days` | integer | no | `0` | check `>= 0`. Added by a later migration, so it is the **last** column |

Indexes: `suppliers_pkey`, `suppliers_code_key`.

### 1.12 `medicines`

The drug master. One row is simultaneously the clinical identity, the product,
the package and the pricing basis — the collapse that Slice 3 exists to undo.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `code` | text | no | | unique |
| `name` | text | no | | |
| `strength` | text | no | `''` | free text |
| `dosage_form` | text | no | `''` | free text |
| `unit` | text | no | | free text, **no check** — see §3.3 |
| `barcode` | text | no | `''` | not unique, not indexed |
| `sale_class` | text | no | | check in `('otc','prescription','restricted','unknown')` |
| `reorder_level` | integer | no | | check `>= 0` |
| `target_stock` | integer | no | | table check `target_stock >= reorder_level` |
| `preferred_supplier_id` | text | yes | | FK -> `suppliers(id)` |
| `active` | integer | no | `1` | no check |
| `created_at` | text | no | | |
| `schedule` | text | no | `'unset'` | check in `('unset','OTC','H','H1','X')`. Added later, so it is the **last** column |

Indexes: `medicines_pkey`, `medicines_code_key`, and the partial
`medicines_schedule on (schedule) where schedule in ('H1','X')` — which serves
the Schedule H1 register and nothing else.

### 1.13 `supplier_medicines`

Which supplier can be asked for which medicine.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `supplier_id` | text | no | | FK -> `suppliers(id)`, part of PK |
| `medicine_id` | text | no | | FK -> `medicines(id)`, part of PK |
| `active` | integer | no | `1` | no check |

PK `(supplier_id, medicine_id)`. Index: `supplier_medicines_pkey` only, so a
lookup by `medicine_id` alone cannot use it.

### 1.14 `batches`

Physical stock. `available_quantity` is a cached figure the ledger is supposed to
agree with.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `medicine_id` | text | no | | FK -> `medicines(id)` |
| `batch_number` | text | no | | unique with `medicine_id` |
| `expiry` | text | no | | **no format check**, cast `expiry::date` at query time — see §3.2 |
| `available_quantity` | integer | no | | check `>= 0` |
| `mrp` | real | no | | check `>= 0` |
| `purchase_price` | real | no | | check `>= 0` |
| `selling_price` | real | no | | check `>= 0` |
| `received_from_supplier_id` | text | yes | | FK -> `suppliers(id)` |
| `received_at` | text | no | | |
| `version` | integer | no | `1` | bumped by every stock change; the optimistic-lock counter |

Unique `(medicine_id, batch_number)`. Indexes: `batches_pkey`,
`batches_medicine_id_batch_number_key`. Nothing indexes `expiry`, and the FEFO
query orders by it on every dispense.

### 1.15 `stock_movements`

The append-only ledger. Stock truth is supposed to live here.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `medicine_id` | text | no | | FK -> `medicines(id)` |
| `batch_id` | text | no | | FK -> `batches(id)` |
| `movement_type` | text | no | | **no check**, and always set to the same value as `reference_type` — see §3.9 |
| `quantity_delta` | integer | no | | signed; negative for issues |
| `reference_type` | text | no | | no check |
| `reference_id` | text | no | | no FK; points at a prescription, sale, order or write-off by convention |
| `actor_id` | text | no | | FK -> `staff(id)` |
| `created_at` | text | no | | |

Indexes: `stock_movements_pkey` only. Every ledger read is a full scan.

### 1.16 `otc_sales`

Anonymous counter sales. Lines are a JSON string.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `receipt_number` | text | no | | unique; minted from `otc_receipt_seq` |
| `total` | real | no | | check `>= 0` |
| `payment_method` | text | no | | check in `('cash','upi','card')` |
| `lines_json` | text | no | | JSON. Cast `lines_json::json` inside the snapshot query — see §3.4 |
| `created_by` | text | no | | FK -> `staff(id)` |
| `created_at` | text | no | | |

Indexes: `otc_sales_pkey`, `otc_sales_receipt_number_key`.

### 1.17 `purchase_orders`

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `order_number` | text | no | | unique; minted from `purchase_order_seq` |
| `supplier_id` | text | no | | FK -> `suppliers(id)` |
| `status` | text | no | | check in `('pending','placed','partially_delivered','delivered','cancelled')` |
| `requested_date` | text | no | | |
| `message_draft` | text | no | | |
| `external_message_id` | text | yes | | |
| `message_status` | text | yes | | **no check**, typed in TS as a five-value union |
| `created_by` | text | no | | FK -> `staff(id)` |
| `created_at` | text | no | | |
| `placed_at` | text | yes | | |

Indexes: `purchase_orders_pkey`, `purchase_orders_order_number_key`.

### 1.18 `purchase_order_lines`

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `order_id` | text | no | | FK -> `purchase_orders(id)` |
| `medicine_id` | text | no | | FK -> `medicines(id)` |
| `ordered_quantity` | integer | no | | check `> 0` |
| `received_quantity` | integer | no | `0` | check `>= 0`. No check that it does not exceed `ordered_quantity` |

Unique `(order_id, medicine_id)`. Indexes: `purchase_order_lines_pkey`,
`purchase_order_lines_order_id_medicine_id_key`.

### 1.19 `stock_writeoffs`

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `batch_id` | text | no | | FK -> `batches(id)` |
| `medicine_id` | text | no | | FK -> `medicines(id)` |
| `quantity` | integer | no | | check `> 0` |
| `reason` | text | no | | check in `('expiry','damage','loss')` |
| `cost_value` | real | no | | check `>= 0`. Captured at write-off, not recomputed |
| `note` | text | no | `''` | |
| `actor_id` | text | no | | FK -> `staff(id)` |
| `created_at` | text | no | | |

Indexes: `stock_writeoffs_pkey`, `stock_writeoffs_created (created_at)` — the
only timestamp index in the schema.

### 1.20 `supplier_returns`

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `note_number` | text | no | | unique; minted from `supplier_return_seq` |
| `supplier_id` | text | no | | FK -> `suppliers(id)` |
| `batch_id` | text | no | | FK -> `batches(id)` |
| `medicine_id` | text | no | | FK -> `medicines(id)` |
| `quantity` | integer | no | | check `> 0` |
| `expected_credit` | real | no | | check `>= 0` |
| `status` | text | no | | check in `('sent','credited','rejected')` |
| `settled_at` | text | yes | | |
| `note` | text | no | `''` | |
| `actor_id` | text | no | | FK -> `staff(id)` |
| `created_at` | text | no | | |

Indexes: `supplier_returns_pkey`, `supplier_returns_note_number_key`, and the
partial `supplier_returns_open on (supplier_id) where status = 'sent'`.

### 1.21 `till_sessions`

The cash drawer, opened with a float and closed against counted cash.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `opened_at` | text | no | | |
| `opened_by` | text | no | | FK -> `staff(id)` |
| `opening_float` | real | no | | check `>= 0` |
| `closed_at` | text | yes | | |
| `closed_by` | text | yes | | FK -> `staff(id)` |
| `counted_cash` | real | yes | | check `>= 0` |
| `expected_cash` | real | yes | | no check. **Stored** at close, deliberately, so a later void cannot move it |
| `variance` | real | yes | | no check (may be negative, correctly) |
| `note` | text | no | `''` | |

Table check `till_closed_completely`: the five close columns are either all null
or all not null. Indexes: `till_sessions_pkey`, and the partial unique
`till_only_one_open on ((1)) where closed_at is null` — a constant-expression
index, which is how "at most one open row in the whole table" is expressed.

### 1.22 `cash_movements`

Cash in and out of the drawer for reasons other than a sale.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `till_id` | text | no | | FK -> `till_sessions(id)` |
| `direction` | text | no | | check in `('in','out')` |
| `amount` | real | no | | check `> 0` |
| `reason` | text | no | | |
| `actor_id` | text | no | | FK -> `staff(id)` |
| `created_at` | text | no | | |

Indexes: `cash_movements_pkey`, `cash_movements_till (till_id)`.

### 1.23 `stock_takes`

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `reference` | text | no | | unique; minted from `stock_take_seq` |
| `scope` | text | no | | check in `('full','partial')` |
| `scope_note` | text | no | `''` | |
| `status` | text | no | | check in `('counting','submitted','posted','abandoned')` |
| `recount_threshold` | real | no | `500` | rupee value, no check |
| `started_at` | text | no | | |
| `started_by` | text | no | | FK -> `staff(id)` |
| `submitted_at` | text | yes | | |
| `submitted_by` | text | yes | | FK -> `staff(id)` |
| `posted_at` | text | yes | | |
| `posted_by` | text | yes | | FK -> `staff(id)` |
| `note` | text | no | `''` | |

Indexes: `stock_takes_pkey`, `stock_takes_reference_key`, and the partial unique
`stock_takes_one_open on ((1)) where status in ('counting','submitted')` — the
same constant-expression trick as the till.

### 1.24 `stock_take_lines`

A row exists only where somebody typed a number, so "not counted" and "counted
zero" cannot collapse into each other.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `stock_take_id` | text | no | | FK -> `stock_takes(id)` **on delete cascade** — the only cascade in the schema |
| `batch_id` | text | no | | FK -> `batches(id)` |
| `medicine_id` | text | no | | FK -> `medicines(id)` |
| `expected_quantity` | integer | no | | snapshotted at count time, not reread at posting |
| `counted_quantity` | integer | no | | check `>= 0` |
| `variance` | integer | no | | no check (signed) |
| `variance_value` | real | no | | no check (signed rupees) |
| `count_number` | integer | no | `1` | |
| `counted_by` | text | no | | FK -> `staff(id)` |
| `counted_at` | text | no | | |

Unique `(stock_take_id, batch_id)`. Indexes: `stock_take_lines_pkey`,
`stock_take_lines_stock_take_id_batch_id_key`, `stock_take_lines_take
(stock_take_id)`.

### 1.25 `clinic_settings`

One row, enforced.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | integer | no | `1` | PK, check `id = 1` |
| `name` | text | no | `'Jayamurugan Clinic'` | |
| `address` | text | no | `''` | |
| `phone` | text | no | `''` | |
| `email` | text | no | `''` | |
| `drug_licence_number` | text | no | `''` | |
| `doctor_registration_number` | text | no | `''` | |
| `gstin` | text | no | `''` | |
| `consultation_fee` | real | no | `0` | check `>= 0`. Never reaches a bill — see §3.5 |
| `footer_note` | text | no | `''` | |
| `updated_at` | text | no | | |
| `updated_by` | text | yes | | FK -> `staff(id)` |

The migration seeds row 1; it is present in the verified database.

### 1.26 `clinic_revision`

One row, one number, bumped inside every write transaction. The thing the
tablets poll.

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | integer | no | | PK. **No `check (id = 1)`**, unlike `clinic_settings` |
| `revision` | bigint | no | `0` | the only `bigint` column in the schema |
| `changed_at` | text | no | | |

Row 1 is seeded by `20260909125214_clinic_revision_row.sql` and is present in the
verified database. `revision` is `int8`, so postgres.js returns it as a **JS
string**; `db.ts` `currentRevision()` handles that explicitly.

### 1.27 `audit_events`

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `actor_id` | text | no | | FK -> `staff(id)` |
| `action` | text | no | | free text, e.g. `'bill.paid'` |
| `entity_type` | text | no | | free text |
| `entity_id` | text | no | | no FK |
| `summary` | text | no | | free text |
| `created_at` | text | no | | |

Indexes: `audit_events_pkey` only. The snapshot orders by `created_at desc limit
100` against no index.

### 1.28 `whatsapp_messages`

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `direction` | text | no | | check in `('inbound','outbound')` |
| `audience` | text | no | | check in `('patient','supplier')` |
| `phone` | text | no | | |
| `body` | text | no | | |
| `external_message_id` | text | yes | | |
| `status` | text | no | | **no check** |
| `related_type` | text | yes | | |
| `related_id` | text | yes | | no FK |
| `created_at` | text | no | | |

Indexes: `whatsapp_messages_pkey` only. Nothing in the snapshot reads this table.

### 1.29 `csv_imports`

| Column | Type | Null | Default | Constraint |
|---|---|---|---|---|
| `id` | text | no | | PK |
| `file_hash` | text | no | | **unique** |
| `row_count` | integer | no | | |
| `actor_id` | text | no | | FK -> `staff(id)` |
| `created_at` | text | no | | |

`file_hash` is the **only content-derived idempotency key in the whole schema**.
Every other unique constraint is either a surrogate id, a human-chosen code, or a
document number minted from a sequence — none of which stop a duplicate
*operation*.

### 1.30 Sequences

Five, all `bigint`, start 1, increment 1, created by
`20260909125224_document_numbers.sql` and `setval`'d past the highest number
already in the corresponding text column.

| Sequence | Prefix | Feeds |
|---|---|---|
| `appointment_token_seq` | `JMC-` | `appointments.token` |
| `otc_receipt_seq` | `OTC-` | `otc_sales.receipt_number` |
| `purchase_order_seq` | `PO-` | `purchase_orders.order_number` |
| `supplier_return_seq` | `RET-` | `supplier_returns.note_number` |
| `stock_take_seq` | `ST-` | `stock_takes.reference` |

`commands.ts` `sequence()` reads `nextval` **outside** the transaction, so a
rolled-back write burns its number and leaves a gap. That is deliberate: a
missing number is a question somebody asks, a repeated one is two documents that
cannot be told apart.

### 1.31 What the hardening migration adds

`20260909125237_harden_active_clinic.sql`. It was read out of the file first,
because at the time it could not be applied to a fresh database — it
hard-references the retired application's `public` views and `app.*`
functions and died on its first statement.

It has since been applied and verified live, with the staging-only legacy
stubs in place (`docs/STAGING.md` §3.2). Confirmed on 2026-09-10: **29 tables,
RLS enabled on all 29, zero rows in `pg_policies` for `jmc`, zero grants to
`anon`/`authenticated`/`service_role`, zero `anon` execute grants remaining on
`app.*`, and 90 indexes in the schema.**

- **Revokes** all privileges on the schema, tables, sequences and functions from
  `public`, `anon`, `authenticated` and `service_role`, and revokes the same by
  default for future objects. The Edge Functions connect on the owner's
  connection string, so this costs them nothing.
- **Enables RLS on all 29 tables and creates no policies.** With no policy, RLS
  denies everything to every role except the owner and `bypassrls`. That is the
  intent, but it means the brief §7 requirement to "write specific authorization
  policies" is currently satisfied by having none — anybody who later grants a
  role access to `jmc` gets an empty result set until policies exist.
- **Creates 41 FK-covering indexes** named `<table>_<column>_idx`, one for each
  referencing column that had none. Every "indexes:" line in §1.1–§1.29 lists
  only what is actually in the verified database; add these on top for the live
  shape. Postgres does not create them automatically, and their absence is why
  the ledger and audit reads scan.
- Sets `security_invoker = true` on 34 retired `public` views, and revokes
  `execute` from `anon` on five `app.*` functions including both `unlock_pin`
  overloads. These belong to the retired application, not to `jmc`.

---

## 2. Type mapping

### 2.1 There is one type source

`lib/types.ts` is not a copy. Its entire body is:

```ts
export * from '../supabase/functions/_shared/types.ts'
```

The page imports the backend's own declaration file. **Frontend/backend type
drift is impossible at the type level** — adding a field to
`supabase/functions/_shared/types.ts` adds it to both halves in the same edit,
and `npm run typecheck` sees the same declarations `deno check` does.

That is worth stating precisely, because it narrows where drift can hide. The
entire risk is in the **SQL-row-to-View conversion functions**, which are
untyped at the boundary: every reader is a `Record<string, unknown>` and every
field is produced by one of four coercion helpers plus, for the union types, a
bare `as` cast that TypeScript cannot check. A column that is renamed, dropped
from a `select`, or gated behind a role does not fail to compile. It arrives as
`''`, `0`, `false` or `undefined`.

### 2.2 The four helpers

All in `snapshot.ts` (lines 65–68). Every mapping below is one of these unless
noted.

| Helper | Body | What a null becomes | What a missing column becomes |
|---|---|---|---|
| `text(v)` | `String(v ?? '')` | `''` | `''` |
| `optional(v)` | `v == null ? undefined : String(v)` | `undefined` | `undefined` |
| `num(v)` | `Number(v ?? 0)` | `0` | `0` |
| `flag(v)` | `Boolean(Number(v ?? 0))` | `false` | `false` |

`num` also absorbs postgres.js's habit of returning `int8` (from `count(*)`,
`sum(integer)`) as a JS **string** — `Number('12')` is 12, so it works, silently.

### 2.3 Where each View is built

| View | Built in | Reached by |
|---|---|---|
| `SessionView` | `auth.ts` `toView()` (line 158) | `login`, and every authenticated request via `getSession` |
| all others in `ClinicSnapshot` | `snapshot.ts` `readSnapshot()` | `snapshot`, `login`, `command` |
| `TillView`, `TillCloseView` | `snapshot.ts` `readTill()` + inline | `snapshot` |
| `StockTakeView`, `StockTakeLineView` | `snapshot.ts` `readStockTake()` | `snapshot` |
| `ClinicSettingsView` | `snapshot.ts` `readSettings()` | `snapshot` |
| `PatientRecordView` | `snapshot.ts` `readPatientRecord()` | `record` only |
| `PrescriptionItemView` | never built from SQL — `JSON.parse` of `items_json` | `snapshot`, `record` |
| lock-screen staff (not a `*View`) | `auth.ts` `lockScreenStaff()` | `staff`, unauthenticated |

### 2.4 Field-by-field

`SessionView` — `auth.ts` `toView`, from `sessions` joined to `staff`.

| Field | SQL source | Conversion |
|---|---|---|
| `staffId` | `sessions.staff_id` | direct |
| `name` | `staff.name` | direct |
| `roles` | `staff.roles_json` | `JSON.parse` -> `Role[]`, unvalidated |
| `username` | `staff.username` | direct |
| `lastSeen` | `sessions.last_seen` | direct. Overwritten with `isoNow()` when `touch` |

`StaffView` — `snapshot.ts:288`. Gated on `admin`; **`[]` for everyone else**.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `name` `username` `phone` | same-named columns | `text` |
| `roles` | `staff.roles_json` | `JSON.parse` -> `Role[]` |
| `active` | `staff.active` integer | `flag`: integer -> boolean |
| `lastLogin` | `staff.last_login` | `optional`: null -> `undefined` |

`PatientView` — `snapshot.ts:312`. **Two different queries.**

| Field | SQL source | Conversion |
|---|---|---|
| `id` | `patients.id` | `text` |
| `name` | `patients.name`, **only when the session holds admin/doctor/nurse** | `text`; otherwise `''` |
| `age` | `patients.age` integer, same gate | `num`; otherwise `0` |
| `sex` | `patients.sex`, same gate | `text` + `as PatientView['sex']`; **otherwise `''`, which is not a member of the declared union** |
| `phone` | `patients.phone`, same gate | `text`; otherwise `''` |
| `address` | **nothing** | hardcoded `''` at line 318. `patients.address` is read only by `register/index.ts:94` for the H1 register |
| `whatsappConsent` | `patients.whatsapp_consent` integer, same gate | `flag` |
| `createdAt` | `patients.created_at`, same gate | `text`; otherwise `''` |

`AppointmentView` — `snapshot.ts:324`, ungated.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `patientId` `token` `reason` `scheduledAt` | `appointments.*` | `text` |
| `patientName` | `patients.name` via join | `text` |
| `status` | `appointments.status` | `text` + unchecked `as` |

`VitalView` — `snapshot.ts:334` (limit 200) and `readPatientRecord` (all).
Gated on admin/doctor/nurse in the snapshot.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `patientId` `bp` `recordedAt` | `vitals.*` | `text` |
| `temperature` `weight` | `vitals.*` **real** | `num`: float4 -> JS number |
| `pulse` `spo2` | `vitals.*` integer | `num` |
| `recordedBy` | `staff.name` via join — **the name, not the id** | `text` |

`EncounterView` — `snapshot.ts:347` (limit 100) and `readPatientRecord`.
Gated on `doctor` in the snapshot; an admin gets `[]`.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `patientId` `diagnosis` `notes` `advice` `createdAt` | `encounters.*` | `text` |
| `patientName` | `patients.name` via join | `text` |
| `doctorName` | `staff.name` via join | `text` |

`PrescriptionView` / `PrescriptionItemView` — `snapshot.ts:361` and
`readPatientRecord`. Gated on `pharmacy` in the snapshot.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `patientId` `signedAt` | `prescriptions.*` | `text` |
| `patientName` `doctorName` | joins | `text` |
| `items` | `prescriptions.items_json` | **`JSON.parse(text(...)) as PrescriptionItemView[]`** — no schema check, no try/catch. The five item fields (`medicineId`, `medicineName`, `dosage`, `instructions`, `quantity`) exist only inside this string |
| `dispensedAt` | `prescriptions.dispensed_at` | `optional` |

`BillView` — `snapshot.ts:373` (ungated) and `readPatientRecord`.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `patientId` `label` `createdAt` | `bills.*` | `text` |
| `patientName` | join | `text` |
| `amount` | `bills.amount` **real** | `num`: float4 -> JS number |
| `status` | `bills.status` | `text` + `as` (db-checked) |
| `paymentMethod` | `bills.payment_method` | `optional` + `as`; **the db has no check here** |
| `paidAt` | `bills.paid_at` | `optional` |

`BedView` — `snapshot.ts:381`, ungated.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `label` | `beds.*` | `text` |
| `status` | `beds.status` | `text` + `as` (db-checked) |
| `patientId` `admittedAt` | `beds.*` nullable | `optional` |
| `patientName` | `patients.name` via **left** join | `optional` |
| `notes` | `beds.notes` — `not null default ''` | `optional`, so it is never actually `undefined` despite being declared `notes?` |

`MedicineView` — `snapshot.ts:387`, ungated.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `code` `name` `strength` `dosageForm` `unit` `barcode` | `medicines.*` | `text` |
| `saleClass` `schedule` | `medicines.*` | `text` + `as` (both db-checked) |
| `reorderLevel` `targetStock` | integer | `num` |
| `preferredSupplierId` | nullable FK | `optional` |
| `preferredSupplierName` | `suppliers.name` via left join | `optional` |
| `totalAvailable` | **derived**: `coalesce((select sum(b.available_quantity) from batches b where b.medicine_id = m.id and b.expiry::date >= (now() at time zone 'Asia/Kolkata')::date), 0)` | `num`; `sum(int4)` is `int8`, arrives as a string |
| `active` | `medicines.active` integer | `flag` |

`BatchView` — `snapshot.ts:400`. Gated on admin/doctor/pharmacy; a nurse gets `[]`.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `medicineId` `batchNumber` `expiry` `receivedAt` | `batches.*` | `text` — `expiry` travels as the raw stored string |
| `medicineName` | join | `text` |
| `availableQuantity` | integer | `num` |
| `mrp` `purchasePrice` `sellingPrice` | **real** | `num`: float4 -> JS number |
| `receivedFromSupplierId` | nullable FK | `optional` |
| `receivedFromSupplierName` | left join | `optional` |

`SupplierView` — `snapshot.ts:428`. Gated on admin/pharmacy.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `code` `name` `contactPerson` `whatsapp` `phone` `email` `address` `gstin` | `suppliers.*` | `text` |
| `active` | integer | `flag` |
| `returnWindowDays` | integer | `num` |
| `medicineIds` | **`supplier_medicines` where `active=1`**, folded in JS into a `Map<supplier_id, string[]>` (lines 417–426) | `[]` when the supplier has none |

`TillView` — `snapshot.ts` `readTill()`. Gated on admin/nurse/pharmacy. `null`
when no row has `closed_at is null`.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `openedAt` | `till_sessions.*` | `text` |
| `openedBy` | second query, `staff.name` | `text` |
| `openingFloat` | `till_sessions.opening_float` **real** | `num` |
| `cashFromBills` | `sum(bills.amount) where status='paid' and payment_method='cash' and paid_at >= opened_at` | `num`; **`sum(real)` is `real`** — see §3.1 |
| `cashFromSales` | `sum(otc_sales.total) where payment_method='cash' and created_at >= opened_at` | `num`; same |
| `cashIn` / `cashOut` | `sum(cash_movements.amount)` split by `direction` | `num`; same |
| `expectedCash` | **not stored** — computed in JS: `openingFloat + cashFromBills + cashFromSales + cashIn - cashOut` | float arithmetic on float4-derived values |
| `movements[]` | `cash_movements` joined to `staff` | `id`/`reason`/`at`(`created_at`)/`actorName` `text`; `direction` `text`+`as`; `amount` `num` from real |

Card and UPI are deliberately excluded from `expectedCash`: they never reach the
drawer.

`TillCloseView` — `snapshot.ts:504`, inline, limit 30.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `openedAt` `closedAt` `note` | `till_sessions.*` | `text` |
| `closedBy` | `staff.name` via left join | `text` (`''` if the staff row is gone) |
| `openingFloat` `countedCash` `expectedCash` `variance` | **real**, all four stored | `num` |

`StockTakeView` / `StockTakeLineView` — `readStockTake()`. Gated on
admin/doctor/pharmacy.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `reference` `scopeNote` `startedAt` | `stock_takes.*` | `text` |
| `scope` `status` | `stock_takes.*` | `text` + `as` (db-checked) |
| `recountThreshold` | **real** | `num` |
| `startedBy` / `submittedBy` | `staff.name` via join / left join | `text` / conditional |
| `submittedAt` | nullable | `take.submitted_at ? text(...) : undefined` |
| `varianceVisible` | **derived in JS**: `status === 'submitted'` | not stored |
| `lines[].id` `batchId` `medicineName` `batchNumber` `countedAt` | line + joins | `text` |
| `lines[].countedQuantity` `countNumber` | integer | `num` |
| `lines[].countedBy` | `staff.name` | `text` |
| `lines[].expectedQuantity` `variance` | integer | `num`, **omitted entirely while `status='counting'`** |
| `lines[].varianceValue` | **real** | `num`, same omission |
| `lines[].needsRecount` | **derived in JS**: `abs(variance_value) > recount_threshold && count_number < 2` | same omission |

The blind rule is enforced on the wire, not in the panel: while counting, the
expected quantity and variance are never sent, so there is nothing in the network
tab for a counter to read.

`StockTakeHistoryView` — `snapshot.ts:514`, limit 20, statuses `posted` and
`abandoned`.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `reference` `startedAt` | `stock_takes.*` | `text` |
| `scope` `status` | `text` + `as` |
| `finishedAt` | `coalesce(posted_at, started_at)` resolved in **JS**: `text(r.posted_at ?? r.started_at)` | |
| `finishedBy` | `staff.name` via `coalesce(posted_by, submitted_by, started_by)` | `text` |
| `batchesCounted` | `count(*)` of lines | `num` (int8 -> string -> number) |
| `batchesCorrected` | `count(*) where variance <> 0`, **forced to 0 in JS when status is `abandoned`** | `num` |
| `netValue` | `sum(variance_value)` (real), **forced to 0 in JS when `abandoned`** | `num` |

`StockWriteoffView` — `snapshot.ts:537`, limit 100. Gated on admin/pharmacy.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `medicineName` `batchNumber` `note` `actorName` | columns + joins | `text` |
| `date` | `stock_writeoffs.created_at` | **`text(...).slice(0, 10)`** — the first ten characters of the stored string |
| `quantity` | integer | `num` |
| `reason` | `text` + `as` (db-checked) |
| `costValue` | **real** | `num` |

`SupplierReturnView` — `snapshot.ts:550`, limit 100. Gated on admin/pharmacy.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `noteNumber` `supplierName` `medicineName` `batchNumber` | columns + joins | `text` |
| `date` | `supplier_returns.created_at` | `text(...).slice(0, 10)` |
| `quantity` | integer | `num` |
| `expectedCredit` | **real** | `num` |
| `status` | `text` + `as` (db-checked). `settled_at` is **not** mapped into any view |

`PurchaseOrderView` / `OrderLineView` — `snapshot.ts:437` and `:455`. Gated on
admin/pharmacy.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `orderNumber` `supplierId` `requestedDate` `messageDraft` `createdAt` | `purchase_orders.*` | `text` |
| `supplierName` | join | `text` |
| `status` | `text` + `as` (db-checked) |
| `messageStatus` | `purchase_orders.message_status` | `optional` + `as`; **no db check backs the union** |
| `placedAt` | nullable | `optional` |
| `lines[]` | `purchase_order_lines` joined to `medicines`, folded in JS into a `Map<order_id, lines[]>` | `id`/`medicineId`/`medicineName` `text`; `orderedQuantity`/`receivedQuantity` `num` |

`purchase_orders.external_message_id` is not mapped into any view.

`OtcSaleView` — `snapshot.ts:467`, limit 100. Gated on admin/nurse/pharmacy.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `receiptNumber` `createdAt` | `otc_sales.*` | `text` |
| `total` | **real** | `num` |
| `paymentMethod` | `text` + `as` (db-checked) |
| `lineCount` | **`json_array_length(lines_json::json)` computed in SQL** | `num`. The lines themselves never leave the database |

`AuditView` — `snapshot.ts:475`, limit 100. Gated on `admin`.

| Field | SQL source | Conversion |
|---|---|---|
| `id` `action` `entityType` `summary` `createdAt` | `audit_events.*` | `text` |
| `actorName` | `staff.name` via join | `text` |

`audit_events.entity_id` is deliberately not mapped into the view.

`ClinicSettingsView` — `readSettings()`, ungated.

| Field | SQL source | Conversion |
|---|---|---|
| `name` | `clinic_settings.name` | `text(...) \|\| 'Jayamurugan Clinic'` |
| `address` `phone` `email` `drugLicenceNumber` `doctorRegistrationNumber` `gstin` `footerNote` `updatedAt` | same-named columns | `text` |
| `consultationFee` | `clinic_settings.consultation_fee` **real** | `num`. Displayed on the Clinic screen and read by nothing else — see §3.5 |
| `complete` | **derived in JS**: `Boolean(drugLicenceNumber && doctorRegistrationNumber)` | not stored |

`clinic_settings.updated_by` is not mapped into any view.

`ClinicSnapshot` (composite) — the seven fields that are not a table read:

| Field | Source |
|---|---|
| `session` | passed in, from `auth.ts` |
| `doctorPresent` | `auth.ts` `doctorLoggedIn()`: `count(*)` over `sessions join staff` with `st.roles_json like '%"doctor"%'` and `s.expires_at > isoNow()`. The `count` is an `int8` that arrives as a JS string and is compared `> 0` by coercion |
| `whatsapp.configured` | `whatsapp.ts`: all four of the `WHATSAPP_*` env values present |
| `whatsapp.businessNumberConfigured` | phone-number id present |
| `whatsapp.note` | a fixed string chosen from `configured` |
| `till` / `stockTake` | `null` when no open row **or** when the role gate closes — the screens cannot tell those apart |
| every gated array | `[]` when the role gate closes — again indistinguishable from "no rows" |

### 2.5 The two day-boundary expressions

Both are SQL fragments interpolated into query strings, not parameters.

| Constant | Where | Expression | Used by |
|---|---|---|---|
| `CLINIC_DAY_START` | `snapshot.ts:44` | `to_char((date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` | the appointment, prescription and bill day windows — compared against **text** columns as strings |
| `CLINIC_TODAY` | `snapshot.ts:61` **and** `commands.ts:20`, defined twice | `(now() at time zone 'Asia/Kolkata')::date` | `expiry::date >= …` in `snapshot.ts:388`, `commands.ts:214` (FEFO), `commands.ts:1202` and `:1204` (reorder) |

Neither uses `current_date`. Between 00:00 and 05:30 IST the server's date is
still yesterday's, and a batch that expired last night would otherwise keep
counting towards `totalAvailable` through exactly the stretch when the pharmacy
is opened up. `CLINIC_TODAY` being defined twice in two files is the drift risk:
the number a dispense is checked against must be the number the screen showed.

---

## 3. Representation hazards

Each of these is a place where what is stored is weaker than what it represents.
Every claim below was checked against the verified schema.

### 3.1 Money is `real`

`real` is IEEE 754 binary32: a 24-bit mantissa, about seven significant decimal
digits, and no exact representation of most rupee-and-paise values.

Every money column in the schema:

| Table | Columns |
|---|---|
| `bills` | `amount` |
| `batches` | `mrp`, `purchase_price`, `selling_price` |
| `clinic_settings` | `consultation_fee` |
| `otc_sales` | `total` |
| `till_sessions` | `opening_float`, `counted_cash`, `expected_cash`, `variance` |
| `cash_movements` | `amount` |
| `stock_writeoffs` | `cost_value` |
| `supplier_returns` | `expected_credit` |
| `stock_takes` | `recount_threshold` |
| `stock_take_lines` | `variance_value` |

There is no `numeric` column anywhere in `jmc`.

**Verified failure.** 100 rows of `33.33::real` summed in Postgres:

```
select pg_typeof(sum(a)), sum(a) from t;
 real | 3333.002
```

`sum(real)` returns `real`, not `double precision`, so the error is not even
promoted away during aggregation. The exact answer is 3333.00.

That sum is exactly the shape of `readTill()`'s `cashFromBills` and
`cashFromSales`. The concrete failure: `expectedCash` is computed in JS from four
such sums, `counted_cash` is what a human counted, and `variance` is stored at
close. On a normal day the drawer reconciles to a variance of a fraction of a
paisa that no one can explain and no one can make go away — and once staff learn
that the variance is always a small nonsense number, they stop reading it, which
is the failure the whole day-close exists to prevent.

Second-order detail: the `>= 0` checks render in the catalogue as `amount >=
(0)::double precision`. The comparison widens the float4 to float8, so the check
is correct; only the stored value is lossy.

Slice 3 and Slice 4 both require exact decimal money. Nothing here can be
narrowed to `numeric` without deciding what the existing float4 values *meant*.

### 3.2 Timestamps are `text`

There is not one `timestamptz` or `timestamp` column in `jmc`. Every `*_at`,
`expires_at`, `last_login`, `scheduled_at`, `signed_at`, `expiry`,
`requested_date`, `settled_at`, `failed_at` and `changed_at` is `text`, with no
format check on any of them.

Two different textual formats are written into the same columns:

- the application writes `new Date().toISOString()` — `2026-09-10T05:00:00.000Z`,
  with milliseconds (`db.ts` `isoNow()`);
- the migrations write `to_char(now() at time zone 'utc',
  'YYYY-MM-DD"T"HH24:MI:SS"Z"')` — `2026-09-10T05:00:00Z`, **without**
  milliseconds, and so does `CLINIC_DAY_START` on every snapshot poll.

**What compares them.**

*Session expiry is a JavaScript string comparison.* `auth.ts:178`:

```ts
if (!row || !row.active || row.expires_at <= isoNow()) { … delete … }
```

No date parsing on either side. It gives the right answer today only because both
values happen to be fixed-width UTC ISO-8601 with a `Z`. Verified in Postgres,
which orders text the same way: `'2026-09-10T05:00:00.000Z' <= '2026-09-10T05:00:00Z'`
is **true**, because `'.'` (0x2E) sorts before `'Z'` (0x5A) — so the two shapes
of the same instant are not equal and a no-millisecond expiry survives up to a
second longer. Introduce a `+05:30` offset instead of `Z` and the ordering
inverts outright: a session issued in local time would compare as expired
immediately, or never.

*Expiry is cast at query time.* `expiry::date >= (now() at time zone
'Asia/Kolkata')::date` runs in `snapshot.ts:388`, `commands.ts:214`,
`commands.ts:1202` and `commands.ts:1204`. `batches.expiry` has no format check.
One row whose `expiry` is not date-parsable raises `invalid input syntax for type
date` and takes down **the whole medicines query**, so every tablet gets an error
rather than one wrong row.

*The day windows are string prefixes.* `readTill()` compares `paid_at >=
?` and `created_at >= ?` against the till's own `opened_at` text; the queue, bill
and prescription lists compare against `CLINIC_DAY_START`. Any row ever written
with a different textual shape silently falls outside the window instead of
raising anything.

*Nothing can be indexed usefully.* `stock_writeoffs_created` is the only index on
any timestamp column in the schema, and the snapshot filters or orders by
`appointments.scheduled_at`, `bills.created_at`, `prescriptions.signed_at`,
`otc_sales.created_at`, `audit_events.created_at`, `stock_takes.posted_at` and
`till_sessions.closed_at` on every poll, every fifteen seconds, from every
tablet.

Brief §7 requires timezone-aware timestamps for events. Nothing in the schema is
one.

### 3.3 `medicines.unit` is free text

`unit text not null`, no check constraint, no reference table, no conversion
factor stored anywhere in the schema. It is set by the `add_medicine` command and
by the CSV importer, which accepts any non-empty string
(`csv/index.ts:102`).

`batches.available_quantity` is an integer count of an unnamed thing. So `10` in
a batch whose medicine says `strip` and `10` in a batch whose medicine says
`tablet` are added together by `MedicineView.totalAvailable`'s
`sum(b.available_quantity)`. Nothing in the database says they are different
things, and nothing in the code converts.

The concrete failure: the shelf figure a pharmacist reads before dispensing, and
the reorder suggestion in `commands.ts:1202`, are sums over incommensurable
units. `tab`, `tablet`, `Tablets` and `TAB` are four different units to this
schema and one thing to the clinic.

Slice 3 requires an integer base unit per product and conversion factors on a
versioned package SKU. There is nothing here to migrate from — the base unit was
never recorded, only a label.

### 3.4 `prescriptions.items_json` is the only record of the lines

There is no prescription-lines table among the 29. The prescribed medicine, its
dosage, its instructions and its quantity exist only as a JSON string.

It is read with a bare `JSON.parse(text(r.items_json))` in `snapshot.ts:367` and
`snapshot.ts:612`, inside a `.map()`, with no schema validation and no
`try`/`catch`. One malformed row throws out of the mapper and the whole
`/snapshot` request fails — for every tablet holding the pharmacy role, not just
for that prescription. The same shape of hazard applies to
`otc_sales.lines_json`, which is cast **inside the SQL** as
`json_array_length(lines_json::json)` (`snapshot.ts:469`): invalid JSON in one
row fails the OTC query for the whole clinic.

`dispensed_at` is one nullable timestamp for the entire prescription. `dispense_rx`
(`commands.ts:1174`) allocates the **full** prescribed quantity of **every** item
or throws:

```ts
for (const item of items) {
  await allocateStock(item.medicineId, item.quantity, …)
}
await db.prepare('update prescriptions set dispensed_at=? where id=? and dispensed_at is null')
```

Consequences, all concrete:

- A patient who takes 10 of 30 tablets cannot be recorded. The counter dispenses
  everything or nothing.
- There is no per-line record of what was actually handed over, and
  `stock_movements.reference_id` points at the prescription, not at a line — so
  "what did this patient actually receive" cannot be answered from the ledger.
- One item out of stock fails the whole prescription.
- **`dispense_rx` creates no bill at all.** Medicines handed over against a
  prescription are never charged. Grep confirms exactly one `insert into bills`
  in the codebase, and it is in `save_consultation`.

### 3.5 `bills.status` is two values and `payment_method` sits on the bill

`status text check in ('unpaid','paid')`. `payment_method text` **with no check
constraint at all** — validated only in `commands.ts` `requireChoice`. `paid_at
text` nullable. There is no payments table, no allocations table, and no bill
lines table.

`pay_bill` is the whole payment model:

```sql
update bills set status='paid', payment_method=?, paid_at=? where id=? and status='unpaid'
```

One method, one moment, the whole amount. What cannot be represented: a part
payment, a cash + UPI split, a pay-later balance, a refund, a reversal, a waiver,
or a discount. Recording a split forces the counter to write down a payment
method that is not what happened.

And the fee itself does not come from the database. `save_consultation`
(`commands.ts:341`) reads `Number(payload.consultationFee ?? 0)` — a value posted
by the browser. The form field that supplies it is at
`components/care-workspaces.tsx:378` and its default is the hardcoded string
`"300"`, not `settings.consultationFee`. **`clinic_settings.consultation_fee` is
written by the admin Clinic screen, echoed back into that same screen's own
default value, and read by nothing else.** The number on the bill and the number
in the settings table have never been connected.

There is also no source key: nothing stops `save_consultation` being retried and
writing a second encounter, a second prescription and a second consultation bill.

Brief §7 requires immutable bill lines plus payment allocations, with
Unpaid/Part-paid/Paid derived. None of the three exists, and the existing rows
carry no allocation history to reconstruct them from.

### 3.6 `staff.roles_json` is text, searched with `like`

`roles_json text not null`, no check, holding a JSON array. Parsed with an
unguarded `JSON.parse` in three places (`auth.ts:109`, `auth.ts:163`,
`snapshot.ts:291`). Nothing in the database restricts its contents to the four
`Role` values, or to a JSON array at all.

It is also searched **as a string**, in `auth.ts:202`:

```sql
select count(*) from sessions s join staff st on st.id=s.staff_id
 where st.active=1 and st.roles_json like '%"doctor"%' and s.expires_at>?
```

That query decides `ClinicSnapshot.doctorPresent`, which the whole clinic reads.
Its failures:

- Any future role whose name contains `doctor` — `"doctor_assistant"`,
  `"junior_doctor"` — makes the clinic report a doctor present with no doctor in
  the building.
- A leading-wildcard `like` cannot use any index. This is a sequential scan of
  `sessions` joined to `staff`, on every snapshot, from every tablet, every
  fifteen seconds. `sessions` has no index on `staff_id` in the verified database
  (that one is in the file-only hardening migration).
- `expires_at>?` is the same lexical text comparison as §3.2.
- `count(*)` is `int8`, which postgres.js returns as a JS **string**; the code
  does `row.count > 0`, which works only because JS coerces the string in a
  relational comparison. `recentFailures()` two functions above writes
  `count(*)::int` explicitly, so the codebase is not consistent about this.

### 3.7 `appointments.token` has no unique index

Verified: the only index on `appointments` is `appointments_pkey`.

This is deliberate, and the reason is written into
`20260909125224_document_numbers.sql`:

> The queue token is the same bug with the alarm disconnected:
> `appointments.token` carries no unique index, so nothing complains at all. Two
> waiting patients simply hold JMC-0004, and one of them is called in for the
> other's consultation. That index is deliberately NOT added here. This has to
> apply to a database that has been running a clinic for months, duplicate tokens
> are precisely what such a database is likely to be holding, and a migration
> that fails on the damage it exists to stop helps nobody.

So the *minting* is fixed — `appointment_token_seq` hands each number to exactly
one caller — but the *table* is not constrained, the historic duplicates are
still there, and nothing detects or reports them. Any slice that adds the index
must first find and resolve the duplicates.

### 3.8 `active integer` is a boolean

Four columns: `staff.active`, `medicines.active`, `suppliers.active`,
`supplier_medicines.active`. All `integer not null default 1`. Verified: **none
of the four has a check constraint**, so `active = 2` and `active = -1` are
storable.

They are read three incompatible ways:

| Reader | Test | Result for `active = 2` |
|---|---|---|
| `snapshot.ts` `flag()` | `Boolean(Number(v ?? 0))` | `true` — the tablet shows it active |
| every SQL predicate (`auth.ts:103`, `snapshot.ts:418`, `commands.ts`, `csv/index.ts`) | `active=1` | **excluded** — invisible to the lock screen, the CSV export, the supplier fold-in |
| `auth.ts:136` | `if (!staff \|\| !staff.active \|\| …)` — JS truthiness on a number | passes |

So one row can simultaneously appear active on a screen, be missing from the lock
screen, and be allowed to sign in. `whatsapp_consent` and `clinic_revision.id`
have the same shape of problem in miniature: `patients.whatsapp_consent` is an
unchecked integer boolean, and `clinic_revision` has no `check (id = 1)` even
though `clinic_settings` does — so the revision table can grow a second row that
no query would ever see.

### 3.9 Smaller ones, listed because a later slice will trip on them

- **`stock_movements.movement_type` carries no information.** Both call sites
  that write it — `removeFromBatch` and `allocateStock` in `commands.ts` — pass
  the same `referenceType` argument into `movement_type` *and* `reference_type`.
  Neither column has a check. The ledger cannot distinguish a dispense from a
  write-off by type; only by `reference_type`, which says the same thing.
- **`stock_movements.reference_id` has no foreign key** and points into four
  different tables by convention. Nothing can enforce that the referent exists.
- **No idempotency anywhere except `csv_imports.file_hash`.** Brief §7 requires
  unique source keys for encounter completion, dispensing, goods receipt, billing
  and payment. There are none. A retried request duplicates the work.
- **`patients.age` is an integer, not a date of birth.** Every record is wrong
  from its first birthday onward, and there is nothing to recompute from.
- **`purchase_order_lines.received_quantity`** has `>= 0` but no check that it
  does not exceed `ordered_quantity`.
- **`purchase_orders.message_status` and `whatsapp_messages.status`** are
  unconstrained nullable/`not null` text backing TypeScript unions.
- **`suppliers.whatsapp`** is free text with no country-code normalization, which
  is what the WhatsApp deep link consumes.
- **RLS is enabled with zero policies** by the hardening migration. Correct for
  the current owner-connection design, and a trap for anyone who later grants a
  role access to `jmc` and expects it to work.

---

## 4. Slice-by-slice impact index

Which tables and which `*View` types each later slice must touch. This is a
planning aid drawn from brief §6; it proposes nothing.

| Slice | Tables | Views |
|---|---|---|
| **1** — four-digit PIN, shared patient context | `staff` (PIN format/version marker alongside `pin_hash`/`pin_salt`), `sessions` (revocation on reset), `pin_attempts`, `patients` (duplicate suggestion needs an index on name/phone; there is none), `appointments` (doctor-alone check-in) | `StaffView`, `SessionView`, `PatientView`, `AppointmentView` |
| **2** — doctor and nurse workspaces | `encounters` (structured complaint, duration, examination, follow-up), `prescriptions` (normalized header and lines; `items_json` retires), `vitals` (all four numeric columns are `not null`, so "Not measured" is unrepresentable), `appointments`, `medicines` (search by generic/ingredient/barcode), plus new tables for templates, dictionaries, recents/favourites, and reprint audit | `EncounterView`, `PrescriptionView`, `PrescriptionItemView`, `VitalView`, `MedicineView`, `AppointmentView` |
| **3** — medicine identity, packages, stock | `medicines` splits along substance / clinical drug / product / versioned package SKU; `batches` (references a package version, immutable receipt-time snapshot, quarantine and recall state); `stock_movements` (becomes the truth; `movement_type` must gain meaning); `supplier_medicines`; `purchase_orders` and `purchase_order_lines` (goods receipts, partial, quarantine); `stock_takes`, `stock_take_lines`; `stock_writeoffs`; `supplier_returns`; every money column off `real` | `MedicineView`, `BatchView`, `SupplierView`, `OrderLineView`, `PurchaseOrderView`, `StockTakeView`, `StockTakeLineView`, `StockTakeHistoryView`, `StockWriteoffView`, `SupplierReturnView` |
| **4** — dispensing, consultation fee, bills, payments | `prescriptions` plus new dispense header / lines / batch allocations; `bills` becomes immutable lines with derived status; new payments and payment allocations; `clinic_settings.consultation_fee` must actually be read (§3.5); `encounters` gains the fee's unique source key; `otc_sales`; `till_sessions` and `cash_movements` reconcile against real payments; `stock_movements` | `PrescriptionView`, `BillView`, `OtcSaleView`, `TillView`, `TillCloseView`, `ClinicSettingsView`, plus new dispense and payment views |
| **5** — clinical images | new image series, image objects, consent, and image-access-log tables, referencing `encounters` and `patients`. Nothing may enter `ClinicSnapshot` | new views only; `EncounterView` gains image-series status |
| **6** — admin and rollout | `audit_events` (image access, reprints, approvals); reporting reads across `batches`, `stock_movements`, `bills` + payments, `supplier_returns`, `stock_writeoffs`, `purchase_orders`, `prescriptions`; `clinic_settings` | `AuditView`, `ClinicSettingsView`, plus report views fetched on demand rather than added to the snapshot |

---

## 5. Slice 2 delta

§1 characterizes the schema Slice 0 found. This section records what Slice 2
added on top of it, so the two are never confused: everything above was read
from a database built before this work, everything here was added by it.

Thirteen tables, taking `jmc` from 29 to 42, across two migrations:
`20260911045325_slice2_doctor_nurse_workspaces.sql` and
`20260911120000_slice2_clinical_vocabulary.sql`.

| Table | Holds | Written by |
|---|---|---|
| `prescription_lines` | the signed prescription, normalized — one row per medicine, with the identity snapshot taken from the formulary at signing | `sign_consultation` |
| `consultation_drafts` · `consultation_draft_lines` | one unsigned sheet per doctor per patient, server-side so it survives sign-out | `save_consultation_draft` |
| `clinical_vocabulary_releases` | the versioned approved vocabulary, with the approval reference it came from | migration only |
| `clinical_phrases` | the clinic-wide wording the doctor is offered | migration; `publish_clinical_phrase` |
| `clinical_phrase_preferences` | one doctor's favourites and use counts | `set_clinical_phrase_favourite`, and signing |
| `consultation_templates` · `consultation_template_lines` | versioned personal and clinic templates | `save_clinical_template` |
| `follow_ups` | the follow-up a signed encounter asked for | `sign_consultation` |
| `prescription_prints` | one row per physical copy, numbered | `record_prescription_print` |
| `patient_clinical_profiles` | allergy status and clinical flags | `save_patient_clinical_profile` |
| `vital_review_rules` | the approved "Review this reading" prompts | migration/admin only; never inferred |
| `observation_events` | the bed timeline: admit, note, instruction, handoff, discharge | `update_bed`, `record_observation`, and the handoff commands |

### 5.1 These tables do not follow §3's representation hazards

§3 records that the Slice 0 schema has no `timestamptz`, `numeric`, `boolean`,
`uuid` or enum — everything is `text`, `integer` or `real`. The Slice 2 tables
deliberately break that pattern rather than extend it: event times are
`timestamptz`, dates are `date`, quantities are `integer`, and every closed set
of values is a `check` constraint. Flags stay `integer 0/1` to match the
surrounding code, which is the one legacy shape kept on purpose.

Money is untouched here. `real` money is still a Slice 3/4 problem.

### 5.2 What may change after it is written

Append-only is enforced by trigger, not by convention:

| Trigger | Refuses |
|---|---|
| `prescriptions_signed_immutable` | any change to a signed prescription's patient, doctor, encounter, items or number; any delete |
| `prescription_lines_immutable` | every update and delete |
| `consultation_templates_versioned` | editing a template version; deleting one. Retiring is the only permitted update |
| `consultation_template_lines_immutable` | every update and delete |
| `clinical_phrases_approved_immutable` | rewording or deleting approved wording. Only `active` and `retired_at` may move |

The legacy `prescriptions.dispensed_at` marker is explicitly still writable —
Slice 4 replaces it with dispense events.

### 5.3 The clinical vocabulary is governed content, not seed data

This is the part most easily lost, so it is written down rather than implied.

**It is versioned.** `clinical_vocabulary_releases` holds one row per approved
release — `en-2026.09` is the first — carrying the version, the locale, the
approval reference and the date the owner approved it. Every phrase installed
by a release points at it. Revising the vocabulary means publishing a new
release beside this one, never editing the rows of the old one, which is what
`CLINICAL_TERMINOLOGY_AND_MEDICINE_DATA_RESEARCH.md` §2.4 requires so that old
visits stay intelligible.

**The wording is transcribed, not authored.** All eighty phrases are copied
verbatim from `SLICE3_CLINIC_APPROVAL_PACK.md` §7.A–D, which §8.C of that
document records as signed off on 11 September 2026 and which
`OWNER_POLICY_REGISTER.md` A.5 approves. Nothing was reworded on the way into
the database: what the doctor approved is what the doctor sees. Changing a
phrase is a new release, and it needs the doctor again — not a better sentence
from whoever is editing the migration.

**It is attributed.** `clinical_phrases` carries either a `release_id` or an
`approved_by` staff member, and a check constraint refuses a row with neither.
A clinic-wide suggestion with no stated source cannot be written.

**It is the four lists the owner approved, and no more.** Twenty complaints,
twenty assessments, twenty dosage directions, twenty pieces of advice. The
`examination` kind exists in the table and is deliberately empty: the owner
approved four lists, and writing findings wording would be inventing clinical
policy. It contains no SNOMED CT, CDCI or commercial catalogue content, because
the licensing in §2.3 of the research document is a Phase 0 gate that has not
been cleared.

**Three layers, and only one of them is clinic-wide.** The doctor sees the
approved release, plus their own favourites and recents from
`clinical_phrase_preferences`, ranked favourites-first. Signing a consultation
writes to the preferences table only — a doctor's wording never joins the
clinic-wide list as a side effect of using it. Changing the clinic-wide list
takes the `can_publish_clinical_templates` authority, which is the same
authority A.6 grants over clinic templates; an admin who is not a doctor cannot
do it at all.

**It is reference data.** Migrations install it and nothing in a clinic day
removes it. `tests/support/clinic.mjs` therefore carries it across the truncate
between tests, and refuses to run if it is absent rather than testing an
autocomplete with nothing in it.

---

## 6. Slice 2.1 delta: history that says "unknown"

Running the Slice 2 backfill against a clinic that already had prescriptions —
which `npm run staging:rehearse` does, and which nothing had done before —
showed it making two decisions nobody approved.

| Legacy item | Slice 2 did | Slice 2.1 does |
|---|---|---|
| medicine row no longer exists | produced **no line at all** | a line with `medicine_state = 'unresolved_legacy'` and `medicine_id` null |
| `quantity` missing, `0`, or not a number | became **quantity 1** | `prescribed_quantity` null, `quantity_state = 'unknown_legacy'` |

Both mattered. A signed prescription that quietly loses a line is worse than
one that says it cannot read it; and quantity 1 is not a cautious default but a
different prescription, which from Slice 4 becomes the cap on what the pharmacy
may hand over.

### 6.1 The columns

`prescription_lines.medicine_id` and `prescription_lines.prescribed_quantity`
became nullable, paired with two state columns and four checks:

```sql
check (medicine_state in ('resolved', 'unresolved_legacy'))
check ((medicine_state = 'resolved') = (medicine_id is not null))
check (quantity_state in ('recorded', 'unknown_legacy'))
check ((quantity_state = 'recorded') = (prescribed_quantity is not null))
```

The agreement checks are the load-bearing pair: a line cannot claim to be
unresolved while carrying a medicine id, which is exactly the automatic
reconnection the migration refuses to make. The original column check
`prescribed_quantity > 0` is kept and still applies, so a **newly signed** line
is unchanged — the command layer always supplies both, and nothing but history
may be unknown.

### 6.2 Resolution is a separate append-only record

`prescription_line_resolutions` holds one row per determination: `amend` with a
medicine, a quantity, or both, or `cancel`. It is written only by
`resolve_prescription_line`, which requires the **doctor** role, requires a
reason, verifies any medicine against the active formulary, and writes an audit
event. Its own trigger refuses updates and deletes.

Nothing is ever written back into the line. `prescription_lines` keeps its
immutability trigger, and `prescriptions.items_json` — the signed record — is
not touched at all, so the prescription always shows both what was signed and
what a doctor later determined. A wrong resolution is corrected by recording
another one.

`jmc.prescription_lines_effective` (a `security_invoker` view) folds the latest
non-null determination of each part over the line and derives `dispensable`,
`needs_review` and `cancelled`. Medicine and quantity resolve independently, so
identifying the medicine on Tuesday does not erase Thursday's quantity.

### 6.3 Dispensing reads the lines, not the JSON

`dispense_rx` previously allocated from `prescriptions.items_json`. It now
reads `prescription_lines_effective`, refuses with the line number and what is
missing if any line needs review, and skips cancelled lines. Reading the JSON
would have meant handing over against precisely the values that were found
untrustworthy.

### 6.4 What the migration corrects, and why that is allowed

The migration nulls the quantities its predecessor invented, which requires
disabling the line immutability trigger inside the transaction. That is a
migration correcting its own predecessor's derivation, on rows that have never
reached a clinic, in a release not yet deployed. The signed record is
`items_json`; `prescription_lines` is derived from it. No runtime path can do
this — nothing in the application can disable that trigger.

One SQL detail worth keeping: the correction matches with `is not true`, not
`not (...)`. An item with no `quantity` key yields NULL, `not NULL` is NULL, and
a WHERE clause that is NULL matches nothing — so the row that most needed
correcting would have kept its invented 1. The rehearsal caught it. The casts
are wrapped in nested `CASE` for the same class of reason: `AND` is not
required to short-circuit, so a planner free to evaluate `('SOS')::bigint`
first would fail the whole migration.

---

## 7. Who actually enforces authorization

This is the question `FORCE ROW LEVEL SECURITY` made urgent, so it is written
down rather than implied.

### 7.1 The defect Slice 2 shipped

Slice 2 put `force row level security` on its thirteen new tables. Those tables
have no policies. `FORCE` removes the table owner's normal exemption from row
security, so an owner that does not additionally hold the `BYPASSRLS` attribute
reads nothing and writes nothing — with no error at either end.

Measured on this schema, as a `NOSUPERUSER NOBYPASSRLS` owner, with a draft row
present:

```text
select count(*) from jmc.consultation_drafts;   -- 1 as superuser, 0 as owner
insert into jmc.consultation_drafts ...          -- INSERT 0 0
```

`jmc.patients`, which has RLS enabled and not forced, returned its row to the
same role. The difference is FORCE, not the grants and not the schema.

The clinic has not met this only because the deployed functions connect as a
role holding `BYPASSRLS` — a property of the deployment nobody chose and
nothing checked. Slice 2 has never been deployed, so the first release would
have shown the doctor an empty Consult screen: no drafts, no templates, no
follow-ups, no print history, no approved vocabulary.

### 7.2 Why the repair is not a policy

The application reaches this database as a single identity. The database is
never told which staff member is acting. The only policy that restores access
for one shared identity is `using (true)`, which enforces nothing and makes the
schema look as though row security is doing work it is not.

Real per-row policies would need the end-user identity carried into the session
on every request — a change to how every transaction opens, and a decision to
take with the owner, not something to bolt on beneath a data-loss fix.

So the thirteen tables return to the posture of the other twenty-nine: row
security **enabled**, never forced.

### 7.3 The honest answer

| Layer | What it actually enforces |
|---|---|
| Authenticated Edge Function boundary | **All staff authorization.** Session, role, and every per-record rule — that a draft belongs to one doctor, that only a publishing doctor changes the clinic vocabulary, that only a doctor resolves a legacy line. It is the only layer that knows who is asking. |
| Grants | `jmc` is owned by the application role and granted to nobody. `anon`, `authenticated`, `service_role` and `PUBLIC` hold no privilege on any table and no `USAGE` on the schema. |
| RLS (enabled, unforced) | The second line under the grants: any role that is not the owner is refused rows even if a grant is ever added by accident. It is not what separates one staff member from another. |
| Database constraints and triggers | Append-only history, immutable signed records, state agreement, and idempotency keys — enforced regardless of which layer above got it wrong. |

`tests/characterization/runtime-role.test.mjs` holds this to it. It creates
`jmc_runtime` — `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` — makes
it own the `jmc` schema and everything in it, and runs a nurse arrival, vitals,
a consultation draft, a template, a signature, a print and a pharmacy queue
read through the real command layer as that role, in a child process, because
the backend fixes its connection at import. It then asserts no table is forced
and that the four Data API roles hold nothing.

Re-introducing `force` on one table was verified to fail it, with
`new row violates row-level security policy for table "consultation_drafts"`.

### 7.4 What is still unverified

The production role's attributes have not been read, because nothing in this
programme queries production. The test asserts the pessimistic case — a role
with neither `SUPERUSER` nor `BYPASSRLS` — so the application is now known to
work whether or not the deployed role holds them. Confirming what the deployed
role actually is remains a deployment-time check, not a staging one.
