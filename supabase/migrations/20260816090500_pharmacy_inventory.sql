-- Pharmacy: suppliers, drugs, batches, the stock ledger, dispenses, bills.
--
-- This migration is where INVENTORY.md §1 lands, and it lands here rather than
-- in a later one on purpose (BUILD.md §1.4, PLAN.md §5.3 rule 9). The base-unit
-- model cannot be retrofitted onto recorded stock: the first time a
-- manufacturer ships 10s where it used to ship 15s, every historical quantity
-- is silently wrong.
--
-- The rule, stated once and enforced by naming: every stock number in this
-- database is in base units, and every column holding one is called qty_base.
-- Boxes and strips exist at the edges only — the receiving screen and the label.

create type base_unit     as enum ('tablet', 'ml', 'piece');
create type drug_schedule as enum ('OTC', 'H', 'H1', 'X');
create type mrp_basis     as enum ('unit', 'strip', 'box');

create table suppliers (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  contact_name       text,
  whatsapp_number    text,
  phone              text,
  email              text,
  gstin              text,
  -- What the supplier claims. The reorder intelligence in INVENTORY.md §8 uses
  -- measured lead time from PO sent → GRN instead, and this stays as the seed.
  lead_time_days     int check (lead_time_days >= 0),
  -- INVENTORY.md §6: most suppliers accept returns within a window before
  -- expiry, typically 3–6 months. Missing that window is pure loss, which is
  -- why the expiring list is grouped by whose window closes first.
  return_window_days int check (return_window_days >= 0),
  payment_terms      text,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table drugs (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  generic                text,
  -- Mandatory, and structured rather than buried in the brand name: salt plus
  -- strength plus form is what makes substitution a lookup instead of a
  -- clinical inference (INVENTORY.md §7, §9).
  salt_composition       text not null,
  strength               text not null,
  form                   text not null,
  -- Never changes. The smallest sellable thing: one tablet, one ml, one piece.
  base_unit              base_unit not null,
  -- DEFAULT pack config only — it prefills the receiving screen. What actually
  -- arrived is recorded on the batch, and when they differ the batch wins.
  default_units_per_strip int check (default_units_per_strip > 0),
  default_strips_per_box  int check (default_strips_per_box > 0),
  default_mrp_basis       mrp_basis not null default 'strip',
  schedule               drug_schedule not null default 'OTC',
  hsn                    text,
  default_supplier_id    uuid references suppliers (id),
  -- Reorder levels are in base units like everything else.
  reorder_level_base     int check (reorder_level_base >= 0),
  reorder_qty_base       int check (reorder_qty_base >= 0),
  active                 boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index drugs_search_idx on drugs
  using gin (to_tsvector('simple', name || ' ' || coalesce(generic, '') || ' ' || salt_composition));
-- Same salt + same strength + same form = substitutable. Nothing else is.
create index drugs_substitution_idx on drugs (salt_composition, strength, form) where active;

create table stock_batches (
  id                  uuid primary key default gen_random_uuid(),
  drug_id             uuid not null references drugs (id),
  batch_no            text not null,
  -- The last usable date: strips print "Mar 2027" and the stock is good through
  -- 31 Mar 2027. The GRN transition normalises a printed month to month-end.
  expiry              date not null,
  -- Pack configuration lives HERE, not on the drug. Manufacturers change strip
  -- sizes between production runs; if this lived on the drug, one supplier
  -- switching 15s to 10s would corrupt every historical quantity.
  units_per_strip     int not null check (units_per_strip > 0),
  strips_per_box      int not null check (strips_per_box > 0),
  -- MRP is printed per batch — that is exactly why it is on the strip and not
  -- in a catalogue. Selling above it is illegal, so it is an invariant, not a
  -- default. mrp_basis says which pack the printed figure refers to.
  mrp                 numeric(12, 2) not null check (mrp >= 0),
  mrp_basis           mrp_basis not null default 'strip',
  -- What this batch actually cost: invoice value ÷ base units received, net of
  -- trade discount, freight apportioned (INVENTORY.md §4). Weighted average is
  -- per batch, which makes COGS exact rather than estimated.
  cost_per_base_unit  numeric(12, 4) not null default 0 check (cost_per_base_unit >= 0),
  qty_base_received   int not null default 0 check (qty_base_received >= 0),
  -- A cache over stock_movements, updated in the same transaction (rule 3).
  -- The column check is the last line of defence: a negative shelf is a lie the
  -- software told, and there is no override and no staff role that can do it.
  qty_base_on_hand    int not null default 0 check (qty_base_on_hand >= 0),
  supplier_id         uuid references suppliers (id),
  grn_id              uuid,
  received_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (drug_id, batch_no)
);

-- The FEFO index: first expiry, first out.
create index stock_batches_fefo_idx
  on stock_batches (drug_id, expiry, received_at)
  where qty_base_on_hand > 0;

create type stock_movement_type as enum (
  'receipt', 'dispense', 'sale', 'return_in', 'return_out', 'adjust', 'writeoff_expiry'
);

-- The ledger. PLAN.md §5.3 rule 3: this is the truth, qty_base_on_hand is a
-- cache over it, and a nightly job asserts they agree.
create table stock_movements (
  id                    uuid primary key default gen_random_uuid(),
  drug_id               uuid not null references drugs (id),
  batch_id              uuid not null references stock_batches (id),
  -- Signed: positive in, negative out. Never zero — a movement that moves
  -- nothing is a bug, not a record.
  qty_base              int not null check (qty_base <> 0),
  type                  stock_movement_type not null,
  ref_type              text,
  ref_id                uuid,
  staff_id              uuid not null references staff (id),
  at                    timestamptz not null default now(),
  note                  text,
  -- Corrections are compensating rows with a reason, never edits.
  reverses_movement_id  uuid references stock_movements (id),
  reason                text
);

create index stock_movements_batch_idx on stock_movements (batch_id, at);
create index stock_movements_drug_idx  on stock_movements (drug_id, at desc);
create index stock_movements_ref_idx   on stock_movements (ref_type, ref_id);

create trigger stock_movements_is_append_only
  before update or delete on stock_movements
  for each row execute function app.refuse_mutation();

create table bills (
  id              uuid primary key default gen_random_uuid(),
  patient_id      uuid references patients (id),
  encounter_id    uuid references encounters (id),
  consult_fee     numeric(12, 2) not null default 0 check (consult_fee >= 0),
  medicines_total numeric(12, 2) not null default 0 check (medicines_total >= 0),
  discount        numeric(12, 2) not null default 0 check (discount >= 0),
  -- GST is deferred by PLAN.md §18 Q4: the fields are captured from day one so
  -- switching it on later is a rate column and a bill layout, not a migration.
  tax             jsonb not null default '{}'::jsonb,
  total           numeric(12, 2) not null default 0 check (total >= 0),
  status          text not null default 'unpaid' check (status in ('unpaid', 'paid', 'cancelled')),
  paid_at         timestamptz,
  method          text check (method in ('cash', 'upi', 'card')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table dispenses (
  id              uuid primary key default gen_random_uuid(),
  prescription_id uuid references prescriptions (id),
  patient_id      uuid references patients (id),
  staff_id        uuid not null references staff (id),
  at              timestamptz not null default now(),
  bill_id         uuid references bills (id),
  -- A walk-in buying without a prescription (PLAN.md §18 Q3). Schedule H1
  -- cannot leave on one of these — enforced in the transition, not in a form.
  is_counter_sale boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint dispense_has_a_source check (
    (prescription_id is not null) or is_counter_sale
  )
);

create index dispenses_prescription_idx on dispenses (prescription_id);

create table dispense_lines (
  id                  uuid primary key default gen_random_uuid(),
  dispense_id         uuid not null references dispenses (id),
  drug_id             uuid not null references drugs (id),
  -- Which batch these units left from. This is what makes recall traceability
  -- and exact cost-of-goods-sold possible.
  batch_id            uuid not null references stock_batches (id),
  qty_base            int not null check (qty_base > 0),
  unit_price          numeric(12, 4) not null check (unit_price >= 0),
  amount              numeric(12, 2) not null check (amount >= 0),
  -- Cost of the units actually allocated, captured at dispense time so margin
  -- survives a later cost correction (INVENTORY.md §4).
  cost_at_dispense    numeric(12, 4) not null default 0 check (cost_at_dispense >= 0),
  -- Substitution records both sides: what was prescribed and what left the
  -- shelf, plus who approved it (INVENTORY.md §7). Null when they are the same.
  prescribed_drug_id  uuid references drugs (id),
  substitution_approved_by uuid references staff (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint substitution_needs_approval check (
    prescribed_drug_id is null or substitution_approved_by is not null
  )
);

create index dispense_lines_dispense_idx on dispense_lines (dispense_id);
create index dispense_lines_batch_idx    on dispense_lines (batch_id);

create trigger suppliers_touch      before update on suppliers      for each row execute function app.touch_updated_at();
create trigger drugs_touch          before update on drugs          for each row execute function app.touch_updated_at();
create trigger stock_batches_touch  before update on stock_batches  for each row execute function app.touch_updated_at();
create trigger bills_touch          before update on bills          for each row execute function app.touch_updated_at();
create trigger dispenses_touch      before update on dispenses      for each row execute function app.touch_updated_at();
create trigger dispense_lines_touch before update on dispense_lines for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Available stock.
--
-- INVENTORY.md §3: expired batches are EXCLUDED from on-hand, not merely
-- flagged. Conflating the two is what let expired stock over the counter in the
-- prototype. Every screen that asks "what do we have" reads this view, never
-- stock_batches directly.
-- ---------------------------------------------------------------------------
create view available_stock as
select
  b.id            as batch_id,
  b.drug_id,
  b.batch_no,
  b.expiry,
  b.units_per_strip,
  b.strips_per_box,
  b.mrp,
  b.mrp_basis,
  b.cost_per_base_unit,
  b.qty_base_on_hand,
  app.units_in_pack(b.units_per_strip, b.strips_per_box, b.mrp_basis::text) as units_in_pack,
  b.supplier_id
from stock_batches b
where b.qty_base_on_hand > 0
  and b.expiry >= current_date;

comment on view available_stock is
  'On-hand excludes expired batches entirely (INVENTORY.md §3). Never read stock_batches directly for availability.';

-- ---------------------------------------------------------------------------
-- Rule 3's assertion: the ledger is the truth, the cache must agree with it.
-- A nightly job selects from this view and alerts on any row (HOSTING.md §5).
-- ---------------------------------------------------------------------------
create view stock_cache_drift as
select
  b.id as batch_id,
  b.drug_id,
  b.batch_no,
  b.qty_base_on_hand                        as cached,
  coalesce(sum(m.qty_base), 0)::int         as ledger,
  b.qty_base_on_hand - coalesce(sum(m.qty_base), 0)::int as drift
from stock_batches b
left join stock_movements m on m.batch_id = b.id
group by b.id
having b.qty_base_on_hand <> coalesce(sum(m.qty_base), 0)::int;

comment on view stock_cache_drift is
  'Must always be empty. PLAN.md §5.3 rule 3 — the nightly job alerts if it is not.';

-- ---------------------------------------------------------------------------
-- RLS.
--
-- Note the shape of the grants: stock_batches, stock_movements, dispenses and
-- dispense_lines are transition-owned. Staff may SELECT them and nothing more.
-- The INSERT/UPDATE grants are deliberately absent, which is what turns rules 2
-- and 3 from convention into something Postgres refuses (0600).
-- ---------------------------------------------------------------------------
alter table suppliers      enable row level security;
alter table drugs          enable row level security;
alter table stock_batches  enable row level security;
alter table stock_movements enable row level security;
alter table bills          enable row level security;
alter table dispenses      enable row level security;
alter table dispense_lines enable row level security;

grant select on suppliers, drugs, stock_batches, stock_movements, bills, dispenses, dispense_lines
  to authenticated;
grant select on available_stock, stock_cache_drift to authenticated;

-- Master data is ordinary CRUD under RLS: it moves neither money nor stock.
grant insert, update on suppliers, drugs to authenticated;

create policy suppliers_staff on suppliers
  for all to authenticated
  using (app.current_staff_id() is not null)
  with check (app.current_staff_id() is not null);

create policy drugs_staff on drugs
  for all to authenticated
  using (app.current_staff_id() is not null)
  with check (app.current_staff_id() is not null);

create policy stock_batches_read on stock_batches
  for select to authenticated
  using (app.current_staff_id() is not null);

create policy stock_movements_read on stock_movements
  for select to authenticated
  using (app.current_staff_id() is not null);

create policy bills_read on bills
  for select to authenticated
  using (app.current_staff_id() is not null);

create policy dispenses_read on dispenses
  for select to authenticated
  using (app.current_staff_id() is not null);

create policy dispense_lines_read on dispense_lines
  for select to authenticated
  using (app.current_staff_id() is not null);

comment on column stock_batches.units_per_strip is
  'On the BATCH, not the drug. Manufacturers change strip sizes between runs (INVENTORY.md §1).';
comment on column stock_batches.qty_base_on_hand is
  'Cache over stock_movements, updated in the same transaction. See stock_cache_drift.';
comment on column stock_movements.qty_base is
  'Signed, in base units. Append-only: corrections are compensating rows.';
