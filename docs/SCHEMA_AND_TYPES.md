# Schema and type mappings

What the database actually holds, what the tablets actually receive, and every
conversion in between. This is a characterization document, produced for Slice 0
of `docs/AGENT_IMPLEMENTATION_BRIEF.md` §6. It describes the schema **as it is**, not
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
defects Slice 0 found (`docs/operations/STAGING.md` §3.2). It applies now, via the
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
| `theme` | text | no | `'system'` | `staff_theme_is_known`: `system \| paper \| night \| contrast` |

PK `id`. Unique `username`. No foreign keys. Indexes: `staff_pkey`,
`staff_username_key`.

`theme` was added by `20260917000000_staff_theme_and_draft_follow_up.sql`. It
is the staff member's chosen appearance, on the staff row so that it follows
the person rather than the tablet — four people share four tablets and hand
them to each other all day, and a preference kept in a browser gives the next
person the last person's eyes. `system` means no choice has been made and the
device's own light or dark setting decides, which is the plan's sign-in
fallback.

It is a preference and **never an authorization**. Nothing reads it to decide
what anybody may do, and `set_theme` takes no staff id from its payload — it
writes to `session.staffId` and nothing else, so there is no shape of request
that changes somebody else's.

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

Indexes at the time this was read: `appointments_pkey` only. Nothing indexed
`scheduled_at` or `status`, and the snapshot filters on both on every poll.
(`appointments_patient_id_idx` is file-only.) **Superseded:** `20260919000000`
and `20260920000000` added five more, and this table gained five columns in the
second of them — see [§14](#14-backend-programme-slice-2-the-future-and-the-way-out-of-an-attempt).

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
stubs in place (`docs/operations/STAGING.md` §3.2). Confirmed on 2026-09-10: **29 tables,
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
| `canPublishClinicalTemplates` | `staff.can_publish_clinical_templates` | integer -> boolean |
| `theme` | `staff.theme` | `text`, falling back to `'system'` for any value the client does not recognise — a tablet must never fail to open because a preference is unfamiliar |

`theme` is why `set_theme` ends by assigning `session.theme`. `command/index.ts`
resolves the session once, before running anything, and builds the snapshot it
returns from that same object; every other command changes rows the snapshot
re-reads, but this one changes the signed-in person's own staff row. Without
that assignment the tablet gets its answer back still carrying the appearance
it had a moment ago, and the screen and the account disagree until the next
poll fifteen seconds later.

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
| `messageStatus` | `purchase_orders.message_status` | `optional` + `as`; **no db check backs the union**. Set only on orders sent through the business API before 26 October 2026 (§18) |
| `supplierWhatsApp` / `supplierWhatsAppProblem` | `suppliers.whatsapp` through `dialable()` | the dialable digits, or why there are none (§18) |
| `placedAt` | nullable | `optional` |
| `lines[]` | `purchase_order_lines` joined to `medicines`, folded in JS into a `Map<order_id, lines[]>` | `id`/`medicineId`/`medicineName` `text`; `orderedQuantity`/`receivedQuantity` `num`; `baseUnit` and `orderedDescription` from the line's frozen `package_version_id` (§18) |

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

**Half closed by `20260920000000`.** A unique index now covers the OPEN rows
only — `where status in ('waiting','in_consult')` — which is exactly the part
of this that is a clinical safeguard rather than untidiness, and the migration
finds open duplicates first and refuses with a sentence naming them rather than
with a constraint violation. Historical duplicates among finished visits remain
and remain unconstrained, deliberately. See [§14.4](#144-two-unique-indexes-one-of-them-able-to-refuse).

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
| `prescription_prints` | one row per print or reprint REQUESTED, numbered — see below | `record_prescription_print` |
| `patient_clinical_profiles` | allergy status and clinical flags | `save_patient_clinical_profile` |
| `vital_review_rules` | the approved "Review this reading" prompts | migration/admin only; never inferred |
| `observation_events` | the bed timeline: admit, note, instruction, handoff, discharge | `update_bed`, `record_observation`, and the handoff commands |

Two columns were added to this set afterwards, by
`20260917000000_staff_theme_and_draft_follow_up.sql`:

- **`consultation_drafts.follow_up_note`** (`text not null default ''`). Every
  other field on the doctor's clinical sheet round-tripped through the draft
  and this one did not, although `sign_consultation` reads a `followUpNote`
  from its payload and writes it onto the follow-up it creates. So the field
  was real, it mattered, and it had nowhere to live between being typed and
  being signed: the doctor typed a reminder, pressed `Save draft`, the sheet
  re-hydrated from the server, and the reminder vanished underneath a green
  "Draft saved for you." `clinicalFields()` now carries it, both the insert and
  the update path in `save_consultation_draft` write it, and the snapshot
  projects it back as `ConsultationDraftView.followUpNote`. An empty note still
  falls back to the advice at signing, exactly as before.
- **`staff.theme`** — see §1.1.

**`prescription_prints` counts requests, not paper.** The row is written before
`window.print()` opens the operating system's dialogue, deliberately, so that a
copy taken during a crash is still on the record. That dialogue never reports
whether the operator pressed Print or Cancel, whether the tray was empty, or
whether the clinic printer was awake, so nothing downstream may claim a sheet
exists. The audit line reads `Print requested for RX-000123, copy 2` and the
command answers `Print requested. Copy 1 recorded.` The action key stays
`prescription.printed`, because it is a stable identifier that history and
reports already use and splitting one thing into two names would lose the join.
Counting actual paper needs something outside the browser.

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
`docs/reference/CLINICAL_TERMINOLOGY_AND_MEDICINE_DATA_RESEARCH.md` §2.4 requires so that old
visits stay intelligible.

**The wording is transcribed, not authored.** All eighty phrases are copied
verbatim from `archive/docs/current-programme/SLICE3_CLINIC_APPROVAL_PACK.md` §7.A–D, which §8.C of that
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

### 6.5 The scope of a resolution, and the hole that was in it

Slice 2.1 read `medicine_state` and `quantity_state` in
`resolve_prescription_line` and then never tested them. Role and payload shape
were checked; the line's own state was not. So a doctor reaching the command
directly could record a resolution against **any** line, including an ordinary
one signed through this application minutes earlier — and because
`prescription_lines_effective` coalesces the newest resolution over the line,
and Slice 4 hands over against that view, the counter would have supplied the
amendment while the signed row and `items_json` still said something else.
Nothing in the record would have looked edited, because nothing was: the
resolution simply outranks the line.

That is an amendment to signed clinical intent. OWNER_POLICY_REGISTER.md 21 and
§4 of the brief both say an amendment is a new or replacement order, never a
change to this one.

Slice 2.1.1 (`20260911210000_slice2_1_1_resolution_scope.sql`) closes it with
four rules:

| Rule | Effect |
|---|---|
| The line must have been signed unreadable | `medicine_state = 'unresolved_legacy'` **or** `quantity_state = 'unknown_legacy'`. An ordinary line refuses every resolution, `cancel` included. |
| A medicine may be named only where the medicine was unreadable | A quantity-only legacy problem cannot have its medicine replaced. |
| A quantity may be named only where the quantity was unreadable | A medicine-only legacy problem keeps the quantity that was signed. |
| Nothing follows a cancellation | The line is withdrawn; supplying it needs a new order. |

Correction survives all four, because what is tested is the **line's** state and
the line never changes. A doctor who identified the wrong medicine on Tuesday
records another resolution on Thursday; both stay on the record and the later
one governs.

It is enforced twice, deliberately. `commands.ts` refuses in clinic language
naming the line number and the medicine, which is what a doctor should meet.
`jmc.enforce_resolution_scope()`, a `BEFORE INSERT` trigger on
`prescription_line_resolutions`, is the enforcement: it also covers the psql
session, the migration and the repair script that never pass through a command,
and it takes `FOR UPDATE` on the line before testing for a cancellation, so two
doctors resolving the same line queue rather than race. The migration ends by
asserting that no resolution already recorded falls outside the scope it is
about to make unbreakable.

`action = 'cancel'` here is a **doctor** cancelling a legacy line they cannot
determine. A patient who chooses not to collect a supplyable line is *Patient
Declined*, a dispensing outcome recorded at the counter; OWNER_POLICY_REGISTER.md
20 keeps the two apart and this command can only ever record the first.

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

---

## 8. Slice 3: identity, packages and stock

### 8.1 The three things that used to be one row

`jmc.medicines` carried a brand name, a strength as free text, one `unit`
column and a reorder level; `jmc.batches` carried a quantity in that same
unnamed unit. That is enough for a pharmacy that only ever stocks tablets in
one pack size and never changes it, and it is wrong the first time a supplier
ships strips of ten where they used to ship fifteen — because `150` in
`available_quantity` then means "ten strips" or "fifteen strips" depending on a
fact the database does not hold.

Slice 3 separates them:

```text
substance        clinical drug              product        package version   batch     ledger
Paracetamol  ->  500 mg tablet (oral)  ->   Calpol 500  ->  strip of 15   ->  HIST-1 -> -349 tablets
                                            (GSK)           box of 10 strips
```

Clinical identity is above the line, inventory below it. A doctor prescribes a
clinical drug or a product; the pharmacy receives a package and moves base
units. Neither can silently become the other.

| Table | What it holds |
|---|---|
| `substances` | An ingredient, deduplicated on a normalized name. `source` says which authority the row came from; `clinic` means a pharmacist typed it. |
| `clinical_drugs` + `clinical_drug_ingredients` | Ingredient(s) + strength + dose form + route/release. Strength is `numeric` with a unit and an optional per-amount, so "125 mg per 5 mL" and "500 mg + 125 mg" are both representable. `identity_key` is a sorted, normalized digest built by the command layer: two people typing the same drug get one row, and 500 mg never merges with 650 mg. |
| `medicines` (extended) | Still the product. Gains `clinical_drug_id` (nullable — every existing product starts unlinked), `brand_name`, `manufacturer`, `base_unit`, and the provenance of its regulatory class. |
| `package_versions` + `package_levels` | A versioned SKU and the chain of levels under it. |
| `medicine_barcodes`, `unmapped_barcodes` | What a scan means, and the queue of scans that mean nothing yet. |
| `batches` (extended) | The frozen receipt-time conversion, the price bases, and three quantity pools. |
| `goods_receipts` + `goods_receipt_lines` | What actually arrived. A purchase order adds no stock; this does. |
| `opening_counts` + `opening_count_entries` | The blind count, its review, and the adjustments it posts. |

**No terminology was imported.** The brief and the research document both refuse
to redistribute a licensed vocabulary without confirming the applicable terms.
These tables are created empty and filled by the clinic typing what is on the
pack; the `source`/`source_code`/`source_version` columns exist so that mapping
to a licensed set later is an update rather than a migration.

### 8.2 The ladder, and why it is a chain rather than two columns

Each level names the level directly inside it and how many of them it holds.
`base_factor` and `depth` are stored rather than computed on read, because a
batch snapshot has to freeze them and every stock query multiplies by them —
and because a wrong `base_factor` does not look wrong, it looks like a pack
size.

`jmc.enforce_package_level_chain()` keeps them honest on every insert and
update: the contained level must belong to the same version, sit exactly one
step below, and satisfy `base_factor = child.base_factor × child_count`. With
`unique (package_version_id, depth)` and a unique index on `child_level_id`,
that makes a fork impossible and a cycle unconstructible — following child
links strictly decreases an integer bounded below by zero.

`child_count` is `integer`, which is what actually keeps measured dispensing
out. There is no way to express 100 mL inside one bottle, because the clinic
answered "no" to dividing an opened container (approval pack §8.A) and a
fraction cannot be stored at all.

A **verified** version is frozen: `jmc.protect_verified_package()` refuses every
edit to its levels and to the fields that define it. A changed pack size is a
new version. `medicine_active_package` is the newest verified one, and
receiving refuses anything else — which is what makes "verify it against the
physical pack" a control rather than a habit.

### 8.3 The ledger is the truth

`stock_movements` gains a `bucket` (`available` / `quarantine` / `blocked`),
the `package_entry` the person actually typed, a `reason`, an `approved_by`,
and `reverses_movement_id`. It is append-only, enforced:
`jmc.reject_stock_movement_change()` refuses UPDATE and DELETE, because a
ledger somebody can edit is a balance, and a balance cannot be audited.

`jmc.batch_ledger_reconciliation` exposes the drift between each batch's three
cached quantities and the sum of its movements per bucket. The Slice 3 suite
asserts it reads zero after receiving, releasing quarantine, holding stock and
writing stock off. Nothing in the application can change a quantity except
`moveStock`, which writes both halves in one statement pair inside one
transaction, and whose `where` clause carries the arithmetic
(`set x = x - ? where x >= ?`) so two transactions racing for the last tablet
cannot both win.

Batch eligibility is asked in exactly one place — `jmc.batch_availability`'s
`pickable`, which is `status = 'active' and available_quantity > 0 and not
expired`, with expiry compared in clinic time. FEFO reads it. **This closed a
live defect:** before Slice 3, `allocateStock` filtered on quantity and expiry
only, so a batch a pharmacist had just marked recalled was still the
earliest-expiring row with stock and FEFO picked it first. The recall changed a
column nothing read.

### 8.4 Money stopped being approximate

Every money column was `real` — about seven significant decimal digits, which a
rupee amount of 99,999.99 already consumes. They are `numeric(12,2)` now, and
the backend does its arithmetic in integer paise through
`supabase/functions/_shared/money.ts`. Amounts are parsed at the edge, formatted
at the edge, and never added as floating point in between.

Two money conventions to know:

- `batches.mrp` is the **printed** figure, and `mrp_basis_level` /
  `mrp_basis_factor` say what it is for — "₹30 per strip of 15", never a bare
  ₹30. A batch received before Slice 3 has a null factor, which reads as 1, so
  its `mrp` was already per base unit and the two generations agree without
  either being rewritten.
- `selling_price` and `purchase_price` stay **per base unit**, because every
  existing reader — the day book, the OTC line total, the write-off cost, the
  stock-take variance — multiplies them by a base quantity.

### 8.5 The blind count is blind in the data

Policy register 14: the pharmacist counts without seeing what the software
expects. That is enforced where the rows are read, not where they are drawn.

- `opening_count_entries.expected_base_quantity` is NULL until the count is
  submitted. While counting, the number does not exist to be leaked.
- While the count's status is not `submitted`, `readOpeningCount` nulls the
  expected figure, the variance and its value, **and returns only entries whose
  resolution is still `pending`**. A recount that can see the first round's
  answer — even the pharmacist's own earlier count — is not a recount, it is an
  invitation to agree with yourself.
- The figures stay in the table throughout, because the audit needs them.

A browser journey checks the same claim about the screen, by asserting that the
exact shelf quantity of a batch received minutes earlier appears nowhere in the
counting sheet's rendered text.

### 8.6 What the UI review found in this contract

The Slice 3 screens were built against the frozen types and reported seven
gaps. Five were real and are fixed here rather than worked around:

| Gap | Fix |
|---|---|
| `DrugSchedule` listed five values; `classify_medicine` accepted nine. A medicine classified `G` came back as a value the type said was impossible. | The union now matches the command. |
| Mapped barcodes never reached the snapshot, so a screen could not show what a code means or spot a clash before the server refused it. | `ClinicSnapshot.medicineBarcodes`, shelf roles only. |
| Retired package versions were filtered out of the snapshot, so retiring one looked identical to deleting it. | Retired versions are carried, with their status. |
| `link_medicine_identity` used `coalesce(nullif(?, ''), …)` for every field, so a wrongly linked clinical drug could be replaced but never cleared. | An explicit `clear: ['clinicalDrugId', …]`, refused alongside a value for the same field. |
| A recount's blindness rested entirely on the screen declining to render rows the server had sent. | §8.5 above. |

Two were noted and left: pack photographs for catalogue verification need an
object-storage command that does not exist until Slice 5, and `barcodeHint` is
now on `PackageLevelView` but the builder does not offer a field for it.

### 8.7 What Slice 4 inherits

- Every active product has a base unit, and every batch counts in one.
- A sale can be expressed at any configured **sellable** level and converted by
  one function, `baseQuantityOf`, which refuses a level that is not sellable and
  a quantity that breaks the minimum sale multiple.
- A price can be converted from its basis to any quantity by `proRata`, which
  multiplies before it divides and rounds once, half-up — the same rounding
  `numeric`'s own `round()` does, so a figure computed in TypeScript and one
  computed in SQL agree.
- Eligibility is one boolean on one view.
- `medicines.schedule = 'unset'` is Unknown / pharmacist review required, and
  `schedule_verified_at` says whether anybody checked. Slice 4's anonymous OTC
  path refuses both.

---

## 9. Slice 4: dispensing, OTC, fees, billing and payments

### 9.1 The three shapes that could not do the job

| Was | Could not express |
|---|---|
| `prescriptions.dispensed_at`, one timestamp | "Ten prescribed, six handed over, four on Friday". The counter's only options were all of it or none. |
| `bills(amount, status, payment_method)`, one row | A part payment, a split across cash and UPI, a running balance, a refund, a reversal. Each would have meant editing the amount, which destroys the thing it is a part of. |
| Nothing | Medicine was never charged for. `dispense_rx` moved stock and created no bill line; the only bill the application could produce was the consultation fee, and that fee came from a literal `300` in the doctor's browser form. |

What replaces them is three append-only chains, and every state a screen shows
is derived from them by a view rather than stored:

```text
dispense -> dispense_lines -> dispense_allocations   what was handed over, from which batch
invoice  -> invoice_lines                            what was charged, immutably
payment  -> payment_allocations                      money in, and money back
```

| View | Answers |
|---|---|
| `prescription_line_supply` | prescribed, supplied, remaining, and one of `waiting` / `part_supplied` / `supplied` / `patient_declined` / `doctor_cancelled` / `needs_review` |
| `invoice_balances` | total, paid, due, and `unpaid` / `part_paid` / `paid` / `void` / `over_refunded` / `void_with_balance` — the last is tested *first of all*, and `over_refunded` next, both ahead of `void`, so neither a voided over-refund nor a cancelled bill still holding money can hide behind the word `void` |
| `patient_balances` | what one patient owes across every bill, plus `over_refunded_invoices` / `over_refunded_amount` — now defined on `paid < 0`, the money rather than the state word, so relabelling a bill `void_with_balance` cannot silently empty them — `void_with_balance_invoices` / `void_with_balance_amount`, the amount **signed** (positive is money held against a cancelled bill, negative is money refunded past one), and `under_review_invoices`, the union of the two counted once. How much of the figure is the clinic's own error rather than the patient's debt |
| `financial_review_queue` | one row per bill under financial review, on a two-part test: `paid < 0`, **or** void and not at ₹0. It carries `review_state` (the invoice's own `payment_state`), a signed `paid`, `out_of_balance` — the distance from zero whichever side it is on, and what the queue sorts by — `void_reason`, `voided_at`, and every receipt, refund and reversal allocated to it |

### 9.2 Confirm and hand over

One transaction, in the order the brief sets out: authorize, enforce
idempotency, lock the prescription, recheck what is left, recheck and allocate
the batches, write the dispense and its allocations, write the negative stock
movements, create the medicine bill lines, commit.

Two things make it hold under two tablets:

- **The prescription row lock.** Slice 2 added it to stop two counters
  dispensing the whole prescription twice. Partial supply would have removed
  that protection — two taps five seconds apart are two legitimate partial
  dispenses — so the lock is now what makes the *recheck of the remainder*
  mean something, and the idempotency key is what tells a retry from a second
  hand-over.
- **The allocation UPDATE carries the arithmetic.**
  `set available_quantity = available_quantity - ? where id = ? and status =
  'active' and available_quantity >= ?` takes the row lock and does the
  subtraction in one statement, so a loser changes zero rows and retries
  against what the batch actually holds. Candidates are taken in `(expiry, id)`
  order everywhere, which is what stops two dispenses deadlocking.

Remainder validity is policy register 18: `prescriptions.valid_until`, seven
calendar days from signing by default, set by a trigger from `signed_at` rather
than by a column default — a column default cannot see another column and would
date every backfilled row from the day the migration ran. After it passes, the
remainder needs a new or amended order; only a doctor may extend it.

### 9.3 Substitution, and the narrow door

Policy register 21 allows exactly one substitution: a genuinely **generic**
order — the doctor chose an unbranded product — supplied with an in-stock brand
whose ingredient(s), strength, form, route and release characteristics match
exactly.

"Exactly" is not a judgement made in the command. Both products must point at
the **same `clinical_drugs` row**, which is what Slice 3's identity model was
built for. A brand-specific order, a different strength, or either product
being unlinked from a clinical drug are all refused, and the substitution that
is allowed records the clinical drug that was signed beside the brand actually
handed over, so it is visible rather than inferable.

### 9.4 Patient Declined and Doctor Cancelled

`prescription_line_outcomes`, one row per line, append-only, unique per line.
Patient Declined is recorded at the counter by whoever was told; Doctor
Cancelled only by a doctor. They are different facts about different people and
"not supplied" is neither: a patient who declines an antibiotic is something the
doctor should see next visit, and a doctor who withdraws one is an instruction
to the pharmacy.

Separate from `prescription_line_resolutions`, which Slice 2.1.1 restricted to
lines signed unreadable. A resolution may not touch an ordinary line; an outcome
may not be recorded twice.

### 9.5 Money

- **The fee comes from the clinic.** `clinic_settings.consultation_fee`
  defaults to ₹300 (policy register 15) on the column as well as on the
  existing row, so a new database starts at the owner's figure rather than at
  zero. The doctor may override or waive it for one consultation **with a
  reason**, and the encounter snapshots the amount charged, the default in
  force at the time, the waiver flag, the reason, the actor and the time — so
  "was this a discount?" is answerable a month later.
- **A waiver is an explicit ₹0 line**, not an absent one (policy register 33).
  An absent line cannot say who decided.
- **At most one fee per encounter** is a unique index, not a promise:
  `invoice_lines.source_key` is unique clinic-wide, and the key for a fee is
  `consultation:<encounter id>`. A retry cannot produce a second fee line even
  by creating a second invoice first.
- **One visit, one bill.** The fee, the medicine handed over and anything
  bought across the counter during the same encounter land on the same invoice
  — policy register 48's unified checkout — while each line keeps its own
  source, authorization and audit trail.
- **Medicine is charged for what moved**, at the price of the batch it came
  out of, snapshotted onto the allocation. A later supply of the remainder adds
  only that later charge and never re-charges the visit.
- **An invoice line never changes.** Only an `adjustment` line may be negative,
  and that exception is the mechanism by which a bill comes down: a reversed
  hand-over adds a credit line, so the original charge stays exactly as it was
  printed.
- **A refund and a reversal are different.** A refund is money going back and
  reduces what has been paid; a reversal says the payment never arrived and
  removes it from the arithmetic. The day book needs to tell them apart, and the
  till's cash figure is now one query over `payments` rather than two over two
  tables with different shapes.
- **Which is how `paid` gets below zero.** Take ₹100, refund ₹40, then reverse
  the ₹100 because the card never actually settled. The refund stands — money
  really did go out — and the payment is gone from the arithmetic, so the bill
  has *minus forty rupees* paid against it and a `due` larger than its own
  total. That is what the events say, and neither view flattens it into
  something more comfortable: `invoice_balances` calls it `over_refunded` and
  tests for it before `void`, `patient_balances` counts it separately from the
  debt it is inflating, and `financial_review_queue` is the list of them with
  their receipts attached. Going forward it can only be created deliberately:
  `void_invoice` refuses a bill whose balance is negative, `refund_payment`
  locks the invoice before reading `paid` so two simultaneous refunds cannot
  both think the money is there, and `reverse_payment` computes the result for
  every invoice the receipt touches and refuses atomically if any would go
  below zero — naming the refunds to reverse first. Reversing a *refund* is the
  exception and is always permitted: money going back out only ever moves a bill
  towards zero, and refusing that step because the bill is still negative after
  it would leave the only way out of the state blocked by the rule meant to stop
  anybody entering it (policy register 58). Derived balances are read with
  `parseBalance`, which is signed, and never with `parseMoney`, which is for
  what a person typed at a counter. Policy register 49–55, 58; §12.5.
- **And this is how a cancelled bill gets off zero.** Take ₹100, refund ₹100,
  void at zero — every step correct — then reverse the refund. That moves the
  bill *up*, to plus a hundred, and the rule above was watching only for a
  result below zero, so it waved it through: a bill cancelled, holding a hundred
  rupees of the patient's money, and nothing anywhere that would say so.
  `void_with_balance` is the word for it — status `void` and net paid not ₹0, in
  **either** direction — and it is tested before `over_refunded`, because of the
  two true things about a voided bill at −₹40 the one that tells somebody what
  to do is that it was cancelled with money still against it. The relabelling
  loses none of the arithmetic: `paid` is still negative, `patient_balances`
  still counts that bill as an over-refund because those two columns are defined
  on `paid < 0` rather than on the state word, and it is still on the review
  queue. **Going forward the state cannot be reached at all**: `void_invoice`
  allows a void only at exactly zero, `reverse_payment` refuses every receipt
  allocated to a voided bill in both directions, and `refund_payment` refuses to
  take a refund against one. Every row it ever matches came out of the history
  the clinic is carrying across, which is the only reason it needs a name. What
  it is not is a repair: nothing nets the two directions off, and clearing one
  is the accountant's unbuilt workflow. Policy register 58–63; §12.5.
- **Anonymous sales are paid in full** (policy register 46), and an unreviewed
  regulatory classification cannot leave the counter anonymously at all —
  `schedule = 'unset'` or `schedule_verified_at is null` is refused. Pay-later
  and part payment require a registered patient, because there has to be
  somebody to owe it.

### 9.6 What happened to `bills`

Every row became an invoice with one line, and every paid one additionally a
payment allocated in full to it. Ids are derived from the bill id, so the
backfill is idempotent and a bill keeps a visible link to what it became.

The table is then **emptied and left standing**, not dropped. One release of
tombstone: anything still naming `jmc.bills` fails loudly on zero rows rather
than silently on a missing relation, and Slice 3's money conversion — which
includes `alter table jmc.bills` — does not end up naming a relation that has
gone. A later migration removes it once the clinic has run a reconciliation
period on invoices.

One limit worth stating rather than leaving as an omission: **the migration set
is applied once, as `supabase db push` applies it.** Slice 3 converts money
columns and then builds views over two of them, so re-applying it asks Postgres
to alter a column a view already depends on. `npm run staging:rehearse` now
re-applies only the **backfills**, which are the statements that can run twice
by accident and do damage; the type conversions are applied once, like every
migration in a real deployment.

### 9.7 What the UI review found, and what changed because of it

| Found | Fixed |
|---|---|
| `pharmacyCounter` was `pharmacy` only, while every counter command authorizes `admin`. An admin opening Counter saw an empty queue — and the rail offered no Counter station at all. | Both widened. The owner covers the counter when the pharmacist is away. |
| The counter received bare patient ids, so a first-time walk-in could not be attached to a pay-later sale — the one case pay-later exists for. It was also inconsistent rather than protective: prescriptions and bills already carried `patientName`. | Name and phone for the counter; age, sex, address and consent stay behind the care register. |
| `invoices` was not role-gated, so a doctor-only session received every open bill and its payment history. | Gated to the roles that handle money. |
| A bill raised last week and settled today left the snapshot, so today's takings lost a payment the till still counted. The two then disagreed by exactly that amount. | The day's window includes any bill paid against today. |
| `otcSales.lineCount` read `json_array_length(lines_json)`, which the new sale writes as `'[]'`; `payment_method` was a column that could say only one thing after split payment existed. | Both derived from `otc_lines` and the payments allocated to the sale's bill. `split` is a real answer, and so is nothing at all. |
| The flat-quantity path on `otc_sale` skipped every package rule, so a sealed bottle configured not-sellable-loose could be sold loose by sending a number instead of a level. | The rule belongs to the package and is asked of the package wherever one exists. |

---

## 10. Slice 5: clinical images

The most dangerous feature in the application, and the one with the least
forgiving failure mode: a stock figure that is wrong can be counted again, and
a photograph shown to the wrong person cannot be un-shown.

So the schema answers four questions with rows rather than conventions.

| Question | Answered by |
|---|---|
| Was consent given? | `image_consents` — the consenting person, their relationship, the method, the purpose, the staff member and the time, recorded **before** capture. Withdrawal stops further capture and every export, and leaves what was already taken on the clinical record. |
| Who may see it? | `mayAccessImage()`, in one place because it is asked from three. Doctor: always. Nurse: only while involved in that patient's care, derived by `nurse_care_involvement` from vitals taken, observations entered or a visit booked — work the nurse actually did, not a box somebody ticked. Pharmacist: none, refused at the endpoint before any query runs. Admin: metadata and audit, and image content only through an `image_access_grants` row from a doctor, with a reason and an expiry that arrives on its own. |
| What happened to it? | `image_access_events` — every view, thumbnail, export, print **and refusal**, append-only. The interesting number in an access log is how often somebody was turned away. |
| Was it right? | The original is immutable: `protect_clinical_image()` refuses every change to the description as well as to the bytes, because re-pointing `patient_id` moves a photograph to another person with nothing in the record to say so. A wrong one is marked Captured in error with an actor, a time and a reason, and cannot be brought back. Crops and annotations are `image_derivatives`, stored as parameters so they can be regenerated from the original and never mistaken for it. |

### 10.1 Where the bytes are, and where they are not

`storage_key` names an object in private storage. There is no public bucket, no
signed URL and no durable link. In the clinic that is Supabase Storage reached
with the service role key **from inside the Edge Function**, which is the only
place that key exists; in staging it is a directory named by
`CLINIC_IMAGE_ROOT`, which has no default — unset means "storage is not
configured", which the screen says out loud, rather than a photograph quietly
written somewhere plausible and gone at the next restart.

The bytes travel only through `supabase/functions/images/index.ts`, which
authorizes every request. A browser cannot put an `Authorization` header on an
`<img src>`, so the alternative would be a session token in a URL — and that
lives in the history, in the referrer of anything the page links to, and in
every screenshot of the address bar. Instead:

- `GET /images?action=ticket&imageId=…` returns an HMAC over **one image id,
  one actor, one action and an expiry sixty seconds out**.
- `GET /images?imageId=…&ticket=…` returns the bytes, checked twice: the
  session says who this is, and the ticket says they were allowed this image
  for this purpose within the last minute.
- The response carries `Cache-Control: no-store, private`, because a clinical
  photograph in a shared tablet's disk cache outlives the session that fetched
  it.
- The panel turns the response into a `blob:` URL that lives in the tab and is
  revoked when the panel unmounts. A browser journey asserts that no image on
  the page is drawn from anything naming the image endpoint.

A ticket cannot be replayed against a different image, cannot be used by
anybody else, and is worth nothing once the session behind it is revoked —
which is the lost-tablet case in policy register 30, and is tested as one.

### 10.2 The guards against the wrong patient

1. Capture is only from an open patient.
2. If an encounter is named, it must belong to that patient — two tablets with
   two open Consults is exactly how a photograph of this patient is filed
   against that patient's visit, and the check costs one query.
3. The consent must belong to that patient. Another patient's consent is not
   this patient's consent.
4. The image row is written **after** the bytes are in storage, never before:
   a row written first says a photograph exists when it does not, and the
   screen would show a broken image beside a patient's name for ever.
5. On the way out, the stored bytes are hashed and compared to the checksum on
   the row. An object that no longer hashes to what was stored is not shown at
   all.

### 10.3 Retention is a queue, not a timer

`image_retention_queue` lists images three years after the patient's **last
relevant clinical contact** — the latest of their encounters, vitals and images,
not the photograph's own age, because a photograph from year one of a course of
treatment that is still running has not aged out.

Nothing is purged automatically. An admin records `keep`, `legal_hold` or
`delete`; a deletion requires explicit confirmation, removes the bytes, and
leaves the row and the decision behind with `purged_at` set. The purge happens
outside the transaction on purpose: storage has no rollback, so the decision is
committed first and a failed purge leaves a queue entry rather than a silent
loss.

### 10.4 What staging can and cannot say about this

It exercises consent, the access rules, the audit, the checksum, the ticket and
the wrong-patient guards against real bytes. It says nothing about Supabase's
own bucket policy — that the bucket is private, that anonymous reads are
refused, that the service key is not exposed — which is a deployment check and
is recorded in §7.2 of `docs/operations/STAGING.md` as one.

---

## 11. Slice 6: admin, reports and the things that were still open

Slice 6 adds no clinical table. Its whole job is to make what the earlier
slices recorded *readable* — by an admin who has to reconcile a day, by a
doctor who has to clear a queue of unreadable history, and by whoever is
holding the runbook on the morning of the cutover.

### 11.1 Reports are a separate function, on purpose

`supabase/functions/reports/index.ts` is its own Edge Function rather than more
cases in `command`. Three reasons, in order of how much they matter:

1. **They are reads, and the snapshot is not the place for them.** The
   whole-clinic snapshot is polled. A stock valuation that walks every batch,
   or a movement history over four hundred days, does not belong in something
   that runs every few seconds — `docs/AGENT_IMPLEMENTATION_BRIEF.md` §3 says so
   in as many words, and it is why `ledger`, `receipts` and the image list are
   also on demand.
2. **The role gate is per report, not per function.** Fifteen reports with
   four different audiences:

   | Report | admin | doctor | nurse | pharmacy |
   |---|:-:|:-:|:-:|:-:|
   | `stock_on_hand` | ● | ● | | ● |
   | `stock_movements` | ● | | | ● |
   | `expiry_and_holds` | ● | ● | | ● |
   | `package_audit` | ● | | | ● |
   | `purchasing` | ● | | | ● |
   | `outstanding_prescriptions` | ● | ● | | ● |
   | `dispensing` | ● | | | ● |
   | `consultation_fees` | ● | | | |
   | `sales` | ● | | | ● |
   | `payments` | ● | | | ● |
   | `patient_dues` | ● | | | ● |
   | `reversals` | ● | | | |
   | `financial_review` | ● | | | |
   | `follow_ups` | ● | ● | ● | |
   | `image_access` | ● | | | |

   `payments` and `patient_dues` name exactly the roles `take_payment` names,
   and that is the rule the whole column follows: a report that shows less than
   the command allows is theatre, and one that shows more is a leak. Both
   originally named the nurse, because the counter's gate did. The owner
   settled that on 12 September 2026 — see §11.5 — and both ends moved
   together.

   The matrix is fifteen reports and it has not moved since Slice 6; what
   changed under `financial_review` is its content, not who may read it.

   `financial_review` is admin-only for a different reason from the rest of the
   column. It is not that a pharmacist should not see a bill under review; it
   is that there is nothing a counter can do with one. Voiding an over-refund is
   refused, taking payment against one would charge the patient for the clinic's
   own error, and on a cancelled bill that is off zero every repair a counter
   could reach for — reverse the receipt, refund the balance away — is refused
   too. It is accountant's work, so it is on the accountant's desk (§12.5).

   `GET /reports?report=index` returns only the reports the caller may run, so
   the UI builds its menu from the server's answer rather than from a list in
   the page that can drift away from the gate. A report the server lists and
   the page has never heard of is named on screen rather than dropped, because
   the backend is deployed separately from the bundle and the two can be a
   release apart.
3. **`image_access` is admin-only and reads no image.** It is the audit trail
   of §10 — who opened what, when, and whether it was exported — which is
   exactly the "required audit/technical metadata" that policy item 26 grants
   an admin, and nothing more.

### 11.2 The range is computed once, in Postgres

Every dated report takes one `since` value: clinic-local midnight, `days` ago,
as an ISO string. It is asked of the database

```sql
select to_char(
  ((date_trunc('day', now() at time zone 'Asia/Kolkata') - ((? || ' days')::interval))
     at time zone 'Asia/Kolkata') at time zone 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS"Z"')
```

rather than computed in JavaScript, for the reason `clinicInstant` gives at
length: the runtime is UTC, the clinic is not, and date arithmetic done in the
wrong one of those is five and a half hours wrong for part of every day —
which for a day book means the evening's takings landing on tomorrow.

`days` is bounded to 0..400 and defaults to 7. Zero means today.

The same `since` fills every `?` in the report's SQL, counted from the text
rather than repeated by hand, because the driver numbers placeholders
positionally and a hand-kept count drifts the first time somebody adds a
clause.

### 11.3 The doctor review queue

`prescription_lines` that nobody can read — `medicine_state <> 'resolved'` or
`quantity_state <> 'resolved'` — are §6's problem, and Slice 2.1 gave them a
resolution record. What was missing was the list. `ReviewQueuePanel` is that
list: oldest first, one line at a time, doctor-only, and it writes through the
same `resolve_prescription_line` command the consultation uses — including the
scope check §6.5 added, so a doctor cannot resolve a line of a prescription
they are not responsible for.

It is in the doctor's rail rather than admin's because a non-doctor admin
resolving a clinical line is precisely the thing the brief forbids. The count
is the number in `docs/operations/ROLLOUT.md`'s second preflight query, and it is the one that
decides how long the cutover takes.

Building it surfaced a gap worth recording, because it is the shape of gap
this architecture invites. The report gave the doctor the authoritative list —
prescription number, patient, line number, the medicine as signed — and no
identifier, while `resolve_prescription_line` takes a line id; and the
snapshot's prescriptions are gated to the counter, so the one role permitted to
settle a line was the one role holding no id for it. The first implementation
worked around it by reading the clinical record and matching on patient name
and medicine text, which is three inferences deep and wrong the day two
patients share a name. The fix was two columns: `needsDoctor` now selects
`l.id as prescription_line_id` and `p.id as patient_id` (and `quantity_unit`,
so the field can name its own units). The generic table renderer drops any
column named like an identifier, so none of the three reaches a reader — a
browser journey asserts that no report prints a uuid.

### 11.4 What the security sweep changed

Nothing structural, which is the point — the invariants were set in Slice 3 and
held. What it did produce:

- Every view in `jmc` is `security_invoker`; the sweep asserts it rather than
  trusting the migrations, and `slice6-gate.test.mjs` fails if a later one
  forgets.
- No object in `jmc` grants to `anon`, `authenticated`, `service_role` or
  `PUBLIC`; asserted the same way.
- No `SECURITY DEFINER` function exists anywhere in the schema.
- Every function pins `search_path`.
- Every foreign key has an index on its referencing column. This one was worth
  automating: it found none missing, but it is the check that stops a later
  slice adding a column that makes a delete scan a ledger.

### 11.5 What Slice 6 left open, and how it closed

- **The nurse at the counter — answered.** Slice 6 shipped with one question
  outstanding: policy item 17 said the fee was collected "at the
  pharmacy/payment counter" and named no role, while the code let a nurse do
  it, inherited from the retired application rather than decided. The owner
  settled it on 12 September 2026, and §12 is what changed.
- **Everything in `docs/operations/ROLLOUT.md` §7**, which is the honest list: no real
  supplier document, no real package, no classified formulary, no printer, no
  tablet on clinic Wi-Fi, no Storage bucket, no CI run, and a production
  database role nobody here has read.

---

## 12. The counter authorization correction

Policy register item 17, extended by the owner on 12 September 2026 and now
holding the full matrix rather than one sentence about the doctor. No schema
changed; this is a correction to who may call what.

### 12.1 What moved

| Command | Was | Is |
|---|---|---|
| `take_payment` | admin, nurse, pharmacy | **admin, pharmacy** |
| `dispense_rx` | admin, pharmacy | **pharmacy** |
| `otc_sale` | admin, pharmacy | **pharmacy** |
| `record_unknown_barcode` | admin, pharmacy, nurse | **admin, pharmacy** |
| `payments` report | admin, nurse, pharmacy | **admin, pharmacy** |
| `patient_dues` report | admin, nurse, pharmacy | **admin, pharmacy** |
| snapshot `cashDrawer` | admin, nurse, pharmacy | **admin, pharmacy** |

Unchanged, and worth saying so: `otc_return` stays admin and pharmacy, and
`void_invoice`, `refund_payment`, `reverse_payment` and `reverse_dispense` stay
admin alone. Every one of those is a correction to something a pharmacist did,
which is exactly the division the owner drew.

### 12.2 The two halves of the rule

**Medicine handover always requires a pharmacist.** An administrator — even
the owner, when signed in without the pharmacy role — cannot dispense a
prescription and cannot start a counter sale. What an administrator does is
review and correct: void, refund, reverse, authorise a return. The asymmetry is
deliberate and it is the interesting part of this decision. Making a hand-over
needs a pharmacist's judgement about a physical pack; undoing one needs
authority over the record, which is the administrator's.

**A nurse does not touch money.** The capability was never decided, only
inherited. It is gone from the command, from the snapshot, from both money
reports, and from the rail — the nurse's Billing and Day book stations are
withdrawn, because with no invoices, no balances and no till in the snapshot
they would have drawn empty screens over controls that could only fail.

A person holding two roles holds the union, so the pharmacist who administers
the clinic, or the nurse who covers the counter on a day off, loses nothing.
The fixtures carry both of those people for exactly this reason.

### 12.3 Pending is an outcome, not a failure

If no authorised counter staff member is available, the balance stays pending.
Nothing routes around that: there is no break-glass, no "only person in the
building" path, and no role that acquires the capability by circumstance. The
charge is still owed and still collectable tomorrow, which is what
`invoice_balances` already models. A test asserts precisely this — a clinic
staffed only by a doctor and a nurse ends the day with an open balance that
neither of them can close.

### 12.4 The screen and the server, checked against each other

`components/navigation.ts` and `components/checkout-workspace.tsx` mirror the
command gates: the counter's station list is filtered by role, so a pharmacist
is offered all three stations and an administrator is offered Take payment
alone. That is mirroring, not enforcement — the refusal is at the command, and
`requireRole` runs before the command reads a parameter.

Both ends are tested, and separately, because a capability matrix checked only
against itself proves nothing:

- `tests/characterization/counter-authorization.test.mjs` calls each command
  with a session of each role and asserts what happens, including that a
  refused hand-over moved no stock and left no empty header behind.
- `tests/browser/slice4-counter.test.mjs` opens the counter in a real browser
  as a pharmacist and as an admin-only manager, and asserts the stations
  offered are exactly the ones that role's session may use.

### 12.5 One defect found, left alone, fixed, and then the fix fixed

**This section used to say the defect below was deliberately not fixed. It has
been fixed — and the fix, as first written, had two holes in it, which are also
written down here.** What follows is what it was, what was done about it, what
that got wrong, what closed it, and the part that was never the code's to decide
— which is the part still open. None of it reached the clinic; nothing in this
branch has.

**What it was.** Writing the administrator-corrections test surfaced an edge in
`void_invoice`. It refuses a bill that has been paid against — correctly, since
voiding it would lose the money — and it made that check by parsing `paid` as
an amount in rupees. A bill whose payment was reversed after a partial refund
has a *negative* `paid`, which the ledger models on purpose and which
`parseMoney` rejects. Voiding such a bill therefore failed with "amount paid
cannot be negative": true, and not the sentence anybody needs, printed at an
administrator who had not typed an amount at all. Worse than the wording, the
same bill read as `unpaid` everywhere else — the same word as a bill printed
five minutes ago — so nothing in the application would ever have shown it to
anybody.

**What the fix is.** Migration `20260915000000_financial_edge_states.sql`,
which is forward-only and replaces three views without touching a single stored
row:

- `invoice_balances.payment_state` gains `over_refunded`, tested *before*
  `void` so a voided over-refund cannot file itself under "closed".
- `patient_balances` gains `over_refunded_invoices` and
  `over_refunded_amount`, counted over exactly the invoices its money columns
  already cover, so the two cannot disagree about which bills were included.
- `financial_review_queue` is one row per over-refunded bill with every
  receipt, refund and reversal allocated to it. It is derived, so nothing has
  to be enqueued and nothing can be dequeued by forgetting.

And in the commands:

- `void_invoice` allows a void only at a net balance of exactly ₹0. Above zero,
  refund first. Below zero it refuses with *Over-refunded — financial
  correction required*, the same words on every screen, and changes nothing.
- `reverse_payment` computes the result for **every** invoice the receipt is
  allocated to and refuses atomically if any would go below zero, naming the
  refunds to reverse first. A receipt is one event; there is no partial
  reversal.
- `parseBalance` in `money.ts` is the signed reader for derived balances.
  `parseMoney` keeps its `min: 0` default and stays what it always was — the
  reader for what a person typed at a counter.
- `financial_review` in `reports/index.ts` is the admin-only report over the
  queue, and `patient_dues` now carries the two new columns, surfaces
  over-refunded patients instead of sorting them down a descending
  `outstanding`, and no longer drops a patient whose bills happen to net to
  zero across one.

**What that fix got wrong.** Two holes, and they are the same hole read in
opposite directions. `reverse_payment` worked out the result correctly for both
kinds of receipt — reversing a refund *adds* money back, reversing a payment
takes it away — and then applied one refusal to both: the result must not be
below zero. The arithmetic was right; the rule written over it was the wrong
shape.

- **The exit was refused by the rule guarding the entrance.** A refund is money
  going out, so reversing one can only move a bill towards zero — it can never
  create an over-refund. But a bill at −₹80 carrying two ₹40 refunds has to be
  walked back one refund at a time, and the first step lands on −₹40, which is
  still below zero, so it was refused. The only route out of the state was
  blocked by the rule that existed to stop anybody entering it. The refusal even
  named the refunds to reverse first — which on a bill whose only live receipts
  were refunds meant the *other* refund, and that one was refused in its turn
  for exactly the same reason.
- **The other side of the same test let a cancelled bill off zero.** Take ₹100,
  refund ₹100, void at zero — every step allowed and correct. Then reverse the
  refund. That moves the bill *up*, to plus a hundred, so a test looking only
  for a result below zero waved it through, and the result was a cancelled bill
  holding a hundred rupees of the patient's money: not over-refunded, so not on
  the queue; `void`, so filed under closed; and no screen anywhere that would
  have mentioned it. Voiding is permitted only at exactly zero, so nothing else
  could have put a bill there.

**What closed them.** Migration `20260916000000_void_balance_and_review_queue.sql`
— forward-only, views only, no stored row touched — and two commands:

- `reverse_payment` permits the reversal of a **refund** whatever the balance
  is afterwards (policy register 58), and still refuses the reversal of a
  **payment** that would take any linked invoice below zero, atomically and for
  every invoice the receipt touches (60).
- A voided bill is closed in both directions: no receipt allocated to one may be
  reversed, and `refund_payment` refuses a refund taken against one (59). A
  cancelled bill stays at net ₹0. The way out of one that is not is item 56's
  accountant-approved correction, which does not exist yet — so the refusal is
  a refusal, not a redirection to somewhere better.
- `invoice_balances.payment_state` gains `void_with_balance` — void and not at
  ₹0, in either direction — tested *before* `over_refunded`, so a voided bill at
  −₹40 reads as the thing that tells somebody what to do.
- `patient_balances` gains `void_with_balance_invoices`, a **signed**
  `void_with_balance_amount` and `under_review_invoices`, the union counted
  once; `over_refunded_invoices` / `over_refunded_amount` were re-defined on
  `paid < 0` rather than on the state word, so the relabelling above could not
  silently empty them. They count exactly the bills they counted before.
- `financial_review_queue` was dropped and rebuilt, losing `over_refunded_by`.
  It was a positive magnitude that assumed the balance was negative, and the
  queue now carries rows where it is positive, for which "over-refunded by minus
  a hundred" is not a sentence anybody should read. In its place `review_state`,
  a signed `paid`, and `out_of_balance` — the distance from zero whichever side
  — which is what the queue and the report sort on.
- `financial_review` in `reports/index.ts` reads the new shape (it was broken by
  the drop, which is the honest way round: a column that no longer exists fails
  loudly rather than answering wrongly), and both money lists moved from
  `over_refunded_invoices` to `under_review_invoices`. That last one matters
  more than it looks: `patient_balances`' money columns exclude voided bills, so
  a patient whose only exception is a cancelled bill with money against it has
  `outstanding = 0` and would have been dropped by a test on the money alone.

**What is still not the code's decision.** An over-refund is two real events —
a refund that went out and a receipt that turned out never to have settled — and
the clinic is genuinely down the difference. Nothing here invents a balancing
entry for it, and no command in this release closes a row on the review queue.
How the money is recovered or written off, who approves that, and what the GST
credit/debit-note treatment is where GST applies are the clinic accountant's,
and they are unanswered: policy register 56 and 57, and `docs/operations/ROLLOUT.md` §7.

A cancelled bill that is not at zero is in the same position and it is worth
being blunt about what that means at the counter. Every repair the application
could make to one is now refused — the receipt cannot be reversed, nothing can
be refunded against it — and that is the right refusal, because each of those
would be a correction nobody has approved. It is also a dead end until item 56
exists: the bill sits on the review queue saying exactly what is wrong with it
and there is no command in this release that finishes the sentence. The code's
job was to stop creating these silently, to stop hiding the ones that already
exist, and — after the first attempt — to stop refusing the one step that walks
an over-refund back. That much is done. The rest is the accountant's.

---

## 13. Backend programme Slice 1: one key, and seven indexes

Added 14 September 2026 by Slice 1 of
[`reference/CLAUDE_BACKEND_IMPLEMENTATION_PROGRAMME.md`](reference/CLAUDE_BACKEND_IMPLEMENTATION_PROGRAMME.md).
Two migrations, two columns, one unique index, one check, seven plain indexes,
and
no new table.

### 13.1 The two columns on `encounters`

| Column | Type | Null | What it holds |
|---|---|:-:|---|
| `idempotency_key` | `text` | yes | The name one attempt at one consultation was signed under. Unique clinic-wide. |
| `request_fingerprint` | `text` | yes | SHA-256 of the material consultation request, as 64 hex characters. |

Both nullable, because every encounter signed before `20260918000000` has
neither and inventing one would be inventing evidence about a visit that already
happened. Every row written since carries both: `completeConsultation` mints a
key of its own when the tablet does not send one, so the pair is absent only on
history.

```sql
create unique index encounters_idempotency_key on jmc.encounters (idempotency_key);
alter table jmc.encounters add constraint encounters_key_carries_fingerprint
  check (idempotency_key is null or request_fingerprint is not null);
```

Postgres treats NULLs as distinct in a unique index, which is what lets the
historical rows coexist with the constraint. The check is validated on creation
rather than `NOT VALID`, because every existing row has both columns null and
therefore satisfies it.

**Why two columns and not one.** A key alone answers "have I seen this?" and
then hands back whatever it finds. Welded to the wrong request it stops being a
retry guard and becomes a way to lose work — which is precisely what the counter
met when one payment key was minted per session rather than per bill, and the
clinic answered a payment on the second invoice with the first invoice's
receipt. The fingerprint is what lets the server refuse a mismatch out loud
instead of replying with the wrong encounter.

### 13.2 What identifies one attempt, in two parts

A key that has already been spent is checked twice, and the two checks answer
different questions and produce different refusals.

**The binding — who and which visit.** The patient, the doctor and the
appointment, read off the encounter the key already names and compared against
the request. Nothing is hashed here — the encounter stores all three columns,
so the comparison is against the row itself. Most differences are
`ATTEMPT_NAMES_ANOTHER_CONSULTATION`: the reference belongs to somebody else's
consultation, this request is provably not a retry of it, and the tablet should
mint a fresh one. One is not — a request naming a visit where the encounter has
none is `CONSULTATION_SIGNED_WITHOUT_THIS_VISIT`, and the tablet must **not**
rotate on it, because that writes the same consultation twice.

**The binding is judged first, and that has a consequence worth knowing.** A
request refused on the binding never has its fingerprint compared, so restoring
an edited sheet cannot clear `CONSULTATION_SIGNED_WITHOUT_THIS_VISIT` while the
live visit is still on screen — a byte-perfect sheet is refused with the same
code. What clears it is closing the queue row, which is also what the
`unlinked_consultation` obligation asks for.

**The fingerprint — what was written.** Everything else that reaches a durable
record: all twelve `clinicalFields()` values, every prescription line's
`medicineId`, dose, unit, frequency, timing, route, duration, directions,
instructions and quantity, the fee decision (waive / override amount / reason),
and — only when there are lines to carry them — `validUntil`, `supplyInParts`
and `validityReason`. A difference is `CONSULTATION_ALREADY_SIGNED`: this *is*
the consultation the key named, it committed, and signing is immutable.

The split matters because the responses differ. A stale reference invites a new
one; an edited sheet must not, because a fresh key there writes a second
encounter and a second fee for one visit.

**The appointment is part of the binding, and the request carries it twice.**
`appointmentId` is the visit on screen now; `openedVisitId` is the visit the
attempt was opened against and never changes. Both are optional, so a caller
that sends neither behaves exactly as it did before this slice.

They are separate because each covers what the other cannot, and this took four
versions to get right. Dropping the appointment from the identity altogether
made one patient's Monday and Thursday the same consultation. Sending only the
opened value left a walk-in's consultation succeeding while the visit the
doctor had just created sat in the queue as `waiting`, attached to nothing.
Sending only the live value let an attempt whose visit had been **cancelled**
under it retry as a direct consultation — the cancellation bypassed, the
encounter unlinked, ₹300 charged. Sending both, and keeping them apart, is what
is implemented.

A first signing resolves the visit inside the transaction: the live one wins
when there is one, and otherwise the opened one is read `for update` and signed
against if it is still `waiting` or `in_consult`. If it has been cancelled,
closed or removed, the signing is refused with `ATTEMPT_VISIT_NO_LONGER_ACTIVE`
rather than quietly becoming a direct consultation.

**That row lock is also a second serialization point**, and it needed its own
recovery. Two tablets signing one **queued** patient under one key do not meet
the unique index: the loser waits on the appointment lock, wakes to a visit the
winner has just set to `done`, and has written nothing for the index to refuse.
It used to be told the visit was "already finished or does not belong to this
patient" — false in both halves, with its own consultation sitting in the
clinic. Every refusal on that path now re-reads the key first, and a caller
that finds its own consultation replays through the same path the index race
uses.

Deliberately excluded, and each for a reason:

| Excluded | Why |
|---|---|
| The patient, the doctor and the appointment | Not excluded — checked as the binding above, against the encounter's own columns, so that a stale reference and an edited sheet get different answers. |
| `medicineName`, `genericName`, `strength`, `dosageForm`, `medicineCode` | Copied onto the line from the formulary at signing. They are not the doctor's request, and an admin correcting a shelf label between a lost reply and its retry must not turn that retry into a refusal. |
| The clinic's default consultation fee | Read inside the transaction. What belongs to the request is the doctor's *decision* about the fee, not the number the clinic happened to hold. |
| Validity fields when there are no prescription lines | The command ignores them then, and a field the command ignores cannot be a material difference. |

The hash is taken over canonical JSON — every object key sorted, arrays left in
order — so it is a property of the facts rather than of the order somebody wrote
them in. `JSON.stringify` preserves insertion order, and a fingerprint built on
that would begin refusing honest retries the first time a field was reordered in
the object literal.

### 13.3 The seven indexes

No column, no table, no stored status. `20260919000000` adds only these:

| Index | On | For |
|---|---|---|
| `patients_normalized_name` | `lower(regexp_replace(name,'\s+',' ','g')) text_pattern_ops` | Name prefix search. `text_pattern_ops` because the default collation's btree cannot serve `like 'prefix%'`. |
| `patients_phone_digits` | `right(regexp_replace(phone,'\D','','g'), 10)` | Phone match, normalized the way `find_possible_duplicates` has always normalized it. |
| `appointments_open_idx` | `(scheduled_at) where status in ('waiting','in_consult')` | The open queue. Partial, because the open rows are a vanishing fraction after year one. |
| `appointments_token_idx` | `(token)` | Searching by the slip in somebody's hand. Two things about it. A btree on the bare column cannot serve `upper(token) = …`, so the search folds only the caller's input (`token = upper($1)`) — tokens are generated uppercase, so that is equivalent and reachable; written the other way round the index was maintained on every arrival and used by nothing. And §3.7 — `token` still has no *unique* index, duplicates being a known condition of the carried-over data, so a token lookup must tolerate more than one row. |
| `encounters_patient_recent` | `(patient_id, created_at desc)` | The latest encounter for a patient. |
| `vitals_patient_recent` | `(patient_id, recorded_at desc)` | Whether anything was recorded today. |
| `follow_ups_open_due` | `(due_date) where status = 'open'` | The clinic-wide due list. Not a duplicate of `follow_ups_doctor_open_due_idx`, which leads on `doctor_id` and cannot serve a query that does not filter on it. |

### 13.4 Two things the search does to stay honest

**A typed name is escaped before it reaches a LIKE.** `%`, `_` and `\` are
LIKE's own vocabulary and a search box takes whatever it is given, so all three
are replaced with their escaped forms and every LIKE built from the result
names its escape character explicitly rather than inheriting the server
default. Unescaped, `%` matches the whole register and the cap decides which
twenty-five come back, and `_` widens an exact-looking prefix without saying
so. The same rule already governed the counter's outcome lookup; it now governs
the one place where the input is a person's name.

**A patient appears once.** The passes are a `union all` of four branches and a
patient can satisfy more than one, so the result is `distinct on (h.id)`
ordered by rank — the row kept is the strongest evidence for showing that
person, and `matched_on` then reports it truthfully. Without it the same person
came back twice in a list whose whole job is to tell two people apart.

Both are asserted, including the case of a patient genuinely named `R_D Kumar`
being found by typing `R_D` while `Radha Kumar` is not.

Expression indexes rather than stored normalized columns, deliberately. A stored
copy of a name is a second name that can fall out of step with the first;
Postgres maintains an expression index from the row itself, and a query written
with the identical expression uses it. Both expressions are `IMMUTABLE`, which is
what makes them indexable at all.

**What is not indexed.** A surname typed on its own matches in the middle of a
name, which no btree can serve. That case is a sequential scan with a hard cap of
25 rows on the output. `pg_trgm` would fix it and is not installed on this
database — there is no `create extension` anywhere in the migration set (§1) —
and installing one is a deployment decision rather than a read model's.

### 13.5 What Slice 1 did not add

No table. No mutable workflow-status column: every stage, obligation and count
the `workspace` endpoint reports is derived from the authoritative record at read
time. Nothing joined the clinic snapshot — its five unbounded collections
(`patients`, `medicines`, `batches`, `suppliers`, `orders`) did not become six.
No new `text` timestamp, and no new `real` money column, both of which §3 exists
to warn about.

One limitation is structural and worth stating beside the schema rather than
only in the contract: **`jmc.vitals` still carries a patient and a time and
nothing that ties a reading to a visit** — no `appointment_id`, no
`encounter_id`. So "were this visit's vitals taken" is not a question this schema
can answer, and the read model reports "was anything recorded for this patient
today" in those words instead. For a patient who attends twice in one day the two
are not the same. Adding the foreign key is the honest fix and belongs to a slice
that may change that table.

---

## 14. Backend programme Slice 2: the future, and the way out of an attempt

`20260920000000_slice2_appointments_and_reconciliation.sql`,
`20260921000000_slice2_acceptance_correction.sql`,
`20260922000000_same_attendance_closes_the_visit.sql` and
`20260923000000_a_reconciled_visit_stays_reconciled.sql`. Six new tables, five new
columns on `jmc.appointments`, seven on `jmc.appointment_events`, three new
unique indexes, three composite foreign keys, two check constraints added, one
index dropped and one constraint replaced. Owner policy items 65–74.

> Slice 2 was returned unaccepted during review and corrected six times. It was
> **accepted on 17 September 2026** after §14.15 and a 758/758 database gate.
> §14.9–§14.15 retain the review history; where sections disagree, the later
> section is the current behaviour.

### 14.1 The one decision the whole migration rests on

**`jmc.appointments` is not the appointment table. It is the arrival table**,
and the name is a fossil from the first schema. Every row in it is somebody
standing in the clinic with a token; `scheduled_at` is when they turned up
rather than when they were expected; and `snapshot.ts` sends every row of it
for today, all four statuses, to every tablet in the building with no role
boolean in front of it (§2.4, and `capabilities.ts` says so in as many words).

So a booking for next Tuesday is not a row in it. Owner item 70 — "A future
booking does not enter the live queue until check-in" — and a row in
`appointments` *is* the live queue. The alternative was a fifth status value,
which every reader in `components/` would have had to learn: `care-workspaces.tsx`
and `shared-panels.tsx` each hold an exhaustive `Record<status, tone>` that
would fail to compile, and eight more places compare `!== 'done' && !== 'cancelled'`
and would silently treat the new value as an active visit.

`jmc.appointment_bookings` is therefore the future, `jmc.appointments` stays
the present, and `check_in_appointment` is the only door between them.

### 14.2 The five tables

| | |
|---|---|
| `appointment_types` | Owner item 65. `duration_minutes` default 15 (owner item 65), check `> 0 and <= 480` — the ceiling is an implementation safety bound and **not** item 65, which said nothing about a maximum. Unique on `lower(trim(name))` **where active**, so a retired type may share a name with its replacement. |
| `provider_availability` | Owner item 71. A window is recurring (`weekday` + `effective_from`, optional `effective_to`) or dated (`on_date`), never both — a check enforces exactly one. `kind` is `open` or `blocked`; blocked subtracts. Retired rather than deleted. |
| `appointment_bookings` | Owner items 66–70. `scheduled_at timestamptz`, `duration_minutes` **copied** from the type, `status in ('booked','cancelled','no_show','checked_in')`, `overbooked`, `outside_availability` and `overbooked_reason` under one symmetric check (§14.9), `idempotency_key` + `request_fingerprint` with a unique index — the booking's own copy of the reference it was made under, beside the authoritative `appointment_command_receipts` row (§14.9). |
| `appointment_events` | Owner item 68. Append-only, `reject_signed_line_change()` on update and delete. Exactly one of `booking_id`/`arrival_id` per row, enforced by `check ((booking_id is null) <> (arrival_id is null))`. Eight event names. |
| `consultation_attempt_resolutions` | Owner items 72–74. Append-only, unique on `idempotency_key`. See §14.5. |

The duration is copied rather than joined because owner item 65 says "A type
change does not rewrite the duration already recorded for an existing booking"
— the same reasoning that snapshots the consultation fee onto the encounter
(§9.5) rather than reading `clinic_settings` back a month later. There is no
join to go stale.

`appointment_bookings` carries no `arrival_id`. The arrival is found through
`appointments.booking_id`, so one booking can never disagree with itself about
which queue row it became.

### 14.3 What `appointments` gained

| Column | Type | Note |
|---|---|---|
| `booking_id` | text, FK -> `appointment_bookings(id)` | Null for a walk-in, which is most rows. |
| `urgent` | boolean not null default false | Owner item 70. |
| `urgent_reason` | text not null default `''` | |
| `urgent_by` | text, FK -> `staff(id)` | |
| `urgent_at` | timestamptz | |

Plus `check (urgent = false or (length(trim(urgent_reason)) > 0 and urgent_by
is not null and urgent_at is not null))` — a priority with nobody's name and no
sentence behind it is not the reviewable override item 70 asks for.

Nothing is backfilled. Every existing row takes `false` and an empty reason,
which is what every existing row means.

### 14.4 Two unique indexes, one of them able to refuse

**`appointments_one_live_arrival_per_booking`** — unique on `booking_id`
`where booking_id is not null and status <> 'cancelled'`. This is what makes
"retrying check-in returns the same arrival and never creates two queue
entries" a guarantee rather than a hope. `status <> 'cancelled'` is not a
loophole: owner item 68 lets a doctor reschedule after check-in, and the honest
way to record that is to cancel the queue row the patient is no longer standing
in and let the moved booking check in again.

**`appointments_open_token_unique`** — unique on `token`
`where status in ('waiting','in_consult')`. This closes §3.7, and it closes
exactly the part of it that is a clinical safeguard. `20260909125224` declined
to constrain the column at all, on the ground that "a migration that fails on
the damage it exists to stop helps nobody", and that is right about the whole
table and too broad about the open rows: the harm it describes — "two waiting
patients simply hold JMC-0004, and one of them is called in for the other's
consultation" — needs both rows to be OPEN. Historical duplicates among
finished visits are untidy; duplicates among the eleven people in the corridor
are the wrong patient in the consulting room.

The migration **can refuse**, and does so with a sentence rather than a
constraint name: a `do $$` block finds open duplicates first and raises naming
each token and how many rows hold it, because the operator has to resolve the
queue before the index can be created and a SQLSTATE does not say which rows to
look at.

**`appointments_token_idx` is dropped.** `20260919000000` added it for exactly
one query, the patient search's token branch, and that query filters
`status in ('waiting','in_consult')` — which is the partial index's predicate.
The full index would go on costing a write on every arrival the clinic ever
records in order to answer nothing, which is the condition
`workspace-performance.test.mjs` was written to catch; its plan assertion now
names the partial index and asserts the old one is gone.

### 14.5 The reconciliation record, and the four things it is not

`consultation_attempt_resolutions` is one append-only row per consultation
attempt: what the server established about that attempt's outcome, and what a
doctor then determined. `idempotency_key` is unique, so an attempt is resolved
once — a repeat replays, a different determination is refused, and two doctors
resolving at the same moment produce one row.

`idempotency_key` is deliberately **not** a foreign key to anything. The whole
point of the table is that the key may name nothing at all, which is precisely
the `not_committed` case.

Seven constraints and one deferred trigger say what it may not be. Four are
from `20260920000000`; `20260922000000` added a fifth which
`20260923000000` then **replaced**, because a check on a boolean the writer
sets can only ever ask whether the writer said so — see
[§14.11](#1411-the-third-acceptance-correction-16-september-2026):

```sql
check ((prior_outcome = 'committed') = (encounter_id is not null))
check (resolution <> 'same_attendance' or prior_outcome = 'committed')
check (resolution <> 'abandoned_attempt' or prior_outcome = 'not_committed')
check (subject_visit_closed = false
       or (subject_visit_id is not null and resolution = 'same_attendance'))

constraint resolutions_disposition_is_one_of_three
  check (subject_visit_disposition in ('closed_now', 'already_done', 'not_applicable'))

constraint resolutions_disposition_follows_the_determination
  check (case when resolution = 'same_attendance' and subject_visit_id is not null
              then subject_visit_disposition in ('closed_now', 'already_done')
              else subject_visit_disposition = 'not_applicable' end)

constraint resolutions_closed_flag_follows_disposition
  check (subject_visit_closed = (subject_visit_disposition = 'closed_now'))

constraint resolutions_abandoned_names_no_visit
  check (resolution <> 'abandoned_attempt' or subject_visit_id is null)
```

**And a closure is not checked at all — recording it is what performs it.**

`appointment_events_closure_is_genuine` fires `before insert` on every
`closed_on_reconciliation` row. It locks the determination the event names and
the visit the event names, refuses a visit that is not `waiting` or
`in_consult`, **updates that visit to `done`**, and fills in `from_status` from
the row it locked. The event cannot describe a transition that did not happen,
because inserting the event is the transition.

It also refuses an event whose `actor_id` is not the determination's own
`resolved_by`, and **overwrites `reason` and `detail`** from that determination
exactly as it overwrites both statuses. A closure is performed by the doctor who
determined it, in the words they used; every one of those is read from the
stored row rather than taken from whoever is writing. Nothing a caller supplies
survives into the record.

`jmc.close_visit_for_reconciliation(resolution_id)` takes **one argument**. It
locks that determination, derives the visit, the actor, the reason and the
prescription the consultation was signed as, and inserts the event. It returns
what actually happened — `closed_now`, `already_done` for a visit that was
already finished, and a refusal for a cancelled one.
`appointment_events_one_closure_per_resolution` allows one proof per
determination.

**Why this rather than a better check.** Four reviews found the same shape one
layer down each time. `20260920000000` trusted a boolean. `20260922000000`
checked that boolean. This migration's first draft checked that an event existed
and that its `to_status` was honest — and the fourth review wrote the row the
check was looking for, beside a visit already `done` for unrelated reasons, with
the suite's own test calling that forgery "the true one".

The fourth attempt answered with *provenance*: a transaction-local setting the
closing function set and the trigger checked. The fifth review called
`set_config()` itself, which any session may do, and the forgery worked again. A
convention is not a capability.

There is nothing left to assert. The only way to write the event is to move the
visit, and the only way to move it that way is to write the event.

`resolutions_subject_is_what_it_claims`, a **deferred** constraint trigger,
remains for what the function cannot see — a determination that is wrong about a
visit nobody forged anything about:

- a `same_attendance` naming a visit requires that visit to be `done`;
- `closed_now` requires exactly one closure proof carrying this resolution's id;
- `already_done` requires none — **and requires the visit to have no
  consultation of its own.** Owner item 75 links retrospectively to a visit that
  was left finished, not to one that was seen: if a signing under a fresh
  reference won the visit lock and wrote its own encounter and fee, recording
  that visit as the same attendance as an earlier consultation would hide the
  duplicate rather than resolve it. The encounter the determination is about is
  excluded, because a consultation signed against its own visit is ordinary;
- a `new_attendance` naming a visit requires it to be `waiting` or
  `in_consult`, because owner item 74 keeps it available to consult.

- It is **not an edit of a signed encounter.** `same_attendance` records the
  link here and leaves `encounters.appointment_id` exactly as the doctor signed
  it. Owner item 72's first clause.
- It is **not a second consultation.** Nothing in the command writes an
  encounter, an invoice, an invoice line, a prescription or a follow-up. No
  constraint can say that; `slice2-reconciliation.test.mjs` asserts the
  complete side-effect set on every branch instead.
- It is **not an automatic release.** `prior_outcome` is what the server
  established under a lock, and there is no value for "probably".
- It is **not a guess about which visit is which.** The subject visit is named
  by the doctor, because owner item 74 says reception creating a second queue
  row is not evidence of a second consultation.

### 14.6 The advisory lock, and why the schema needs one at all

`ATTEMPT_LOCK_NAMESPACE` (in `_shared/idempotency.ts`, so both halves pick the
same number) is taken on `hashtext(idempotencyKey)` as the first statement of
the signing transaction and, as a **try**-lock, of the resolution transaction.

The unique index on `encounters.idempotency_key` serializes two signings. It
cannot serialize a signing against a RESOLUTION, because the two write
different tables and neither collides with the other — and that pair is exactly
what owner item 73 fails closed on. Without the lock, a doctor resolving an
attempt reads "no encounter carries this key", concludes nothing committed,
records **New attendance**, releases the reference, and the signing that was in
flight the whole time commits a moment later. The next press then writes a
second encounter and a second ₹300 fee.

So a signing WAITS for a resolution, briefly. A resolution does not wait for a
signing: it refuses with `ATTEMPT_OUTCOME_NOT_ESTABLISHED`, because "somebody
is signing under this reference right now" is the definition of an outcome that
cannot be established. `workspace?view=reconciliation` tests the same lock
without waiting, so the read reports `unknown` rather than a confident
`not_committed` that is about to stop being true.

Both take it before any row lock, so the ordering is identical in both and
neither can deadlock against the other. The booking commands use a second,
separate namespace on the doctor, so a calendar conflict and a consultation
attempt never wait on each other.

### 14.7 What Slice 2 did not add

No new `text` timestamp and no new `real` money column — in either migration. Nothing joined the
clinic snapshot — its five unbounded collections did not become six; the one
field added to an existing snapshot row is `appointments.urgent`, a boolean,
and the reason behind it is deliberately withheld because that collection has
no role gate in front of it.

`jmc.vitals` still cannot be tied to a visit (§13.5), and this slice did not
change it: the honest fix is a foreign key on a table this slice had no reason
to open.

### 14.8 A correction to §1.5 and §3.7

§1.5 says "Indexes: `appointments_pkey` only. Nothing indexes `scheduled_at` or
`status`". That was true when it was written and stopped being true at
`20260919000000`. As of `20260920000000` the table carries:

`appointments_pkey`, `appointments_patient_id_idx`, `appointments_open_idx`
(partial on `scheduled_at` where open), `appointments_open_token_unique`
(partial unique on `token` where open), `appointments_one_live_arrival_per_booking`
(partial unique on `booking_id`), and `appointments_urgent_by_idx`.

§3.7's last sentence — "Any slice that adds the index must first find and
resolve the duplicates" — is now what the migration does, for the open rows,
with a named refusal. The historical duplicates among finished visits are still
there and are still unconstrained, deliberately.


### 14.9 The acceptance correction, 16 September 2026

Slice 2 was returned unaccepted. The reviewer reproduced six faults against the
guarded loopback database that 632 passing tests did not see. Three of them
needed the schema.

**`jmc.appointment_command_receipts`.** One row per completed appointment
command, written in the same transaction as its effect, unique on
`idempotency_key`, append-only by trigger, and holding the ORIGINAL outcome as
`jsonb` beside the request fingerprint and what the command touched.

It exists because four commands were deciding "have I already done this?" by
reading the booking's CURRENT state, and that is a guess that expires — the
whole reason a retry arrives late is that the state moved. A lost reply to
"move to 11:00", arriving after somebody moved the appointment to 12:00, moved
it back to 11:00. A lost check-in, arriving after a reschedule, minted a second
queue token and dragged the booking back into `checked_in`. The programme's
rule says *stores*, not derives.

One trap worth recording, because it made the mechanism silently useless before
any test could see it: the driver serializes a parameter bound to a `json`
column by JSON-stringifying it, so an already-stringified value went in
stringified twice and came back a JSON string scalar. The insert casts
`?::text::jsonb` and the read tolerates both shapes.

**Seven columns on `jmc.appointment_events`.** `appointment_type_before/after`,
`duration_before/after`, `overbooked`, `outside_availability` and
`override_reason`. A reschedule that changed the appointment type left a
history saying the time had moved and nothing else, and an override applied
during a reschedule was validated and then discarded entirely — the booking
kept whatever flags the ORIGINAL booking had decided. Owner item 68 asks for
the prior state, the actor, the time and the reason; what the transition
changed and what had to be overridden to make it ARE the transition.

**One symmetric override rule, replacing an asymmetric one.**
`20260920000000` required a reason for `overbooked` and required nothing for
`outside_availability`, although the column comment beside it described the
reason as covering both:

```sql
check (case when overbooked or outside_availability
            then length(trim(overbooked_reason)) > 0
            else overbooked_reason = '' end)
```

Both directions matter. The second half is what stops a reschedule into a clear
slot clearing the flags and leaving the old reason standing, which reads on a
screen as an override that is not there.

The constraint it replaces was created WITHOUT a name, so Postgres called it
`appointment_bookings_check` — and the correction's first attempt dropped a name
that had never existed, leaving the weaker rule in place beside the stronger
one. It is found by its definition now. The migration rehearsal caught that, by
setting `overbooked = true` with no reason and being refused by the wrong
constraint.

**Three composite foreign keys.** `consultation_attempt_resolutions` could
record that one patient's queue row was the same attendance as another
patient's consultation; the command checked the encounter and neither visit.
`(opened_visit_id, patient_id)` and `(subject_visit_id, patient_id)` now
reference `appointments (id, patient_id)`, and `(encounter_id, patient_id)`
references `encounters (id, patient_id)`, with unique indexes added on both
parents to make those references possible.

Checking it in the command is necessary and not sufficient: the constraint is
the guarantee and cannot be forgotten, and the command is the sentence a doctor
reads, which a constraint violation is not. Both are there.

**And one attribution removed.** The 480-minute ceiling on an appointment type
was written under a heading citing owner item 65. Item 65 decided the
fifteen-minute default and the per-type override and said nothing about a
maximum. The bound stays; a column comment now says it is an implementation
safety bound and that no owner decision selected it.

### 14.10 The second acceptance correction, 16 September 2026

Returned again. Four findings, five reproduced failures; one needed the schema.

**`resolutions_same_attendance_closes_its_visit`, in
`20260922000000_same_attendance_closes_the_visit.sql`.** Forward-only; nothing
already applied was edited.

```sql
check (case when resolution = 'same_attendance' and subject_visit_id is not null
            then subject_visit_closed
            else not subject_visit_closed end)
```

Read both ways round: a same-attendance that NAMES a visit has closed it, and
nothing else may claim to have closed one. The second half was already true in
`20260920000000` and is restated so that one constraint carries the whole rule
rather than a reader having to find two and notice that together they mean
something neither says.

`20260920000000` enforced only that weaker half, so a determination naming a
visit that was **already cancelled or finished** was accepted, recorded with
`subject_visit_closed = false`, and then described on the doctor's next press
as a visit they had closed. A false sentence in a clinical record — and one
that had already spent the reference's single resolution on its way to being
said, leaving the doctor with no way back. Owner item 72 defines Same
attendance as creating the link *and* closing the leftover visit; it does not
describe one that closes nothing.

The command refuses it now with `SUBJECT_VISIT_NOT_OPEN`, before anything is
written. The constraint is the other half, for the same reason as the composite
keys above: the constraint is the guarantee and cannot be forgotten, the
command is the sentence somebody reads, and a constraint violation is not that
sentence. The migration names any offending rows before adding the constraint
rather than migrating past them, because each one is a clinical determination
with a doctor's name on it.

**The three that did not need schema**, recorded here because §14.9's account
of the receipt is otherwise read as stronger than it is:

- *A receipt is read before anything MUTABLE happens*, not "before anything
  else". The role check and canonicalising the caller's own values run first;
  the ninety-day horizon, the doctor roster and today's date now run inside the
  receipt's transaction. Before this, a reschedule that succeeded yesterday was
  refused with "that day is in the past", and a nurse's exact retry was refused
  with "say which doctor this appointment is with" after a locum joined — both
  about work that had already committed. The fingerprint is built from what the
  caller SENT; the resolved doctor is stored as result identity instead.
- *`superseded` describes the whole effect.* It compared the scheduled instant
  alone, so a second reschedule to the same time with a longer type replayed
  the thirty-minute outcome, reported the current duration as forty-five and
  said `superseded: false`. The appointment type is compared by id, because two
  types may run the same number of minutes. A creation and an update no longer
  share a rule.
- *The reconciliation read mirrors the command's precedence from one table.* A
  cross-patient `openedVisitId` made one determination of three unavailable,
  so two buttons were offered that the command refused.

### 14.11 The third acceptance correction, 16 September 2026

Returned a third time. Four findings, one of which reopened the
duplicate-consultation and duplicate-fee path this slice exists to close.

**`20260923000000_a_reconciled_visit_stays_reconciled.sql`.** Forward-only.
Nothing already applied is edited; one constraint added by `20260922000000` is
dropped and replaced by rules that say what it meant to say.

**A reconciled visit could be put back in the queue.** `set_appointment_status`
moves any visit to any status, so a visit closed as the same attendance could
be set back to `waiting` by a nurse tidying the queue and then signed again
under a fresh reference — no idempotency guard applies to a new key.
Reproduced: **two encounters, two fee lines, ₹600 for one attendance**, through
the door built to prevent exactly that.

`appointments_reconciled_visits_stay_closed` is a `before update` trigger on
`jmc.appointments`: a visit named by a `same_attendance` determination never
returns to `waiting` or `in_consult`, whatever moves it. The command refuses it
too, with a sentence and `VISIT_RECONCILED_AND_CLOSED`, and `sign_consultation`
refuses one by name rather than falling through to "that visit is already
finished". A `new_attendance` subject is deliberately untouched — owner item 74
keeps that one available to consult.

**The closure constraint checked a boolean, not a closure.** Described above.
The replacement is the deferred trigger, and the schema document's earlier
claim that no other database route could record a false closure was simply
wrong; it is corrected in place.

**`20260922000000`'s pre-flight was unusable.** It named the offending rows and
said to "close or cancel the visits they name, and record the correction" —
but the resolution row is immutable, so closing the visit afterwards changes
nothing about it, and the unique key on `idempotency_key` forbids a replacement
determination. It named a problem and no way out of it. The new migration's
three pre-flights each print the statement that makes the record true again,
and none of them touches a resolution: the visits are brought into line with
what a doctor determined about them.

**A new attendance accepted a visit nobody could consult**, and could be
recorded without naming one at all while visits stood in the queue. Both are
refused now, by the command and by the deferred trigger.

**And the owner decision of the same day**, item 75 of
`OWNER_POLICY_REGISTER.md`: `subject_visit_disposition`, three values, so that
a retrospective link to a visit already `done` can be recorded without claiming
a closure that did not happen. `subject_visit_closed` is kept in step by
`resolutions_closed_flag_follows_disposition` and means exactly what it always
meant.

**One thing a reader should know about re-running.** `20260922000000`'s
pre-flight encodes the policy as it stood before item 75, so it reads an
`already_done` row as hollow. A database that has adopted the decision does not
re-run that migration. Migrations are applied once and recorded, so this costs
nothing in the clinic; it is written down because the migration rehearsal
applies everything twice, and its fixture uses a `closed_now` closure for that
reason.

### 14.12 The independent review of the third correction

Five findings, read out of the source by a reviewer who did not write it, plus
one the lead found while checking the trigger's coverage. All six are fixed in
`20260923000000` and its commands before the migration was ever applied outside
the scratch database.

**A reconciled visit could still be cancelled.** The trigger blocked the return
to `waiting` and `in_consult` — the money path — and let `done → cancelled`
through, leaving a determination saying the patient was seen at that visit
beside a queue row saying the visit never happened. No second fee is reachable
that way, because signing needs an open visit, which is exactly why it would
have gone unnoticed. `done` is the only status a reconciled visit may still
take; the determination's own closure is an update the trigger sees, with the
resolution already written, so that one is permitted and nothing else is.

A test in this round had asserted the cancellation was allowed, as a guard
against over-correction. It asserted a defect. It now asserts the rule.

**The deferred trigger counted events without reading them.** It asked for a
row with the right `event`, `arrival_id` and `resolution_id` and looked no
further, so an event claiming the visit went to `cancelled`, or came from a
status it was never in, satisfied a constraint whose entire purpose is that a
closure is an event rather than a boolean. `to_status` and `from_status` are
checked now.

**The migration's own remediation SQL wrote a false transition.** Its `UPDATE`
matched visits in `waiting` or `in_consult` and the paired `INSERT` hardcoded
`from_status = 'waiting'`, so an operator running the statement this migration
offers as "the statement that makes the record true again" would have written a
false transition into the audit trail it exists to make trustworthy. It is one
statement now, and `RETURNING` gives each visit's status as it was before.

**The read did not tell a `new_attendance` to name its visit.** The correction
gave that determination a `SUBJECT_VISIT_REQUIRED` refusal and left its `detail`
branching on whether anything had been signed. See §12.3.

**And one message said two things.** `RESOLUTION_MESSAGES` took a boolean, so
`already_done` — the whole of owner item 75 — read exactly like a determination
that named no visit at all. It takes the disposition now.

### 14.13 The fourth acceptance correction, 16 September 2026

Returned a fourth time. Four blocking defects and one integrity race, all five
reproduced before anything was edited.

**The migration could not upgrade a single real row.** Both
`consultation_attempt_resolutions` and `appointment_events` carry `before
update` triggers that raise unconditionally, so the backfill in the first draft
of `20260923000000` would have failed on any clinic that had recorded a
reconciliation between `20260922000000` and it. The rehearsal was green because
it had no such rows.

It now seeds exactly those rows — a `same_attendance` with
`subject_visit_closed`, its visit `done`, and a closure event with nothing
pointing back at the determination — applies the two migrations in sequence, and
asserts the upgrade happened. The backfill disables the two triggers for the
width of its own statements, inside the migration's transaction, as the table
owner, deriving every value from what is already stored.

**The printed recovery SQL could not work.** It read the prior status from an
`UPDATE ... RETURNING`, which returns the row as it now is, so every event it
wrote would have said `done -> done` and been rejected by the very rules the
recovery exists to satisfy. It now prints a call to
`close_visit_for_reconciliation`, which reads the status itself.

**`closed_now` was still forgeable.** Described above. The answer is that the
database performs the closure rather than checking a claim about one.

**The lock read combined locks held by different backends.** A resolution holds
both namespaces on one connection; a signing holds the attempt lock alone. The
query asked whether each lock was held anywhere, so a doctor signing on one
connection while another resolved on a second was reported as "nothing is being
signed" — the one sentence owner item 73 must never produce. It groups by `pid`
now, and a backend holding the attempt lock without the resolution lock is a
signing, which wins.

**And `already_done` could paper over a duplicate.** The race: a signing under a
fresh reference wins the visit lock, writes its own encounter and its own ₹300,
and leaves the visit `done`. The reconciliation then wakes, sees `done`, and
records that visit as the same attendance as the earlier consultation. It did
not cause the duplicate; it wrote a false determination over it and hid the
condition reconciliation exists to expose. Refused now by the command with
`SUBJECT_VISIT_ALREADY_CONSULTED`, which says the patient has been charged twice
and the duplicate needs correcting on its own, and by the deferred trigger
whatever route is taken.

### 14.14 The fifth acceptance correction, 16 September 2026

Three integrity blockers, all reproduced.

**`closed_now` was still forgeable**, because the guard was a GUC. The
correction is section 5 above: recording the closure performs it. There is no
setting to spoof.

**The recovery command did not exist when the migration printed it.** The
pre-flight told an operator to call `jmc.close_visit_for_reconciliation()`,
which the same migration creates two hundred lines further down — so the remedy
was unavailable at exactly the moment it was needed, and the rehearsal could not
notice because its only legacy row was already valid. The message now prints
SQL that uses nothing but the schema in force before this migration, and the
rehearsal seeds a hollow row, observes the refusal, executes the printed
statement **verbatim**, and applies the migration again. If the message ever
stops matching what works, that check fails.

**The closure event could name the wrong staff member.** The function took
`p_actor`, `p_reason` and `p_detail` from its caller and believed them; the
review closed a doctor's determination with a nurse's id and the event named the
nurse. The function takes the determination's id alone now, and the trigger
checks `actor_id` against `resolved_by` independently of it.

### 14.15 The sixth acceptance correction, 17 September 2026

One blocking finding, tightly bounded.

**The audit text was still the writer's.** The trigger derived the transition,
the visit, the actor and both statuses, and took `reason` and `detail` from
whoever inserted the row — so a genuine closure, performed by the right doctor
against the right visit, could carry a fabricated reason in an append-only
clinical record. Owner item 72 keeps the doctor's reason; this kept whatever
arrived.

It reads the determination's `reason` and `encounter_id` now, derives the
prescription number itself, and overwrites both fields. The closing function no
longer builds the detail, so there is one construction of that sentence rather
than two that can drift apart.

Two cleanups came with it. The rehearsal's recovery check ran a duplicated copy
of the printed SQL and matched one phrase of the message; it now cuts the
statement out of the refusal text itself and executes those characters, so
"verbatim" is a fact rather than a claim. And `docs/README.md` said thirty-six
unit tests where the gate reports thirty-eight.

### 14.16 The appointment station's one read, 24 September 2026

No migration, no table, no column. The bounded appointment-book cutover
(`reference/SLICE2_FRONTEND_CONTRACT.md` §11) needed three backend changes,
all in the read path:

- **`view=appointment_outcome`** — `readAppointmentCommandOutcome` in
  `_shared/appointments.ts`, capability `view.appointment_outcome` (admin,
  doctor, nurse) and then scoped to the receipt's own `actor_id`. It reads
  `appointment_command_receipts` by key, observes `RECEIPT_LOCK_NAMESPACE` in
  `pg_locks` for a request in flight, and merges the same per-command
  `standing` the replay merges — the switch in `runAppointmentCommand` now
  reads its `standing` from the same `STANDING` table, so the replay and the
  read cannot disagree about `superseded`. Contract §4.0a.
- **`view=outcome` stops saying something untrue.** For a key an appointment
  receipt carries, it now returns `committed: true` with `operation: "unknown"`
  and directs the caller to the actor-scoped appointment outcome read. It does
  not expose the appointment's details.
- **The calendar and history reads send instants as UTC ISO-8601 with
  milliseconds**, as §5 of the contract always said. They were sending
  `String(Date)`. The view shapes moved to `_shared/appointment-types.ts`, a
  leaf with no imports re-exported through `types.ts`, and a booking's
  `status` is typed as `booked | checked_in | cancelled | no_show`.

---

## 15. Backend programme Slice 3A: communication truth

`20260924000000_slice3a_communication_truth.sql`. Five new tables, two new
trigger functions, no change to any existing table, column, index or command
response. Owner policy items 76–83.

**Nothing in this slice sends a message.** There is no provider network
adapter, no webhook endpoint, no scheduler, no credential and no live call, and
§15.8 lists what is deferred and what a later slice has to satisfy.

### 15.1 The five tables

| Table | What one row is |
|---|---|
| `message_templates` | One immutable version of one wording. `series_id` + `version`; the clinic's approval and Meta's approval are separate states. |
| `communication_consents` | One append-only piece of consent evidence, scoped to a channel and a purpose. |
| `communication_schedules` | One intended send, tied to an authoritative record a person created. |
| `message_outbox` | One message. Created when the intention is, long before any provider contact. |
| `message_attempts` | One provider call. Committed before the call and settled once afterwards. |

Owner item 78's four purposes — `appointment`, `clinical_recall`,
`ready_for_collection`, `service_interruption` — are the same check constraint
on four of them. A fifth is a policy decision, not a value somebody may add.

Slice 3A builds schedule sources for `appointment` and `clinical_recall` only.
The other two purposes exist for consent and for templates and have no source
yet; that is stated rather than implied, and §15.8 records it.

### 15.2 The state machine

```text
scheduled ─┬─ prepare ──▶ queued ──┬─ accepted ─▶ sent_to_provider ─┬─▶ delivered
           │                       │                                └─▶ failed_terminal
           │                       ├─ refused, retryable ─▶ failed_retryable ─┐
           │                       ├─ refused, terminal ──▶ failed_terminal   │
           │                       └─ reply lost ─────────▶ outcome_unknown   │
           ├─ no consent / no template / no channel ─────▶ suppressed         │
           └─ source cancelled ──────────────────────────▶ cancelled          │
                                                          ◀──── retry ────────┘
```

Three of those states exist because the truth is awkward and the alternatives
are lies:

**`sent_to_provider` is not `delivered`.** Meta's `POST /messages` answers
`accepted`, `held_for_quality_assessment` or `paused`; only the statuses
webhook ever says `delivered`. A message held for quality assessment has
demonstrably reached nobody, and an HTTP 200 reported as delivery would be
wrong most reliably on the days the channel was degraded.

**`outcome_unknown` is what a lost reply leaves.** The attempt row commits
before the provider is called, so a process that dies mid-call leaves an
`in_flight` attempt and a message that says nobody knows. No worker picks it up
again: only provider evidence settles it, because a blind retry is how one
reminder becomes two.

**`suppressed` is a decision with a reason**, not a silence. Owner item 76 sends
that work to a staff queue, and the suppressed row is the queue entry. The
reasons are a closed list: `no_consent`, `consent_withdrawn`,
`channel_not_configured`, `no_approved_template`,
`provider_template_not_approved`, `no_contact_number`,
`link_destination_unavailable`, `variable_unavailable`, `past_useful_by`.

### 15.3 Templates, and what a new version is for

Owner item 81. `approval_state` is the clinic's verdict and `provider_state` is
Meta's; a message needs both, and either can be withdrawn alone — Meta pausing
a template for quality suppresses the next send with a reason rather than
failing it.

`protect_message_template` refuses to let a version become a different
template. Wording, purpose, variables, locale, link destination, provider
category, the content fingerprint, the creator and the supersession pointer are
all fixed once written; an approval cannot return to draft; and who approved a
version and when cannot be rewritten. Two partial unique indexes make "the
approved template for this purpose" a question with exactly one answer.

Two content guards are structural rather than procedural. `variables_json` is
constrained to a six-name whitelist — `patient_given_name`, `clinic_name`,
`appointment_date`, `appointment_time`, `due_date`, `link` — so there is no
variable for a medicine, a diagnosis, a balance or an image and therefore no
way to interpolate one. And the body is refused if it carries a currency
marker or the words *balance*, *amount*, *payment* or *outstanding*, which is
owner item 22 and item 81 expressed as a check constraint. Medicine names and
diagnoses cannot be caught by a regex, so the command checks the body against
the formulary and the approved diagnosis vocabulary instead. None of this
replaces the doctor's approval; item 81 requires that separately.

### 15.4 Consent

Append-only, and the effective answer is a query rather than a column: the
latest applicable row for a patient, channel and purpose wins, and **no row at
all means no**. An unqualified withdrawal applies to every purpose; a
purpose-specific one applies to that purpose alone.

Ordering is by `sequence_no`, an identity column, and not by `recorded_at`.
`now()` is the transaction's start time, so two consents recorded at one desk
in one transaction tie — and the patient's latest instruction decided by a uuid
is not a property anybody should have to reason about.

A check constraint refuses an opt-in whose source is `patient_chat`. Owner item
82's last sentence is that a patient-initiated conversation does not silently
restore standing consent, and this schema has no way to do so even by accident.

**Nothing was backfilled.** `patients.whatsapp_consent` is a blanket
registration flag that names no purposes, and item 78 says a registration
choice is valid only for the purposes it names. The table starts empty and the
automated channel starts fully suppressed, which is the only honest place to
start from. The consequence is stated plainly in §15.7.

`withdraw_communication_consent` takes the patient's schedules under `for
update` before sweeping their messages, and every preparation takes the message
row under `for update` first. Either order of a withdrawal racing a preparation
therefore ends with nothing sendable, and
`tests/characterization/slice3a-messaging.test.mjs` runs the race rather than
reasoning about it.

### 15.5 Timing, and what is owner policy versus an implementation bound

Every rule below is computed in `Asia/Kolkata` in Postgres, never in
JavaScript. `clinic-policy.ts` holds each number with the owner item it comes
from, or with an explicit statement that it has none.

| Rule | Value | Source |
|---|---|---|
| Dispatch window | 08:00 inclusive to 20:00 exclusive | owner item 77 |
| Appointment reminder | 18:00 on the previous clinic day | owner item 77 |
| Late booking | its confirmation replaces the reminder | owner item 77 |
| Clinical recall | 09:00 on the due date | owner item 77 |
| Provider attempts | at most 3, within 2 hours of the first | owner item 79 |
| Failure ownership | admin, from the first failed attempt | owner item 79 |
| Owner-doctor escalation | 4 clinic hours unresolved | owner item 79 |
| Retry backoff | 15 then 40 minutes | **no owner item** — an implementation bound that fits three attempts inside two hours |
| Recall usefulness deadline | 20:00 on the due date | **no owner item** — the narrowest reading that cannot become a second day's chase |
| "Four clinic hours" | 4 elapsed hours, moved to the next dispatch opening if that lands outside clinic hours | **an interpretation**, recorded below |

That last row is the one interpretation in this slice and it is written down
rather than buried. "Four clinic hours" could mean four hours of wall-clock
time regardless of the hour, or four hours during which the clinic is open.
The implementation moves the escalation moment forward to the next 08:00 when
four elapsed hours would land outside the window, so a failure at 19:00 reaches
the owner-doctor at 08:00 rather than at 23:00 when nobody is there to act on
it. It never escalates earlier than four elapsed hours. If the owner means the
other reading, one expression in `readCommunicationFailures` changes.

**No retry ever crosses a night**, and that is a property rather than a rule
anybody wrote: two hours from any moment inside the dispatch window ends before
the next morning's 08:00, so an evening failure has no legal retry slot and
becomes a terminal failure the admin owns that evening. It is asserted as such.

### 15.6 Idempotency, privacy and audit

`message_outbox.idempotency_key` is `<schedule uuid>:<generation>`, and a check
constraint holds it to that shape. It carries no patient id, phone number,
name, purpose or clinical word, because it is the one string in this schema
designed to be repeated in logs. `message_attempts.provider_reference` is
unique, so one provider message maps to one attempt and a duplicate webhook
resolves to the same row.

`message_attempts.error_detail` is redacted before it is stored: any run of six
or more digits becomes `[number]`, because a provider's error text quotes the
recipient's number back and that string is read by screens and pasted into
support threads.

Every command writes an `audit_events` row. Nothing here reaches the snapshot:
the programme's rule since Slice 1 is that no read model joins the
fifteen-second poll, and all four messaging reads are on-demand `workspace`
views behind `capabilities.ts` entries.

### 15.7 Compatibility

`send_order`, `send_patient_whatsapp`, `whatsapp_messages` and
`_shared/whatsapp.ts` are unchanged except that `dialable` is now exported so
the outbox normalizes a number the same way rather than a second way.
`tests/characterization/slice3a-whatsapp-compatibility.test.mjs` was written
before this slice and holds both commands to what they answered.

Five appointment commands and `complete_follow_up` gained a call that maintains
schedule rows inside the transaction they already open. No response changed, no
column they read was altered, and nothing they do can now contact anybody.

**The staff message composer still uses the old blanket flag.**
`send_patient_whatsapp` is a member of staff typing a message and pressing
send, which is not an automated clinic-initiated purpose message, and moving it
onto per-purpose consent is deferred work rather than an oversight. It is named
in §15.8.

### 15.8 Deferred, explicitly

None of these is unfinished Slice 3A work; each is a named piece of Slice 3B or
later, and the clinic is complete and honest without them.

> **Built in Slice 3B, 18 September 2026.** The first three entries below were
> the state at the end of Slice 3A and are kept as the record of what it left.
> The adapter and the webhook now exist — see §16 — and the scheduler's
> contract is implemented while its provisioning is still deliberately not
> done. Everything else in this list is still deferred.

- **The provider adapter.** `officialWhatsAppChannel.send` refuses terminally.
  It is unreachable in practice because `configured()` is false without the
  five `WHATSAPP_*` variables and the prepare step then suppresses every due
  message into the staff queue. *(Slice 3B: built, §16.2.)*
- **The authenticated provider webhook.** `applyProviderEvidence` holds the
  semantics — monotonic rank, duplicates and out-of-order evidence ignored,
  terminal truth never regressed — and is tested directly. No endpoint calls
  it, because an endpoint that takes delivery evidence must verify Meta's
  signature and there are no credentials to verify against. *(Slice 3B: built,
  §16.5.)*
- **Scheduler provisioning.** Nothing invokes the worker. `pg_cron`, `pg_net`,
  Vault and Supabase Queues are all unprovisioned. The contract a later slice
  has to satisfy: call `prepareDueMessages` and then `dispatchQueuedMessages`
  on a schedule no coarser than five minutes, with one caller at a time or
  relying on the row locks, from something that can hold a secret. Supabase's
  current answer is `pg_cron` plus `pg_net` with the token in Vault; an
  external scheduler calling an authenticated Edge Function is equivalent.
  **Do not rely on in-process background work**: a Deno isolate recycled
  mid-call is exactly the `outcome_unknown` case. *(Slice 3B: the invocation
  contract and its protected endpoint are built, §16.4 and §16.6. Nothing is
  provisioned.)*
- **The full recall-cohort release.** Slice 3A releases one recall at a time,
  by the responsible doctor or an authorized one. Owner item 80's saved,
  frozen, dry-runnable cohort is not built.
- **The frontend messaging workspace.** No screen exists. The four read models
  are reachable and typed; nothing renders them.
- **Production provider-policy validation, approved Meta templates,
  credentials, and the clinic privacy notice.** Owner section M's closing
  paragraph names these as release gates, and this slice does not waive them.
- **Moving `send_patient_whatsapp` onto per-purpose consent**, and deciding
  whether the registration checkbox should prompt for the purposes it covers.
- **`ready_for_collection` and `service_interruption` schedule sources.** Both
  purposes exist for consent and templates; neither has an authoritative record
  behind it yet.

---

## 16. Backend programme Slice 3B: provider delivery and evidence

`20260925000000_slice3b_provider_events.sql`. **One** new table, no change to
any existing table, column, index, constraint or command response, and no
backfill. Slice 3A's migration is untouched.

Slice 3A ended one step in front of the network. Slice 3B takes that step: the
adapter that speaks to Meta, the endpoint that hears back, and the protected
contract a scheduler will call. It does **not** provision a scheduler, create a
credential, submit a template, or contact Meta. With this clinic's connection
still unconfigured the application behaves exactly as it did the day before —
every due message suppressed into the admin's queue with
`channel_not_configured` against it — which is the only honest thing a clinic
with no WhatsApp Business account can do.

### 16.1 What was added

| File | What it is |
|---|---|
| `_shared/messaging-transport.ts` | The transport vocabulary, moved out of `messaging.ts` into a leaf module so the adapter and the state machine do not import each other. Every name `messaging.ts` exported, it still exports. |
| `_shared/whatsapp-cloud.ts` | **The only file that addresses `graph.facebook.com`.** Builds the template payload, calls once, and normalizes the answer. |
| `_shared/internal-auth.ts` | How this application authenticates something that is not a person. See §16.6. |
| `functions/whatsapp/index.ts` | Meta's verification challenge and its signed statuses webhook. |
| `functions/worker/index.ts` | The protected endpoint one dispatch cycle runs behind. |
| `message_provider_events` | One authenticated status event, deduplicated durably. |

There are now **fifteen** Edge Functions. The two new ones are the only two
that are not driven by a member of staff holding a session.

### 16.2 The transport boundary

`MessageChannel` has four fields and two methods and nothing Meta-shaped in
any of them. The durable state machine never sees a `fetch`, a Graph URL or a
Meta response object; it asks a channel whether it is configured and then asks
it to send. Every test in this repository runs against a channel that refuses
at construction to address anything but loopback.

What the production adapter is allowed to decide is the payload, the endpoint
and what an answer means. What it may not decide is anything about consent,
quiet hours, retries or whether a message is worth sending — all of that is
settled under a row lock before `send` is called, and re-asked there.

**Clinic-initiated sends are approved template messages only.** A free-text
message is not expressible on this path: `buildTemplatePayload` writes
`type: 'template'` and there is no branch that writes `type: 'text'`.

### 16.3 What Meta's documentation says, and what is still provisional

Verified against Meta's own current documentation and cited where used:

| Fact | Consequence here |
|---|---|
| `POST /messages` answers `message_status` of `accepted`, `held_for_quality_assessment` or `paused` | All three are `sent_to_provider`, rank 1. None is delivery. |
| **No idempotency mechanism is documented on `POST /messages`** | This is load-bearing. It is the whole reason a lost reply may not be retried. |
| `biz_opaque_callback_data` is a business-assigned string echoed back in the status webhook | It carries the clinic's `idempotency_key`, and it is the only thread back to a message whose reply was lost. |
| Status events are `sent`, `delivered`, `read`, `played`, `failed` | `read` and `played` are recorded as `delivered`: a message the patient opened was certainly delivered. |
| Meta retries a webhook until it gets a 200, for up to seven days | Duplicates are documented behaviour, so the webhook answers 200 to everything it has authenticated. |
| `X-Hub-Signature-256` is HMAC-SHA256 of the payload with the app secret | Verified over the raw request bytes, before parsing. |
| The documented error codes, and whether Meta's own recommended action is to wait or to change something | The retryable/terminal map in `whatsapp-cloud.ts`, each entry traceable to Meta's own wording. |

**Provisional, and marked as such in the code because no live provider has
ever answered it:** the send-side shape of a named body parameter
(`parameter_name`). Meta documents named parameters as `{{lower_snake_case}}`
at template creation, which is exactly the syntax the clinic's template bodies
already use and the schema's six-name whitelist already enforces. If provider
validation shows the clinic's templates were registered positionally, one
constant changes: `BODY_PARAMETER_FORMAT`.

Also provisional, and stated as having **no owner item** behind them:
`PROVIDER_TIMEOUT_MS` (30 seconds) and the stale-attempt age in
`recoverStaleAttempts` (15 minutes).

### 16.4 The worker, and what it re-asks under the lock

`runDispatchCycle` is recover, then prepare, then dispatch. It calls shared
domain code directly rather than making requests to other Edge Functions:
every hop is another place a reply can be lost, and a lost reply here is the
most expensive kind this application has.

A claim takes the message row with `for update ... skip locked` and re-asks,
under that lock, every bound that could have changed since the row was
selected: the schedule still being live, consent, the template's clinic AND
provider approval, the attempt ceiling, the two-hour retry window, the
usefulness deadline. Only then is the attempt row written — **before** the
provider is called — and the message moved to `outcome_unknown`.

Two concurrent workers therefore produce one attempt: one holds the row, the
other skips it. Running the cycle twice, late, or never is safe, and the
worker endpoint's own comment says exactly why for each.

**`outcome_unknown` is never retried by anything.** It is not in the
dispatchable set, and no elapsed time moves it out. Only provider evidence
settles it.

#### The defect this slice found and fixed

`dispatchQueuedMessages` selected candidates with `and useful_until > now`.
That filtered an expired message out of the candidate list, so `claimAttempt`
— which holds the only code that suppresses one with `past_useful_by` — was
never reached for exactly the rows that needed it. The message did not go out,
which was right. It also stayed at `queued` for ever, which was not: `queued`
is not one of the statuses the admin's failure queue reads, so a reminder that
quietly expired became invisible to everybody, and the clinic would never learn
that a patient had not been told.

The deadline is now asked once, under the row lock, where the answer can be
recorded. Selecting a row is not a decision to send it; every such decision
belongs under the lock, and this was the only one that had leaked out.

#### What a stale lease is, and what it is not

The claim is **not** a lease that expires and hands the work to somebody else.
That shape must not exist here: the second worker would send a second copy of a
message the first may well have delivered.

What goes stale is the *attempt* row. `in_flight` means a call is in progress,
and once the worker's process is gone that is no longer true of anything.
`recoverStaleAttempts` settles those rows as what they are — a call this clinic
never heard the end of — and touches the message not at all. The attempt stops
claiming to be running, the message stays `outcome_unknown`, and nothing is
retried.

`first_failed_at` **is** stamped on an ambiguous outcome, and that is a Slice
3B decision worth being explicit about. It does not declare the message failed;
the status still says nobody knows. It starts item 79's four-clinic-hour clock,
because `readCommunicationFailures` measures escalation from that column and a
null there would leave the row in the admin's queue for ever without ever
reaching the owner-doctor. An outcome nobody knows is the state most likely to
need a person to pick up a telephone, so it is the last one that should be
unable to escalate.

### 16.5 The webhook

```text
GET  /functions/v1/whatsapp   hub.mode + hub.verify_token + hub.challenge
POST /functions/v1/whatsapp   X-Hub-Signature-256 over the raw bytes
```

The order is fixed and is not an ordering anybody may tidy:

1. read the **raw bytes** of the body
2. HMAC-SHA256 them with the app secret, compare in constant time
3. only then parse

Reading the body as text and re-encoding it, or parsing the JSON and
re-serializing it to check the signature, verifies a document Meta did not
sign. It usually happens to be byte-identical, and stops being so at the first
non-ASCII character — a patient's name — or the first difference in key order
or whitespace. `verifyWebhookSignature` takes bytes for that reason.

A missing, malformed or wrong signature changes nothing: not a row, not a
counter, not an audit entry. The verify token is compared in constant time and
returns false when unset, so an unconfigured clinic cannot be subscribed to by
anybody.

**Deduplication is durable.** The event row is inserted *before* the evidence
is applied and in the same transaction, against a unique index on
`(provider_reference, status)`. Two webhooks carrying the same event race on
that index: one inserts and applies, the other is refused and rolls back having
changed nothing. There is no ordering in which both apply.

**Ordering cannot regress truth.** Evidence may only raise `delivery_rank`, and
`delivered` and `failed_terminal` are settled — nothing later moves them. A
`sent` arriving after `delivered` is recorded with effect `ignored`.

**Acceptance cannot masquerade as delivery.** `accepted`,
`held_for_quality_assessment` and `paused` are answers to the POST, are not
status words, and never travel through this path. Rank 1 is the strongest thing
a POST can ever produce.

**It discloses nothing.** An event naming a message this clinic never sent gets
the same 200 and the same body as one that moved something, and is recorded
with effect `unknown_reference`. Answering 404 would both turn a stranger's
probe into a week of Meta retries and confirm to anyone who can guess an
identifier whether this clinic has a message by that name.

It handles delivery statuses only. Inbound patient messages arrive on the same
webhook and are deliberately ignored: replying to a patient is a conversation
feature with its own consent, window and staffing questions, and owner item
82's rule that a patient-initiated conversation is not standing consent is
exactly the sort of thing that gets lost if an endpoint quietly starts
processing inbound text because it was already receiving it.

### 16.6 Authenticating something that is not a person

Until this slice, every Edge Function fell into two categories: eleven
authenticate a person through a session, and two are deliberately
unauthenticated. **There was no third category, and the dispatch worker is
one** — it is called by a scheduler whether or not anybody is in the building.

That contract gap is recorded at the top of `internal-auth.ts`. The smallest
thing that closes it is one shared secret, `CLINIC_WORKER_TOKEN`, compared in
constant time, with no fallback and no development default. It is deliberately
not a new table, a new role, a service-account staff row or a JWT: each is a
larger contract than the problem, and a staff row that cannot sign in but can
act is the kind of thing that ends up with a PIN.

**A staff session is not a key to this door.** The most privileged
administrator's bearer token is refused there exactly as an anonymous one is,
and a test walks all five roles against it. An unset secret refuses everybody,
including a correct caller — an unset secret must never mean "no check", which
is the failure mode `auth.ts` was already bitten by once.

### 16.7 Configuration, and none of its values

| Variable | Without it |
|---|---|
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | The adapter is fully disabled. Every due message is suppressed with `channel_not_configured`, and the webhook refuses every request including a correctly signed one. All four, or nothing — there is no partial mode. |
| `WHATSAPP_API_VERSION` | Defaults to `v23.0`. |
| `CLINIC_WORKER_TOKEN` | The worker endpoint refuses every request. |
| `CLINIC_PUBLIC_PAGE_URL` | Unchanged from Slice 3A: a template interpolating `{{link}}` is suppressed with `link_destination_unavailable`. |

**No value for any of these is created, committed or configured by this
slice.** They are read at call time rather than at module load, which is the
one behavioural change to `whatsapp.ts`: same variables, same answers, and a
configured path that can now be tested at all.

### 16.8 Compatibility

`send_order`, `send_patient_whatsapp`, `whatsapp_messages` and the whole staff
composer are unchanged, and are now characterized rather than only asserted:
the composer still reads `patients.whatsapp_consent`, the blanket registration
flag, and not the per-purpose consent table. It writes nothing into the outbox.
**There are not two sending paths writing to one set of records** — the two
share exactly `dialable`, so a number is normalized once rather than twice, and
that was already true in Slice 3A.

Moving the composer onto per-purpose consent stays deferred. It is a decision
about what the registration checkbox means, and owner item 78 says a
registration choice is valid only for the purposes it names.

Nothing joins the snapshot. No frontend workspace was added.

### 16.9 Still deferred after this slice

Everything in §15.8 except the adapter and the webhook, and specifically:

- **Scheduler provisioning.** No `pg_cron` job, no `pg_net` call, no Vault
  secret, no queue, and no deployment-specific URL or credential in any
  migration. The steps, prerequisites and rollback are in
  `docs/operations/ROLLOUT.md` §8 and are deliberately not run.
- **Real provider validation.** No approved Meta template, no credential, no
  message has ever been sent, and no line of the adapter has been answered by
  Meta. The named-parameter shape and both implementation constants above are
  provisional until it has.
- **The clinic privacy notice**, and the unresolved WABA question in
  `reference/WHATSAPP.md` §0 — narrowed by this slice's research but still a
  release gate.
- **The full recall-cohort release**, **the frontend messaging workspace**, the
  `send_patient_whatsapp` consent cutover, and the `ready_for_collection` and
  `service_interruption` schedule sources.

---

## 17. Backend programme Slice 4: the outpatient diagnostics loop

`20260926000000_slice4_diagnostics.sql`. **Six** new tables, one new sequence,
and one widened value list across four Slice 3A tables. No existing row is
rewritten, no existing column changes type or meaning, no command response
changes, and there is no backfill.

Owner policy items 84–88, approved 19 September 2026, closing backend decision
register entries D13 to D17.

**Nothing in this slice contacts a laboratory.** There is no analyzer feed, no
HL7, no results inbox and no external integration of any kind. A report
arrives because a member of staff typed it in or attached the file the
laboratory emailed, and that is the whole intake path.

### 17.1 The six tables

| Table | What one row is |
|---|---|
| `investigation_catalogue` | One version of one investigation or referral. Clinical content is fixed and doctor-approved; the operational half beside it is an administrator's to maintain. |
| `investigation_orders` | One request form, `REQ-000123`. `open` or `cancelled` is the only stored state. |
| `investigation_order_items` | One requested investigation or referral, with the four facts the form printed copied onto it. |
| `investigation_results` | One report as it arrived, with two flag pairs, external validation kept separate from clinic review, and the correction relationship. |
| `result_documents` | One stored file: identity, media type, size, checksum, provenance, uploader, supersession. **No URL column.** |
| `result_reviews` | One doctor's clinical review. `unique (result_id)`. |

### 17.2 The rule the whole slice is built on

**A clinical judgment has a clinician's name on it, or it does not exist.**

Four different mistakes are the same mistake — a fact with no author — and
each of the five owner items refuses one:

| The fact | Where it may come from | What cannot produce it |
|---|---|---|
| a flag | the report, an identified feed, or a doctor | free text, a reference range, OCR, a diagnosis, a model, an application threshold |
| a review | a doctor with standing on the order | the laboratory's technical validation, however signed |
| a release | that review **plus** a separate authorization | a review on its own, or elapsed time |
| a delivery | authenticated provider evidence, or an audited telephone call | an authorization, a queue entry, an HTTP 200, Meta accepting the message |

The four things a clock is allowed to do here are: make a request overdue,
make an unreviewed result escalate, make a message due, and make one stop
being worth sending. It never reviews, never flags, never authorizes and
never releases.

### 17.3 Where a flag comes from, in two column pairs

Owner item 85 allows three origins, and the first two are transcription while
the third is a clinical act. So `investigation_results` carries **two flags**:

- `source_flag` / `source_flag_origin` / `source_flag_reference` — what the
  report itself said, or what an identified structured feed carried. A nurse
  or an administrator may write this down; item 86 lets them transcribe, and
  the provenance reference is required by a check constraint, because a
  transcribed flag with nothing to trace it to is somebody's opinion.
- `doctor_flag` / `doctor_flag_by` / `doctor_flag_at` / `doctor_flag_reason` —
  an authorized doctor's own judgment, with a reason.

Each pair is write-once, held by `protect_investigation_result`. Two columns
rather than one because the alternative is a doctor raising a laboratory's
`abnormal` to `critical` by overwriting it, after which nobody can say what
the laboratory reported — a clinical record where the doctor's judgment has
erased the source's is a record that cannot be defended.

`effective_flag` is a **stored generated column** taking the more severe of
the two. It is generated rather than computed in code deliberately: taking the
maximum of two recorded flags is the only operation on a flag that exists
anywhere in this application, and putting it in the schema means it can be
read rather than searched for. There is no branch that reads a number, a range
or a word and decides something is abnormal.

"Authorized" in item 85 is read as **authorized for this result** — the
responsible doctor, the ordering doctor, or one explicitly delegated. Item 85
names the authority without defining it; item 86 defines exactly that set for
the neighbouring act, and borrowing the definition from the item next door is
more defensible than inventing a fourth.

### 17.4 The wrong patient, made unstorable

Every table below the order carries `patient_id` although its parent already
has one, and that redundancy is the point. Composite foreign keys chain the
whole way down:

```text
investigation_orders      unique (id, patient_id)
  └─ encounter_id, patient_id  ──▶ encounters (id, patient_id)
investigation_order_items unique (id, patient_id)
  └─ order_id, patient_id      ──▶ investigation_orders (id, patient_id)
investigation_results     unique (id, patient_id)
  ├─ order_item_id, patient_id ──▶ investigation_order_items (id, patient_id)
  └─ supersedes_result_id, patient_id ──▶ investigation_results (id, patient_id)
result_documents
  └─ result_id, patient_id     ──▶ investigation_results (id, patient_id)
result_reviews
  └─ result_id, patient_id     ──▶ investigation_results (id, patient_id)
```

Checking it in the command is necessary and is not sufficient. There is no
arrangement of identifiers, however they arrive, that files one patient's
report against another patient's request — and the upload endpoint does not
accept a caller-supplied patient id at all: it reads the one on the result.

This is the same device `20260921000000` added for consultation-attempt
reconciliation, and it reuses that migration's `encounters_id_patient` index
rather than creating a second.

### 17.5 A correction appends, and cannot inherit anything

A corrected report is a **new row** that supersedes the old one. The old row
keeps its text, its flag, its documents and its review; it stops being
current.

`investigation_results_current`, a partial unique index on `(order_item_id)
where superseded_at is null`, is what makes "current" a fact rather than a
convention. It also forces the order of a correction — stamp the old one
superseded, then insert the new — which is why `superseded_at` is required and
`superseded_by_result_id` is filled a line later. The same ordering problem
`communication_schedules.superseded_by` has, for the same reason.

The consequence worth stating: **because a review belongs to a result id and a
correction is a new result id, a correction cannot inherit a review.** That is
not a rule the code remembers to apply; it is the shape of the tables. The
same is true of a notification authorization, which lives on the result row
and starts null on the new one.

`investigation_results_one_correction`, a partial unique index on
`supersedes_result_id`, means one report is corrected by at most one
successor, so two concurrent corrections meet an index rather than each other.

### 17.6 Review, and what an external signature is not

`result_reviews` has `unique (result_id)`, and that index does three jobs:

1. Two doctors pressing Review at the same moment produce one review; the
   loser is told who got there first rather than the record acquiring two
   opinions with no order between them.
2. A corrected report has no review, per §17.5.
3. A review cannot be edited into a different review — the trigger refuses an
   update and the index refuses a second row.

`basis` records **which** authority the reviewer held —
`responsible_doctor`, `ordering_doctor` or `delegated_doctor` — because who
was responsible for a patient in September is not a question a query in March
should be answering.

The owner-doctor is deliberately **not** a fourth basis. Item 86 names three,
and an owner-doctor who needs to take a stranded result over does it by
delegating — to themselves if that is what is happening — which leaves an
explicit, audited delegation rather than an implicit standing nothing records.
Item 87's escalation is what makes that workable: a result nobody has reviewed
reaches the owner-doctor's queue, and `delegate_result_review` is open to them
so the queue has an action behind it.

The laboratory's own technical validation lives in `external_validated_by`,
`external_validated_at` and `external_signatory_reference` — different names,
a different table from the review, and **no staff foreign key**, because the
person who signed the report does not work here. Item 86: it is retained as
evidence and it is not the clinic's clinical review.

### 17.7 Item 87's clock, and the boundary the clinic has not set

| Rule | Value | Source |
|---|---|---|
| Critical result alerts responsible + owner doctor | immediately | owner item 87 |
| Critical acknowledgement owed after | 15 minutes | owner item 87 |
| Unreviewed result escalates after | 4 clinic hours | owner item 87 |
| …or at clinic closing, whichever is earlier | **20:00 clinic-local** | **a technical ceiling, not the clinic's closing time** |

"Four clinic hours" is read exactly as Slice 3A reads the identical phrase in
item 79: four elapsed hours, moved forward to the next dispatch opening if
they would land when nobody is there. One interpretation used twice rather
than two that happen to agree today.

The second boundary is the honest gap. **This application holds no configured
clinic closing time.** `clinic_settings` has no such column, and
`provider_availability` is one doctor's optional published consulting windows
rather than the clinic's day — a clinic that has published none would have no
closing time at all. So `RESULT_ESCALATION_CEILING_HOUR` takes owner item 77's
20:00 messaging dispatch cutoff as a conservative ceiling, under its own
constant rather than a second reference to `DISPATCH_WINDOW_END_HOUR`, because
the two mean different things and will stop being equal the day the owner
supplies a closing time.

What it costs while it stands: a clinic that shuts at 18:00 has unreviewed
results reaching the owner-doctor at 20:00 rather than at closing — later than
item 87 intends, never later than the messaging day, and usually irrelevant
because the four-hour half fires first. Owner policy item 87 records the
interpretation and the one value that replaces it.

**There is no explicitly configured backup doctor.** Item 87 names "any
explicitly configured backup doctor"; the clinic has configured none and this
application has nowhere to hold one. `readResultEscalations` returns
`backupDoctorConfigured: false` as a field rather than letting a screen imply
one exists.

### 17.8 The fifth messaging purpose, and why it is not the fourth

Owner item 88 authorizes one automated patient-facing message and fixes its
entire wording:

> Your investigation result has been reviewed and is ready. Please contact the
> clinic.

Slice 3A's comment on its purpose list read: "A fifth purpose is a policy
decision and not a column value somebody may add in passing." Item 88 is that
decision. `result_ready` is added to the purpose check on `message_templates`,
`communication_consents`, `communication_schedules` and `message_outbox`;
`result_ready` to the schedule kinds; `investigation_result` to the source
types.

It is **not** `ready_for_collection`. That one is the pharmacy telling
somebody their medicine is on the counter, and a patient who agreed to be told
that has not agreed to be told that a test result exists. Owner item 78's
whole architecture is that consent is per purpose; folding the two together
would silently enrol everybody who ticked the pharmacy box.

Two suppression reasons are added — `result_superseded` and
`result_not_authorized` — and they are the honest half of item 88. A queued
notice can stop being true between the authorization and the send.
`resultNoticeStillStands` asks, under the row lock, in **both**
`prepareOne` and `claimAttempt`: is the result still current, is the request
still open, is there still a review, is there still an authorization, has it
since been flagged critical. Everything else — consent, opt-out, template
approval, usefulness, the schedule's own cancellation — is Slice 3A's generic
recheck and is unchanged.

There is no second outbox, no direct provider call and no result-shaped
exception to any of Slice 3A's rules. `messaging.ts` reaches the diagnostics
tables with plain SQL, exactly as it already reaches `appointment_bookings`
and `follow_ups`, and imports nothing from `diagnostics.ts`; the command chain
therefore runs `… → images.ts → diagnostics.ts → messaging.ts`, with
diagnostics in front so the two never import each other.

A critical result **cannot hold an authorization at all**: a check constraint
on `investigation_results` refuses one, and the command refuses it with
`CRITICAL_RESULT_NEEDS_DIRECT_CONTACT`. Item 88's clinician-led contact is not
reachable by any ordering of events.

### 17.9 The states, and what derives each one

Only the order's `open`/`cancelled` is stored. Everything a screen wants to
say about a line is derived, in `deriveItemState`, in precedence order — the
first thing that is true is the answer:

| State | What makes it true |
|---|---|
| `cancelled` | the line or its order was cancelled, with actor, time and reason |
| `manually_contacted` | somebody recorded a telephone call or a conversation |
| `notified` | `message_outbox.status = 'delivered'`, which only an authenticated provider status event produces |
| `provider_outcome_unknown` | the provider's reply was lost |
| `notification_pending` | authorized, and anything short of delivered — queued, accepted, suppressed, failed |
| `closed` | reviewed as no action needed, or action taken |
| `reviewed` | reviewed as patient to be informed, and not yet released |
| `awaiting_review` | a current result exists and nobody has read it |
| `overdue` | past the expected-by date the ordering doctor set, nothing back |
| `in_progress` | the specimen went, or the patient was sent |
| `ordered` | none of the above |

`notified` requires provider evidence and nothing weaker. An authorization, a
queued message, `sent_to_provider` and an HTTP 200 are each two or more steps
short of it, and each has its own name in this list so a screen cannot round
them up.

### 17.10 Who may see what

Owner item 86 has three tiers and one absolute, and they are applied per
patient and per field by `mayAccessResults` rather than by a role list:

| | |
|---|---|
| **doctor** | everything |
| **nurse** | everything, while involved in that patient's care. `nurse_care_involvement` — the clinic's existing answer to that question for photographs, derived from work the nurse actually did — decides which patients |
| **admin** | that the request exists, what was asked for, when it came back, how long it has waited and who owes it a review. Not the report, not the flag, not the review note |
| **pharmacy** | nothing, refused at the top of the `results` endpoint and absent from every capability |

The three patient-shaped reads and the `results` endpoint each report which of
the two access levels they gave, so a screen never implies more than it has.
`view.result_escalations` does not: it is doctor-only, so the answer is always
clinical.

**The derived state of a line is not gated**, and that is deliberate. It is a
fact about the clinic rather than about the reader, so it is computed from
ungated facts and only then is the payload minimized — the first version
derived it from the already-minimized view and reported `reviewed` to an
administrator where a doctor saw `closed`. Whether a line still owes somebody
work is exactly what item 86 lets an administrator see.

One asymmetry is deliberate: an administrator **may attach** a report and
**may not open** one. Item 86 says both halves, and they are not in tension —
filing a PDF already in your hand is not the same capability as being able to
open anybody's.

### 17.11 Documents, and the consent semantics that are not borrowed

`result_documents` uses the same private object store, the same
sixty-second single-purpose HMAC ticket and the same checksum-on-the-way-out
as clinical photographs, through a second storage **area**: two buckets in the
clinic (`CLINIC_DOCUMENT_BUCKET`, default `result-documents`), two directories
in staging (`CLINIC_DOCUMENT_ROOT`). Both default to the image behaviour when
unset, so every caller written before this slice means what it meant.

What it does **not** reuse is `image_consents`. A photograph is something this
clinic does to a patient, under a consent recorded before the shutter; a
laboratory report is a document the clinic receives, with no shutter and no
moment to consent to. Asking a front-desk clerk to record a photography
consent before filing a PDF would teach everybody that the consent screen is a
formality.

**There is no URL column** — not public, not signed, not expiring — and a test
walks `information_schema.columns` across all six tables asserting that no
column is named like one. Duplicate uploads are answered twice over: by the
idempotency reference, and by `unique (result_id, checksum)`, because the same
bytes filed twice against one report is somebody pressing Attach again rather
than a second document. A row refused after the bytes were written removes the
orphan object.

### 17.12 Idempotency

`order_investigation`, `record_result` and the document upload each require an
`idempotencyKey` and store it beside a `request_fingerprint` of the material
request, with a unique index. Same key and the same request returns the
original outcome; same key and a materially different request is refused
rather than answered with somebody else's record.

The receipt is located **before** any mutable prerequisite is consulted. An
exact retry that lands after the patient has been discharged, after a
catalogue entry has been retired, or after the request has been cancelled
still gets its answer — and the order replay says `cancelled: true` beside it,
so it is accurate about the past without being silent about the present. This
is the fault Slice 2's third acceptance review reproduced twice, and the rule
is inherited rather than rediscovered.

The remaining consequential commands are idempotent by construction rather
than by key: `review_result` through `unique (result_id)`, and
`flag_result`, `acknowledge_critical_result`, `authorize_result_notification`
and `record_patient_result_contact` through write-once columns the trigger
protects. A second press returns the original outcome; a second press by a
different person is refused and names who got there first.

There is no receipts table. `appointment_command_receipts` and its `once()`
are Slice 2's, and generalizing them would mean editing accepted Slice 2 code;
duplicating them would be a second mechanism. Every consequential command here
has exactly one durable effect row, so that row carries the key — which is
Slice 3A's pattern on `communication_schedules`, not a new one.

### 17.13 Compatibility

Nothing existing changed behaviour. The four Slice 3A purposes still behave
exactly as they did and a test asserts it; the staff WhatsApp composer still
reads `patients.whatsapp_consent` and still writes nothing to the outbox;
`send_order`, `send_patient_whatsapp`, the appointment book, consultation
signing, dispensing and the counter are untouched.

Nothing joins the snapshot. There are now **sixteen** Edge Functions; the new
one is `results`, and it is the third that is not a general-purpose staff
endpoint — it moves bytes and nothing else.

### 17.14 Deferred, explicitly

None of these is unfinished Slice 4 work. Each is named rather than implied.

- **The frontend.** No screen renders any of this. The contract is
  [`reference/SLICE4_FRONTEND_CONTRACT.md`](reference/SLICE4_FRONTEND_CONTRACT.md).
- **A clinic closing time** (§17.7) and **a configured backup doctor**, both
  owner values, both recorded rather than invented.
- **Professional registration.** Item 84 requires a registered doctor. What
  this application can prove is the doctor role plus the explicit
  authorization flag; whether that person holds a current medical registration
  is an onboarding and governance obligation the clinic owns, and nothing here
  claims otherwise.
- **Structured laboratory values.** No analyte, value, unit or reference
  range, because no approved bounded catalogue exists and inventing one
  invites the one line of code owner item 85 forbids.
- **Any external integration**: no analyzer feed, no laboratory portal, no
  HL7, no results inbox. `imported_structured_feed` is a provenance value a
  human records, not a connection.
- **Sending a result notice.** The channel is unconfigured, exactly as in
  §16.9: every authorized notice is suppressed into the admin's queue with
  `channel_not_configured`, and every release gate in owner section M's
  closing paragraph still stands — plus this purpose's own approved Meta
  template, which does not exist either.
- **Backfill.** Nothing historical was converted. There is no investigation in
  this clinic's past to migrate, and turning clinical images into results
  would invent evidence.

## 18. Supplier orders from the pharmacist's own WhatsApp

Owner policy register item 89, 26 October 2026. No migration: every column used
here already existed.

### 18.1 Commands

| Command | Roles | What it does |
|---|---|---|
| `create_order` | admin, pharmacy | Takes `pg_advisory_xact_lock(517301)` so two drafts cannot see the same shortfall. A medicine is drafted when shelf (`batch_availability`, pickable) **plus on order** (outstanding on `pending`, `placed` and `partially_delivered` orders) is at or below `reorder_level`; the quantity tops it up to `target_stock`. A computed quantity is rounded **up** to whole packs of the newest verified package's smallest receivable level above the base unit. Typed `lines` are kept exactly. Now writes `order_level_name`, `order_level_count` and `package_version_id`, which Slice 3 added and nothing had filled. |
| `mark_order_sent` | admin, pharmacy | `pending` → `placed`, under `select … for update`. Saves the message as sent. A second call is refused and names who marked it. Never contacts Meta: `external_message_id` and `message_status` stay null and nothing is written to `whatsapp_messages`. Audit action `order.marked_sent`. |
| `cancel_order` | admin, pharmacy | `pending` → `cancelled`, so a wrong draft stops counting as on order. Audit action `order.discarded`. |
| `send_order` | — | **Removed.** It sent a free-form message through the business API, which Meta delivers only inside a customer-opened 24-hour window. It placed the order before any delivery evidence existed, and it called Meta before writing any row. |

### 18.2 Read model

`OrderLineView` gains `baseUnit` and `orderedDescription` ("1 box and 4 strips
(140 tablets)"). Both come from the package frozen on the line, not from
whichever package is current. `PurchaseOrderView` gains `supplierWhatsApp`, the
digits `wa.me` dials, and `supplierWhatsAppProblem`. The page builds the link
in `lib/supplier-orders.ts`, which also holds the screen's copy of the
needs-an-order rule for the Orders list and the Counter's reminder. The pack
arithmetic is in `_shared/supplier-order.ts`, shared by the command and the
snapshot.

### 18.3 Tests

`tests/supplier-orders.test.ts` (13, no database),
`tests/characterization/supplier-orders.test.mjs` (13, including two races)
and `tests/browser/supplier-orders.test.mjs` (2 journeys).
`unprotected-write-paths`, `slice3-gate` and `slice3a-whatsapp-compatibility`
were updated where they pinned the old behaviour.
