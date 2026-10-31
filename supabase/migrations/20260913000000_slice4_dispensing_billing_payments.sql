-- Slice 4: handing medicine over, and taking money for it.
--
-- Three things in this schema were shaped by never having had to do the real
-- job, and all three are replaced here.
--
--   1. A PRESCRIPTION WAS DISPENSED OR IT WAS NOT. `prescriptions.dispensed_at`
--      is a single timestamp, so "ten tablets prescribed, six handed over, four
--      to collect on Friday" has nowhere to live. The counter's only options
--      were all of it or none of it.
--
--   2. A BILL WAS UNPAID OR PAID. One row carried the amount, the status and
--      the payment method, so a part payment had to be represented by editing
--      the amount — which destroys the thing it is a part of. A waiver, a
--      refund and a reversal all had the same shape: overwrite and forget.
--
--   3. MEDICINE WAS NEVER CHARGED FOR AT ALL. `dispense_rx` moved stock and
--      created no bill line. The only bill the application could produce was
--      the consultation fee, and that fee came from a literal 300 in the
--      doctor's browser form rather than from the clinic's settings.
--
-- What replaces them:
--
--   dispense -> lines -> batch allocations        append-only, per line
--   invoice  -> lines                             immutable amounts
--   payment  -> allocations                       separate records, both ways
--
-- Every state a screen shows — Waiting, Partly supplied, Unpaid, Part paid,
-- Paid, Due — is DERIVED from those events by a view. There is no status column
-- anybody can set to something the events do not support.
--
-- Every object is schema-qualified.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. HOW LONG A PRESCRIPTION MAY BE SUPPLIED AGAINST
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Policy register 18: the signed prescription carries an explicit `valid until`
-- and a `may be supplied in parts` direction. The clinic default is 7 calendar
-- days from signing; the doctor may shorten or extend it for one prescription.
-- After expiry the pharmacy cannot supply the remainder without a new order.
--
-- Existing prescriptions are backfilled to signing + 7 days, which is the
-- clinic's own default rather than an invention: it is the rule that would have
-- applied had the field existed, and every one of them is long past it, so the
-- effect on the shelf is nil. The alternative — leaving them open for ever —
-- would be a decision nobody made.

alter table jmc.prescriptions
  add column if not exists valid_until date,
  add column if not exists supply_in_parts boolean not null default true,
  add column if not exists validity_set_by text references jmc.staff(id),
  add column if not exists validity_reason text not null default '';

update jmc.prescriptions
   set valid_until = (signed_at::timestamptz at time zone 'Asia/Kolkata')::date + 7
 where valid_until is null;

/*
 * A prescription written without one gets the clinic default.
 *
 * Not a column DEFAULT, which cannot see another column and would therefore
 * date every backfilled row from the day the migration ran rather than from
 * the day it was signed. A trigger can, so a row inserted with a 2024
 * signature gets a 2024 validity and reads as the expired prescription it is.
 */
create or replace function jmc.default_prescription_validity()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  if new.valid_until is null then
    new.valid_until := (new.signed_at::timestamptz at time zone 'Asia/Kolkata')::date + 7;
  end if;
  return new;
end;
$$;

drop trigger if exists prescriptions_default_validity on jmc.prescriptions;
create trigger prescriptions_default_validity
before insert on jmc.prescriptions
for each row execute function jmc.default_prescription_validity();

alter table jmc.prescriptions alter column valid_until set not null;

create index if not exists prescriptions_validity_idx on jmc.prescriptions (valid_until);
create index if not exists prescriptions_validity_set_by_idx on jmc.prescriptions (validity_set_by);


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. THE TWO WAYS A LINE STOPS BEING SUPPLIED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Policy register 20 keeps them apart, and they are genuinely different facts
-- about different people:
--
--   PATIENT DECLINED   the patient chose not to take it. Recorded at the
--                      counter, by the pharmacist who was told.
--   DOCTOR CANCELLED   the doctor withdrew the order. Recorded by the doctor.
--
-- Collapsing them loses the only thing either is for. A patient who declines
-- an antibiotic is a clinical fact the doctor should see at the next visit; a
-- doctor who withdraws one is an instruction to the pharmacy. "Not supplied"
-- is neither.
--
-- Separate from `prescription_line_resolutions`, which Slice 2.1.1 restricted
-- to lines signed unreadable. This is for ordinary signed lines, which are the
-- overwhelming majority and which a resolution may not touch.

create table if not exists jmc.prescription_line_outcomes (
  id text primary key,
  prescription_line_id text not null references jmc.prescription_lines(id),
  outcome text not null check (outcome in ('patient_declined', 'doctor_cancelled')),
  reason text not null check (length(trim(reason)) > 0),
  recorded_by text not null references jmc.staff(id),
  recorded_at timestamptz not null default now()
);

create index if not exists prescription_line_outcomes_line_idx
  on jmc.prescription_line_outcomes (prescription_line_id, recorded_at desc);
create index if not exists prescription_line_outcomes_actor_idx
  on jmc.prescription_line_outcomes (recorded_by);

-- One outcome per line. A line cannot be both declined and cancelled, and
-- recording the same outcome twice is a retry rather than a second fact.
create unique index if not exists prescription_line_outcomes_once
  on jmc.prescription_line_outcomes (prescription_line_id);

drop trigger if exists prescription_line_outcomes_immutable on jmc.prescription_line_outcomes;
create trigger prescription_line_outcomes_immutable
before update or delete on jmc.prescription_line_outcomes
for each row execute function jmc.reject_signed_line_change();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. DISPENSING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Three levels, all append-only. A dispense is an event that happened; it is
-- never edited, and a mistake is corrected by a compensating event that stays
-- on the record beside it.

create sequence if not exists jmc.dispense_seq;
create sequence if not exists jmc.invoice_seq;
create sequence if not exists jmc.receipt_seq;

create table if not exists jmc.dispenses (
  id text primary key,
  dispense_number text not null unique,
  prescription_id text not null references jmc.prescriptions(id),
  patient_id text not null references jmc.patients(id),
  /*
   * The counter supplies this, and it is what makes a second tap safe.
   *
   * `dispense_rx` already locked the prescription row, which stopped two
   * counters dispensing the whole thing twice. Partial supply removes that
   * protection: two taps five seconds apart are now two perfectly legitimate
   * partial dispenses of four tablets each, and only the key can tell that
   * apart from one tap the network repeated.
   */
  idempotency_key text not null unique,
  status text not null check (status in ('completed', 'reversed')),
  note text not null default '',
  dispensed_by text not null references jmc.staff(id),
  dispensed_at timestamptz not null default now(),
  reversed_by text references jmc.staff(id),
  reversed_at timestamptz,
  reversal_reason text not null default '',
  constraint dispenses_reversed_completely
    check ((status = 'reversed') = (reversed_by is not null and reversed_at is not null))
);

create index if not exists dispenses_prescription_idx on jmc.dispenses (prescription_id, dispensed_at);
create index if not exists dispenses_patient_idx on jmc.dispenses (patient_id, dispensed_at desc);
create index if not exists dispenses_by_idx on jmc.dispenses (dispensed_by);
create index if not exists dispenses_reversed_by_idx on jmc.dispenses (reversed_by);

create table if not exists jmc.dispense_lines (
  id text primary key,
  dispense_id text not null references jmc.dispenses(id),
  prescription_line_id text not null references jmc.prescription_lines(id),
  medicine_id text not null references jmc.medicines(id),
  quantity integer not null check (quantity > 0),
  /*
   * A substitution, when policy register 21 allows one: a genuinely generic
   * prescription, and an in-stock brand whose ingredient(s), strength, form,
   * route and release characteristics match the signed clinical drug exactly.
   * The clinical drug that was signed is recorded here so the substitution is
   * visible rather than inferable, and the brand actually handed over is
   * `medicine_id`.
   */
  substituted_for_clinical_drug_id text references jmc.clinical_drugs(id),
  substitution_reason text not null default '',
  unique (dispense_id, prescription_line_id),
  constraint dispense_lines_substitution_explained
    check (substituted_for_clinical_drug_id is null or length(trim(substitution_reason)) > 0)
);

create index if not exists dispense_lines_dispense_idx on jmc.dispense_lines (dispense_id);
create index if not exists dispense_lines_line_idx on jmc.dispense_lines (prescription_line_id);
create index if not exists dispense_lines_medicine_idx on jmc.dispense_lines (medicine_id);
create index if not exists dispense_lines_substituted_idx
  on jmc.dispense_lines (substituted_for_clinical_drug_id)
  where substituted_for_clinical_drug_id is not null;

create table if not exists jmc.dispense_allocations (
  id text primary key,
  dispense_line_id text not null references jmc.dispense_lines(id),
  batch_id text not null references jmc.batches(id),
  quantity integer not null check (quantity > 0),
  -- Per base unit, snapshotted. The batch's price can be corrected afterwards
  -- without rewriting what this patient was charged.
  unit_amount numeric(12,2) not null check (unit_amount >= 0),
  stock_movement_id text not null references jmc.stock_movements(id),
  unique (dispense_line_id, batch_id)
);

create index if not exists dispense_allocations_line_idx on jmc.dispense_allocations (dispense_line_id);
create index if not exists dispense_allocations_batch_idx on jmc.dispense_allocations (batch_id);
create index if not exists dispense_allocations_movement_idx
  on jmc.dispense_allocations (stock_movement_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. OTC, AS LINES RATHER THAN AS A JSON BLOB
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `otc_sales.lines_json` held everything: the medicines, the quantities, the
-- batch allocations and the prices, as text. Nothing could query it, no foreign
-- key protected it, and a returned item had nowhere to point.

alter table jmc.otc_sales
  add column if not exists patient_id text references jmc.patients(id),
  add column if not exists invoice_id text,
  add column if not exists status text not null default 'completed'
    check (status in ('completed', 'voided')),
  add column if not exists idempotency_key text,
  add column if not exists void_reason text not null default '',
  add column if not exists voided_by text references jmc.staff(id),
  add column if not exists voided_at timestamptz;

-- Payment moved off the sale and onto a payment record, so this stops being
-- required. The existing values stay as history of how the old sales were paid.
alter table jmc.otc_sales alter column payment_method drop not null;

create unique index if not exists otc_sales_idempotency
  on jmc.otc_sales (idempotency_key) where idempotency_key is not null;
create index if not exists otc_sales_patient_idx on jmc.otc_sales (patient_id);
create index if not exists otc_sales_voided_by_idx on jmc.otc_sales (voided_by);
create index if not exists otc_sales_created_by_idx on jmc.otc_sales (created_by);

create table if not exists jmc.otc_lines (
  id text primary key,
  otc_sale_id text not null references jmc.otc_sales(id),
  line_number integer not null check (line_number > 0),
  medicine_id text not null references jmc.medicines(id),
  -- What the counter chose, kept beside what the ledger moved.
  package_level_name text not null default '',
  package_count integer check (package_count is null or package_count > 0),
  quantity integer not null check (quantity > 0),
  unit_amount numeric(12,2) not null check (unit_amount >= 0),
  amount numeric(12,2) not null check (amount >= 0),
  unique (otc_sale_id, line_number)
);

create index if not exists otc_lines_sale_idx on jmc.otc_lines (otc_sale_id);
create index if not exists otc_lines_medicine_idx on jmc.otc_lines (medicine_id);

create table if not exists jmc.otc_allocations (
  id text primary key,
  otc_line_id text not null references jmc.otc_lines(id),
  batch_id text not null references jmc.batches(id),
  quantity integer not null check (quantity > 0),
  unit_amount numeric(12,2) not null check (unit_amount >= 0),
  /*
   * Null only for a sale carried across from `lines_json`, where the ledger
   * row cannot be matched with certainty. Every allocation this application
   * writes has one, and the command layer requires it.
   */
  stock_movement_id text references jmc.stock_movements(id),
  unique (otc_line_id, batch_id)
);

create index if not exists otc_allocations_line_idx on jmc.otc_allocations (otc_line_id);
create index if not exists otc_allocations_batch_idx on jmc.otc_allocations (batch_id);
create index if not exists otc_allocations_movement_idx on jmc.otc_allocations (stock_movement_id);

-- Returned medicine goes to quarantine and never back on the shelf by itself.
-- Policy register 47.
create table if not exists jmc.otc_returns (
  id text primary key,
  otc_sale_id text not null references jmc.otc_sales(id),
  otc_line_id text not null references jmc.otc_lines(id),
  quantity integer not null check (quantity > 0),
  reason text not null check (length(trim(reason)) > 0),
  refund_amount numeric(12,2) not null check (refund_amount >= 0),
  authorized_by text not null references jmc.staff(id),
  created_at timestamptz not null default now()
);

create index if not exists otc_returns_sale_idx on jmc.otc_returns (otc_sale_id);
create index if not exists otc_returns_line_idx on jmc.otc_returns (otc_line_id);
create index if not exists otc_returns_actor_idx on jmc.otc_returns (authorized_by);


/*
 * The counter sales already in the clinic, out of their JSON and into rows.
 *
 * `lines_json` is an array of `{medicineId, name, quantity, lineTotal,
 * allocations: [{batchId, batchNumber, quantity, unitPrice}]}` — the shape
 * `otc_sale` wrote. Every field needed is in there; what was missing was
 * anywhere for a query, a foreign key or a return to point.
 *
 * Ids are derived from the sale id and the ordinal so this is idempotent, and
 * so a line keeps a visible link to the sale it came out of. A medicine or
 * batch that no longer exists is skipped rather than invented — Slice 2.1 is
 * the precedent, and a line pointing at a medicine row that is gone is worse
 * than a line that says the history could not be read.
 */
insert into jmc.otc_lines
  (id, otc_sale_id, line_number, medicine_id, quantity, unit_amount, amount)
select
  'otcl-' || s.id || ':' || item.ordinality::text,
  s.id,
  item.ordinality::integer,
  m.id,
  greatest((item.value->>'quantity')::integer, 1),
  case when (item.value->>'quantity')::numeric > 0
       then round((item.value->>'lineTotal')::numeric / (item.value->>'quantity')::numeric, 2)
       else 0 end,
  round(coalesce((item.value->>'lineTotal')::numeric, 0), 2)
from jmc.otc_sales s
cross join lateral jsonb_array_elements(s.lines_json::jsonb) with ordinality item(value, ordinality)
join jmc.medicines m on m.id = item.value->>'medicineId'
where (item.value->>'quantity') ~ '^[0-9]+$'
  and (item.value->>'quantity')::integer > 0
on conflict (id) do nothing;

insert into jmc.otc_allocations
  (id, otc_line_id, batch_id, quantity, unit_amount, stock_movement_id)
select distinct on (line.id, b.id)
  'otca-' || line.id || ':' || b.id,
  line.id,
  b.id,
  greatest((alloc.value->>'quantity')::integer, 1),
  round(coalesce((alloc.value->>'unitPrice')::numeric, 0), 2),
  -- Matched to the ledger row the sale wrote, where one can be found.
  (select v.id from jmc.stock_movements v
    where v.batch_id = b.id and v.reference_type = 'otc_sale' and v.reference_id = s.id
      and v.quantity_delta = -greatest((alloc.value->>'quantity')::integer, 1)
    order by v.created_at limit 1)
from jmc.otc_sales s
cross join lateral jsonb_array_elements(s.lines_json::jsonb) with ordinality item(value, ordinality)
join jmc.otc_lines line on line.id = 'otcl-' || s.id || ':' || item.ordinality::text
cross join lateral jsonb_array_elements(coalesce(item.value->'allocations', '[]'::jsonb)) alloc(value)
join jmc.batches b on b.id = alloc.value->>'batchId'
where (alloc.value->>'quantity') ~ '^[0-9]+$'
  and (alloc.value->>'quantity')::integer > 0
on conflict (id) do nothing;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. INVOICES AND PAYMENTS
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists jmc.invoices (
  id text primary key,
  invoice_number text not null unique,
  -- Null for an anonymous over-the-counter sale, which policy register 45 and
  -- 46 allow only when it is paid in full at the time.
  patient_id text references jmc.patients(id),
  encounter_id text references jmc.encounters(id),
  status text not null check (status in ('open', 'void')),
  void_reason text not null default '',
  voided_by text references jmc.staff(id),
  voided_at timestamptz,
  created_by text not null references jmc.staff(id),
  created_at timestamptz not null default now(),
  constraint invoices_voided_completely
    check ((status = 'void') = (voided_by is not null and voided_at is not null))
);

create index if not exists invoices_patient_idx on jmc.invoices (patient_id, created_at desc);
create index if not exists invoices_encounter_idx on jmc.invoices (encounter_id);
create index if not exists invoices_created_by_idx on jmc.invoices (created_by);
create index if not exists invoices_voided_by_idx on jmc.invoices (voided_by);
create index if not exists invoices_open_idx on jmc.invoices (created_at desc) where status = 'open';

create table if not exists jmc.invoice_lines (
  id text primary key,
  invoice_id text not null references jmc.invoices(id),
  line_number integer not null check (line_number > 0),
  source text not null check (source in ('consultation_fee', 'prescription', 'otc', 'adjustment')),

  -- What authorized this line. Exactly one of these is set for the first three
  -- sources, and the check below says so rather than leaving it to habit.
  encounter_id text references jmc.encounters(id),
  dispense_line_id text references jmc.dispense_lines(id),
  otc_line_id text references jmc.otc_lines(id),
  medicine_id text references jmc.medicines(id),

  description text not null check (length(trim(description)) > 0),
  quantity integer not null check (quantity > 0),
  /*
   * Only an `adjustment` line may be negative, and that exception is the whole
   * mechanism by which a bill comes down.
   *
   * A charge that should not have been made is answered by adding a credit
   * line, never by editing the line that made it: the original stays on the
   * bill exactly as it was printed, and the total falls because something was
   * added rather than because something was changed. The brief's §7 asks for
   * immutable bill lines plus compensating events; this is the compensating
   * event.
   */
  unit_amount numeric(12,2) not null,
  amount numeric(12,2) not null,
  constraint invoice_lines_charges_are_positive
    check (source = 'adjustment' or (amount >= 0 and unit_amount >= 0)),

  /*
   * The key that makes "at most one consultation-fee line per encounter" a
   * property of the database rather than a promise.
   *
   * 'consultation:<encounter id>' for a fee, 'dispense:<line id>' for medicine
   * handed over, 'otc:<line id>' for a counter sale. The unique index below is
   * clinic-wide, so a retry cannot produce a second fee line on a second
   * invoice either — which is exactly the shape the failure would take, since
   * the retry would create its own invoice first.
   */
  source_key text not null,

  unique (invoice_id, line_number),
  constraint invoice_lines_source_authorized check (
    case source
      when 'consultation_fee' then encounter_id is not null and dispense_line_id is null and otc_line_id is null
      when 'prescription'     then dispense_line_id is not null and otc_line_id is null
      when 'otc'              then otc_line_id is not null and dispense_line_id is null
      else true
    end
  )
);

create unique index if not exists invoice_lines_source_key on jmc.invoice_lines (source_key);
create index if not exists invoice_lines_invoice_idx on jmc.invoice_lines (invoice_id, line_number);
create index if not exists invoice_lines_encounter_idx on jmc.invoice_lines (encounter_id);
create index if not exists invoice_lines_dispense_idx on jmc.invoice_lines (dispense_line_id);
create index if not exists invoice_lines_otc_idx on jmc.invoice_lines (otc_line_id);
create index if not exists invoice_lines_medicine_idx on jmc.invoice_lines (medicine_id);

/*
 * An invoice line is what was charged. It never changes.
 *
 * A waiver is a fee line of ₹0 with a reason, not a line edited to zero. A
 * correction is a compensating `adjustment` line. A refund is a payment in the
 * other direction. The brief's §7 says the financial truth is immutable bill
 * lines plus payment allocations plus compensating events, and this is what
 * makes that sentence true of the database rather than of the intention.
 */
create or replace function jmc.reject_financial_change()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  raise exception
    'Financial history is append-only. Add a compensating line, payment or reversal instead of changing %.',
    tg_table_name;
end;
$$;

drop trigger if exists invoice_lines_immutable on jmc.invoice_lines;
create trigger invoice_lines_immutable
before update or delete on jmc.invoice_lines
for each row execute function jmc.reject_financial_change();

create table if not exists jmc.payments (
  id text primary key,
  receipt_number text not null unique,
  -- 'payment' is money in; 'refund' is money out. Both are positive amounts
  -- with a direction, because a negative payment is a number that means two
  -- things depending on where you read it.
  kind text not null check (kind in ('payment', 'refund')),
  patient_id text references jmc.patients(id),
  method text not null check (method in ('cash', 'upi', 'card')),
  -- Policy register 23: the method is required, the reference is not.
  reference text not null default '',
  amount numeric(12,2) not null check (amount > 0),
  status text not null check (status in ('received', 'reversed')),
  idempotency_key text not null unique,
  note text not null default '',
  received_by text not null references jmc.staff(id),
  received_at timestamptz not null default now(),
  reversed_by text references jmc.staff(id),
  reversed_at timestamptz,
  reversal_reason text not null default '',
  reverses_payment_id text references jmc.payments(id),
  constraint payments_reversed_completely
    check ((status = 'reversed') = (reversed_by is not null and reversed_at is not null))
);

create index if not exists payments_patient_idx on jmc.payments (patient_id, received_at desc);
create index if not exists payments_received_idx on jmc.payments (received_at desc);
create index if not exists payments_method_idx on jmc.payments (method, received_at);
create index if not exists payments_by_idx on jmc.payments (received_by);
create index if not exists payments_reversed_by_idx on jmc.payments (reversed_by);
create index if not exists payments_reverses_idx on jmc.payments (reverses_payment_id)
  where reverses_payment_id is not null;

create table if not exists jmc.payment_allocations (
  id text primary key,
  payment_id text not null references jmc.payments(id),
  invoice_id text not null references jmc.invoices(id),
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (payment_id, invoice_id)
);

create index if not exists payment_allocations_invoice_idx on jmc.payment_allocations (invoice_id);
create index if not exists payment_allocations_payment_idx on jmc.payment_allocations (payment_id);

drop trigger if exists payment_allocations_immutable on jmc.payment_allocations;
create trigger payment_allocations_immutable
before update or delete on jmc.payment_allocations
for each row execute function jmc.reject_financial_change();

-- The OTC sale's invoice, now that invoices exist.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'otc_sales_invoice_fk'
                    and conrelid = 'jmc.otc_sales'::regclass) then
    alter table jmc.otc_sales
      add constraint otc_sales_invoice_fk foreign key (invoice_id) references jmc.invoices(id);
  end if;
end $$;

create index if not exists otc_sales_invoice_idx on jmc.otc_sales (invoice_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. THE CONSULTATION FEE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Policy register 15 and 16. The clinic default is ₹300 to begin with and an
-- admin may change it; the doctor may override, discount or waive it for one
-- consultation, with a reason; a later change to the default never rewrites an
-- old visit. So the amount charged is snapshotted onto the encounter, and the
-- default in force at the time is snapshotted beside it — otherwise "was this
-- a discount?" is unanswerable a month later.
--
-- A waived visit is ₹0 AND waived, not an absent bill line. Policy register 33
-- is explicit that a free consultation is recorded as an explicit ₹0/waived
-- charge with a reason and an actor, and a missing line cannot say who decided.

alter table jmc.encounters
  add column if not exists consultation_fee numeric(12,2) check (consultation_fee is null or consultation_fee >= 0),
  add column if not exists consultation_fee_default numeric(12,2)
    check (consultation_fee_default is null or consultation_fee_default >= 0),
  add column if not exists fee_waived boolean not null default false,
  add column if not exists fee_reason text not null default '',
  add column if not exists fee_set_by text references jmc.staff(id),
  add column if not exists fee_set_at timestamptz;

create index if not exists encounters_fee_set_by_idx on jmc.encounters (fee_set_by);

alter table jmc.encounters drop constraint if exists encounters_waiver_explained;
alter table jmc.encounters
  add constraint encounters_waiver_explained
  check (not fee_waived or (consultation_fee = 0 and length(trim(fee_reason)) > 0));

/*
 * ₹300, the owner's initial default (policy register 15).
 *
 * Both halves matter. The column default is what a freshly created settings
 * row carries, so a new clinic — and every test database — starts at the
 * figure the owner chose rather than at zero, which would make every
 * consultation free by omission. The update applies it to the row that already
 * exists, and only where nobody has configured a figure: a clinic that has
 * already chosen one keeps it.
 */
alter table jmc.clinic_settings alter column consultation_fee set default 300;
update jmc.clinic_settings set consultation_fee = 300 where consultation_fee = 0;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. WHAT THE OLD BILLS BECOME
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every existing `bills` row becomes an invoice with one line, and every paid
-- one additionally becomes a payment allocated in full to it. Nothing is lost
-- and nothing is invented: the amount, the label, the patient, the method and
-- both timestamps are carried across exactly as they stand.
--
-- The ids are derived from the bill id rather than generated, so this is
-- idempotent and so a bill keeps a visible link to what it became.
--
-- `bills` is then dropped. Keeping it beside the invoices would be two answers
-- to "what does this patient owe", and the one nobody updated would be the one
-- somebody reported from.

/*
 * Wrapped in a DO block, and run only while `jmc.bills` still exists.
 *
 * `supabase db push` applies a migration once, so in the clinic this runs
 * exactly once and the guard costs nothing. This repository applies the whole
 * set from scratch on every `staging:up` and again in the rehearsal, and plain
 * SQL naming a dropped table fails at PARSE time — before any `if exists`
 * could help. `EXECUTE` defers the parse until the branch is actually taken.
 *
 * docs/operations/STAGING.md §3.1 is the same argument from the other direction: a
 * migration applied by a route nobody planned for should fail loudly or not at
 * all, never half-way.
 */
do $$
begin
  if to_regclass('jmc.bills') is null then
    return;
  end if;

  execute $backfill$
    insert into jmc.invoices (id, invoice_number, patient_id, status, created_by, created_at)
    select
      'inv-' || b.id,
      'INV-' || lpad((row_number() over (order by b.created_at, b.id))::text, 6, '0'),
      b.patient_id,
      'open',
      -- The bill recorded no author. The clinic's earliest admin is the least
      -- wrong attribution available, and it is recorded as a migration in the
      -- audit rather than left looking like somebody's work.
      (select s.id from jmc.staff s where s.roles_json like '%"admin"%' order by s.created_at limit 1),
      b.created_at::timestamptz
    from jmc.bills b
    where exists (select 1 from jmc.staff s where s.roles_json like '%"admin"%')
    on conflict (id) do nothing
  $backfill$;

  execute $backfill$
    insert into jmc.invoice_lines
      (id, invoice_id, line_number, source, medicine_id, description, quantity,
       unit_amount, amount, source_key)
    select
      'invl-' || b.id, 'inv-' || b.id, 1, 'adjustment', null,
      coalesce(nullif(b.label, ''), 'Charge'), 1,
      b.amount, b.amount, 'legacy-bill:' || b.id
    from jmc.bills b
    join jmc.invoices i on i.id = 'inv-' || b.id
    on conflict (id) do nothing
  $backfill$;

  execute $backfill$
    insert into jmc.payments
      (id, receipt_number, kind, patient_id, method, amount, status, idempotency_key,
       note, received_by, received_at)
    select
      'pay-' || b.id,
      'RCP-' || lpad((row_number() over (order by b.paid_at, b.id))::text, 6, '0'),
      'payment', b.patient_id,
      coalesce(nullif(b.payment_method, ''), 'cash'),
      b.amount, 'received', 'legacy-bill:' || b.id,
      'Carried across from the bill this replaced',
      (select s.id from jmc.staff s where s.roles_json like '%"admin"%' order by s.created_at limit 1),
      coalesce(b.paid_at, b.created_at)::timestamptz
    from jmc.bills b
    join jmc.invoices i on i.id = 'inv-' || b.id
    where b.status = 'paid' and b.amount > 0
    on conflict (id) do nothing
  $backfill$;

  execute $backfill$
    insert into jmc.payment_allocations (id, payment_id, invoice_id, amount, created_at)
    select 'pal-' || b.id, 'pay-' || b.id, 'inv-' || b.id, b.amount,
           coalesce(b.paid_at, b.created_at)::timestamptz
    from jmc.bills b
    join jmc.payments p on p.id = 'pay-' || b.id
    on conflict (id) do nothing
  $backfill$;

  -- The sequences continue past what the backfill used, so the next document
  -- printed does not carry a number already on paper.
  --
  -- `count + 1, false` ("this is the next number out"), the same shape as
  -- prescription_number_seq in Slice 2. This line used to read
  -- `greatest(count, 1), true`, which says the same thing for a clinic with
  -- bills and something different for one with none: it marks 1 as used, so
  -- an empty clinic's first bill was INV-000002 and its first receipt
  -- RCP-000002, with nothing ever numbered 1. Nothing caught it because the
  -- test harness and the fixtures set both sequences themselves. The
  -- clean-start rehearsal does not, and it found it on 31 October 2026, before
  -- this migration had been applied to the clinic.
  perform setval('jmc.invoice_seq', (select count(*) + 1 from jmc.invoices), false);
  perform setval('jmc.receipt_seq', (select count(*) + 1 from jmc.payments), false);

  /*
   * Emptied and left standing, rather than dropped.
   *
   * There is one answer to "what does this patient owe" — the invoices — and
   * an emptied table is not a second one. What it is, for one release, is a
   * tombstone: anything that still names `jmc.bills` fails loudly on zero rows
   * instead of silently on a missing relation, and a restore of yesterday's
   * dump still has somewhere to put the old rows.
   *
   * Dropping it would also make the migration set un-re-applicable: Slice 3's
   * money conversion includes `alter table jmc.bills alter column amount type
   * numeric`, which cannot be re-run against a table that no longer exists.
   * `supabase db push` applies each file once, but this repository applies the
   * whole set from scratch on every staging build and again in the rehearsal,
   * and a set that can only be applied once is a set nobody can test.
   *
   * A later migration removes it, once the clinic has run a full reconciliation
   * period on invoices.
   */
  execute 'delete from jmc.bills';
  execute $comment$
    comment on table jmc.bills is
      'SUPERSEDED by invoices, invoice_lines, payments and payment_allocations (Slice 4). '
      'Emptied, not dropped: see 20260913000000. Nothing reads or writes it.'
  $comment$;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. WHAT THE EVENTS ADD UP TO
-- ═══════════════════════════════════════════════════════════════════════════

-- What a prescription line has had, and what is left. Built on
-- `prescription_lines_effective`, so a doctor's resolution of a legacy line is
-- folded in, and on the outcomes above, so a declined or cancelled line is
-- finished whatever arithmetic says.
create or replace view jmc.prescription_line_supply
with (security_invoker = true) as
select
  e.id,
  e.prescription_id,
  e.line_number,
  e.medicine_name_snapshot,
  e.effective_medicine_id,
  e.effective_quantity,
  e.needs_review,
  e.cancelled as legacy_cancelled,
  coalesce(d.supplied, 0)::integer as supplied,
  greatest(coalesce(e.effective_quantity, 0) - coalesce(d.supplied, 0), 0)::integer as remaining,
  o.outcome,
  o.reason as outcome_reason,
  (
    not e.needs_review
    and not e.cancelled
    and o.outcome is null
    and coalesce(e.effective_quantity, 0) - coalesce(d.supplied, 0) > 0
  ) as supplyable,
  case
    when e.needs_review                              then 'needs_review'
    when e.cancelled                                 then 'doctor_cancelled'
    when o.outcome = 'doctor_cancelled'              then 'doctor_cancelled'
    when o.outcome = 'patient_declined'              then 'patient_declined'
    when coalesce(d.supplied, 0) = 0                 then 'waiting'
    when coalesce(d.supplied, 0) >= coalesce(e.effective_quantity, 0) then 'supplied'
    else 'part_supplied'
  end as supply_state
from jmc.prescription_lines_effective e
left join lateral (
  select sum(l.quantity) as supplied
    from jmc.dispense_lines l
    join jmc.dispenses x on x.id = l.dispense_id
   where l.prescription_line_id = e.id and x.status = 'completed'
) d on true
left join jmc.prescription_line_outcomes o on o.prescription_line_id = e.id;

-- What an invoice is worth, what has been paid against it, and what is due.
-- Derived every time. There is no paid/unpaid column to fall out of step.
create or replace view jmc.invoice_balances
with (security_invoker = true) as
select
  i.id,
  i.invoice_number,
  i.patient_id,
  i.encounter_id,
  i.status,
  i.created_at,
  coalesce(l.total, 0)::numeric(12,2) as total,
  coalesce(p.paid, 0)::numeric(12,2) as paid,
  (coalesce(l.total, 0) - coalesce(p.paid, 0))::numeric(12,2) as due,
  case
    when i.status = 'void'                              then 'void'
    when coalesce(p.paid, 0) >= coalesce(l.total, 0)    then 'paid'
    when coalesce(p.paid, 0) > 0                        then 'part_paid'
    else 'unpaid'
  end as payment_state
from jmc.invoices i
left join lateral (
  select sum(amount) as total from jmc.invoice_lines where invoice_id = i.id
) l on true
left join lateral (
  -- A refund is money out, so it reduces what has been paid. A reversed
  -- payment counts for nothing at all, which is different from a refund: one
  -- says the money came back, the other says it never arrived.
  select sum(case when y.kind = 'refund' then -a.amount else a.amount end) as paid
    from jmc.payment_allocations a
    join jmc.payments y on y.id = a.payment_id
   where a.invoice_id = i.id and y.status = 'received'
) p on true;

-- What a patient owes the clinic, across every invoice. Policy register 22:
-- a running balance and an immutable payment history, with no credit limit and
-- no due date in the first release.
create or replace view jmc.patient_balances
with (security_invoker = true) as
select
  pt.id as patient_id,
  pt.name,
  coalesce(sum(b.total) filter (where b.status <> 'void'), 0)::numeric(12,2) as billed,
  coalesce(sum(b.paid)  filter (where b.status <> 'void'), 0)::numeric(12,2) as paid,
  coalesce(sum(b.due)   filter (where b.status <> 'void'), 0)::numeric(12,2) as outstanding,
  count(*) filter (where b.status <> 'void' and b.due > 0) as open_invoices,
  max(b.created_at) filter (where b.status <> 'void' and b.due > 0) as oldest_due_at
from jmc.patients pt
left join jmc.invoice_balances b on b.patient_id = pt.id
group by pt.id, pt.name;


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. ACCESS
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array[
    'prescription_line_outcomes', 'dispenses', 'dispense_lines', 'dispense_allocations',
    'otc_lines', 'otc_allocations', 'otc_returns',
    'invoices', 'invoice_lines', 'payments', 'payment_allocations'
  ] loop
    execute format('alter table jmc.%I enable row level security', t);
    execute format('alter table jmc.%I no force row level security', t);
    execute format('revoke all on table jmc.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

revoke all on jmc.prescription_line_supply, jmc.invoice_balances, jmc.patient_balances
  from public, anon, authenticated, service_role;

revoke all on sequence jmc.dispense_seq, jmc.invoice_seq, jmc.receipt_seq
  from public, anon, authenticated, service_role;
