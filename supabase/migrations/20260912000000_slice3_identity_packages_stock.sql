-- Slice 3: what a medicine IS, what it ARRIVES IN, and how much is on the shelf.
--
-- Until now those three were one row. `jmc.medicines` carried a brand name, a
-- strength typed as free text, one `unit` column, and `reorder_level`, and
-- `jmc.batches` carried a quantity in that same unnamed unit. That is enough to
-- run a pharmacy that only ever stocks tablets in one pack size and never
-- changes it, and it is wrong the first time a supplier ships strips of ten
-- where they used to ship fifteen — because the number 150 in `available_quantity`
-- means "ten strips" or "fifteen strips" depending on a fact the database does
-- not hold.
--
-- This migration separates the three, in the order archive/docs/current-programme/SLICE3_CLINIC_APPROVAL_PACK.md
-- §6 sets out:
--
--   substance  -> clinical drug  -> product      -> package version -> batch -> ledger
--   Paracetamol   500 mg tablet     Calpol 500       strip of 15       HIST-1   -349 tablets
--                 (oral, immediate) (GSK)            box of 10 strips
--
-- Clinical identity is above the line and inventory is below it. A doctor
-- prescribes a clinical drug or a product; the pharmacy receives a package and
-- moves base units. Neither can silently become the other.
--
-- ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
--
-- No measured dispensing. The clinic answered "no" to dividing an opened
-- bottle, tube, vial or inhaler (approval pack §8.A), so a package level counts
-- whole countable items and nothing here can express 30 mL out of a 100 mL
-- bottle. `child_count` is `integer`, which refuses the fraction structurally
-- rather than by a rule somebody can relax in the UI.
--
-- No dispensing, checkout, billing or payment. Those are Slice 4. What is built
-- here is the package-selection and conversion foundation they need.
--
-- Every object is schema-qualified.

-- ═══════════════════════════════════════════════════════════════════════════
-- 0. MONEY STOPS BEING APPROXIMATE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every money column in this schema was `real` — IEEE 754 single precision,
-- about seven significant decimal digits. A rupee amount of 99,999.99 needs
-- exactly seven, so the clinic is already at the edge of the type, and below
-- it the arithmetic is simply not the arithmetic a pharmacist does:
--
--   select 0.1::real * 3;        -- 0.3
--   select (0.1::real * 3)::text;-- 0.30000001
--   select 1234.56::real;        -- 1234.56
--   select 1234.56::real * 100;  -- 123456.01
--
-- The brief's §7 lists "exact decimal `numeric` values for money" as an
-- invariant every migration must satisfy, and Slice 4 is about to build bills,
-- payment allocations and a running patient balance on top of these columns.
-- Converting after that is converting live financial history.
--
-- `round(x::numeric, 2)` rather than a bare cast: `40.0::real::numeric` is
-- 40, but a value that arrived through a float multiplication can be
-- 34.999998, and a paise column should hold 35.00 rather than carry the noise
-- of the type it is leaving. Two decimal places is the smallest unit of Indian
-- currency; nothing in this clinic prices below a paisa.
--
-- Not converted: `vitals.temperature` and `vitals.weight`. Those are
-- measurements from an instrument with its own precision, not money, and
-- 37.0 °C does not become wrong by being a float.

alter table jmc.clinic_settings
  alter column consultation_fee type numeric(12,2) using round(consultation_fee::numeric, 2);

alter table jmc.bills
  alter column amount type numeric(12,2) using round(amount::numeric, 2);

alter table jmc.batches
  alter column mrp            type numeric(12,2) using round(mrp::numeric, 2),
  alter column purchase_price type numeric(12,2) using round(purchase_price::numeric, 2),
  alter column selling_price  type numeric(12,2) using round(selling_price::numeric, 2);

alter table jmc.otc_sales
  alter column total type numeric(12,2) using round(total::numeric, 2);

alter table jmc.stock_writeoffs
  alter column cost_value type numeric(12,2) using round(cost_value::numeric, 2);

alter table jmc.supplier_returns
  alter column expected_credit type numeric(12,2) using round(expected_credit::numeric, 2);

alter table jmc.till_sessions
  alter column opening_float type numeric(12,2) using round(opening_float::numeric, 2),
  alter column counted_cash  type numeric(12,2) using round(counted_cash::numeric, 2),
  alter column expected_cash type numeric(12,2) using round(expected_cash::numeric, 2),
  alter column variance      type numeric(12,2) using round(variance::numeric, 2);

alter table jmc.cash_movements
  alter column amount type numeric(12,2) using round(amount::numeric, 2);

alter table jmc.stock_takes
  alter column recount_threshold type numeric(12,2) using round(recount_threshold::numeric, 2);

alter table jmc.stock_take_lines
  alter column variance_value type numeric(12,2) using round(variance_value::numeric, 2);


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. CLINICAL IDENTITY
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── ON TERMINOLOGY RIGHTS ──────────────────────────────────────────────────
--
-- docs/AGENT_IMPLEMENTATION_BRIEF.md §Slice 3 and the research document are both
-- explicit: do not import or redistribute licensed terminology without
-- confirming the applicable India/SNOMED/CDCI terms. Nothing is imported here.
-- These tables are empty on creation and are filled by the clinic's own
-- pharmacist typing what is on the pack.
--
-- What they DO carry is the shape a coded term needs, so that when the clinic
-- is licensed for one, mapping is a column update rather than a schema change:
-- `source` says which authority a row came from, `source_code` its identifier
-- there, `source_version` the release. A row the clinic typed is
-- source = 'clinic', which is a provenance, not a gap.

create table if not exists jmc.substances (
  id               text primary key,
  name             text not null check (length(trim(name)) > 0),
  -- What deduplication compares. The command layer lowercases and collapses
  -- whitespace; the unique index is what actually stops two Paracetamols.
  normalized_name  text not null unique,
  source           text not null default 'clinic',
  source_code      text not null default '',
  source_version   text not null default '',
  active           boolean not null default true,
  created_by       text not null references jmc.staff(id),
  created_at       timestamptz not null default now()
);

create index if not exists substances_created_by_idx on jmc.substances (created_by);
create index if not exists substances_active_idx on jmc.substances (active) where active;

-- A clinical drug is ingredient(s) + strength + dose form + route/release.
-- It is what a generic prescription names, and what a pharmacist must match
-- exactly before offering an in-stock brand (policy register 21).
create table if not exists jmc.clinical_drugs (
  id             text primary key,
  display_name   text not null check (length(trim(display_name)) > 0),
  dosage_form    text not null check (length(trim(dosage_form)) > 0),
  route          text not null default '',
  release_type   text not null default '',
  -- Sorted ingredients + strengths + form + route + release, built by the
  -- command layer. Two doctors typing the same drug twice get one row; a
  -- 500 mg tablet and a 650 mg tablet never collapse into each other.
  identity_key   text not null unique,
  source         text not null default 'clinic',
  source_code    text not null default '',
  source_version text not null default '',
  active         boolean not null default true,
  created_by     text not null references jmc.staff(id),
  created_at     timestamptz not null default now()
);

create index if not exists clinical_drugs_created_by_idx on jmc.clinical_drugs (created_by);
create index if not exists clinical_drugs_form_idx on jmc.clinical_drugs (dosage_form) where active;

-- Strength lives here, not in a text column on the product, because a
-- combination product has more than one and "500 mg + 125 mg" is not a number.
create table if not exists jmc.clinical_drug_ingredients (
  clinical_drug_id text not null references jmc.clinical_drugs(id) on delete cascade,
  ordinal          integer not null check (ordinal > 0),
  substance_id     text not null references jmc.substances(id),
  strength_value   numeric(18,6) not null check (strength_value > 0),
  strength_unit    text not null check (length(trim(strength_unit)) > 0),
  -- The denominator, for a concentration: 125 mg per 5 mL. Null for a flat
  -- strength. Both halves present or neither — a "per" with no unit is a
  -- number nobody can read.
  per_value        numeric(18,6) check (per_value is null or per_value > 0),
  per_unit         text not null default '',
  primary key (clinical_drug_id, ordinal),
  unique (clinical_drug_id, substance_id),
  constraint clinical_drug_ingredients_per_complete
    check ((per_value is null) = (per_unit = ''))
);

create index if not exists clinical_drug_ingredients_substance_idx
  on jmc.clinical_drug_ingredients (substance_id);


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. THE PRODUCT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `jmc.medicines` stays the product row. It already holds the code the clinic
-- uses, the name on the shelf label, and the selling rules, and every
-- prescription line written so far snapshots from it. Splitting it into a new
-- table would orphan that history for no gain; what it needs is the identity
-- above it and the package below it.

alter table jmc.medicines
  -- Nullable on purpose. Every medicine already in the clinic starts
  -- unlinked, because guessing which clinical drug an existing shelf label
  -- means is exactly the invention the brief forbids. The pharmacist links
  -- them during setup and a report counts what is left.
  add column if not exists clinical_drug_id text references jmc.clinical_drugs(id),
  add column if not exists brand_name   text not null default '',
  add column if not exists manufacturer text not null default '',
  -- The smallest countable physical item the clinic stocks and can trace.
  -- Empty means "not yet decided", which the Slice 3 gate reports rather than
  -- filling in from `unit`: `unit` was a display word, not a commitment.
  add column if not exists base_unit text not null default '',
  -- Regulatory classification provenance. `medicines.schedule` already holds
  -- the class and already defaults to 'unset' = Unknown / pharmacist review
  -- required; what was missing is who said so and on what authority.
  add column if not exists schedule_source     text not null default '',
  add column if not exists schedule_version    text not null default '',
  add column if not exists schedule_effective_on date,
  add column if not exists schedule_verified_by text references jmc.staff(id),
  add column if not exists schedule_verified_at timestamptz;

create index if not exists medicines_clinical_drug_idx on jmc.medicines (clinical_drug_id);
create index if not exists medicines_schedule_verified_by_idx on jmc.medicines (schedule_verified_by);

-- The schedule check was written when only five values were known. Indian
-- practice also uses G (Schedule G warning), C and C1 (biologicals), and the
-- clinic will meet something this list does not name; 'other' is the honest
-- place for it, paired with `schedule_source` saying what it actually is.
do $$
begin
  if exists (select 1 from pg_constraint
              where conrelid = 'jmc.medicines'::regclass
                and conname = 'medicines_schedule_check') then
    alter table jmc.medicines drop constraint medicines_schedule_check;
  end if;
end $$;

alter table jmc.medicines
  add constraint medicines_schedule_check
  check (schedule in ('unset', 'OTC', 'H', 'H1', 'X', 'G', 'C', 'C1', 'other'));

-- Verification is a pair. A classification "verified by" nobody at no time is
-- an unverified classification with a reassuring column.
alter table jmc.medicines
  drop constraint if exists medicines_schedule_verification_complete;
alter table jmc.medicines
  add constraint medicines_schedule_verification_complete
  check ((schedule_verified_by is null) = (schedule_verified_at is null));

comment on column jmc.medicines.schedule is
  'Drugs and Cosmetics Rules classification. ''unset'' is Unknown / pharmacist '
  'review required and is refused from the anonymous OTC path. Never inferred '
  'from sale_class.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. PACKAGES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A versioned SKU per product, and under it a chain of levels. Recursive and
-- data-driven — tablet -> strip -> box -> case, bottle -> carton, ampoule ->
-- tray -> carton, or a type nobody has thought of — because
-- `tablets_per_strip` and `strips_per_box` cannot represent a tray of vials or
-- a box holding a device and its consumables (approval pack §6).

create table if not exists jmc.package_versions (
  id           text primary key,
  medicine_id  text not null references jmc.medicines(id),
  version      integer not null check (version > 0),
  -- Repeated from the base level for the one query that matters most: what
  -- unit does this product's stock count in.
  base_unit    text not null check (length(trim(base_unit)) > 0),
  status       text not null check (status in ('draft', 'verified', 'retired')),

  entered_by   text not null references jmc.staff(id),
  entered_at   timestamptz not null default now(),

  -- Approval pack §4 step D. Both a pharmacist and an admin may edit a
  -- package, so permission alone is not the control: a conversion becomes
  -- receivable only after somebody confirms it against the physical pack.
  verified_by  text references jmc.staff(id),
  verified_at  timestamptz,
  verification_source text not null default ''
    check (verification_source in ('', 'physical_pack', 'supplier_invoice', 'manufacturer_data', 'other')),
  verification_note text not null default '',

  retired_by   text references jmc.staff(id),
  retired_at   timestamptz,
  note         text not null default '',

  unique (medicine_id, version),
  -- Verification is all three fields or none of them, and a verified version
  -- must carry them. Stated this way rather than as an equivalence with
  -- `status = 'verified'`, because retiring a verified package moves the
  -- status and must NOT strip the record of who checked it against the pack —
  -- that is the provenance every batch received under it points back to. A
  -- retired draft, which was never verified, carries none.
  constraint package_versions_verified_completely
    check (
      (verified_by is null) = (verified_at is null)
      and (verified_by is not null) = (verification_source <> '')
      and (status <> 'verified' or verified_by is not null)
    ),
  constraint package_versions_retired_completely
    check ((status = 'retired') = (retired_by is not null and retired_at is not null))
);

create index if not exists package_versions_medicine_idx on jmc.package_versions (medicine_id, version desc);
create index if not exists package_versions_entered_by_idx on jmc.package_versions (entered_by);
create index if not exists package_versions_verified_by_idx on jmc.package_versions (verified_by);
create index if not exists package_versions_retired_by_idx on jmc.package_versions (retired_by);

-- A verified package version is what a batch snapshots. Once a batch points at
-- it, its ladder must never move: that is the whole reason pack sizes are
-- versioned rather than edited.
create table if not exists jmc.package_levels (
  id          text primary key,
  package_version_id text not null references jmc.package_versions(id) on delete cascade,
  level_name  text not null check (length(trim(level_name)) > 0),
  -- Free text, so a clinic can create `pouch`, `kit` or `blister card` without
  -- a database change. Approval pack §1: "allow custom package types".
  level_type  text not null check (length(trim(level_type)) > 0),

  -- The level directly inside this one. Null at the base.
  child_level_id text references jmc.package_levels(id),
  child_count    integer check (child_count is null or child_count > 0),

  -- Base units in one of these. Stored rather than computed on read, because
  -- a batch snapshot has to freeze it and every stock query multiplies by it.
  base_factor bigint not null check (base_factor > 0),
  depth       integer not null check (depth >= 0),

  receivable  boolean not null default true,
  sellable    boolean not null default false,
  -- May the counter open one of these to get at what is inside? A strip, yes.
  -- A sealed bottle, no — and that `false` is what keeps measured dispensing
  -- out of ordinary POS.
  breakable   boolean not null default true,
  minimum_sale_multiple integer not null default 1 check (minimum_sale_multiple > 0),
  -- The level the printed MRP applies to. "₹30 per strip of 15", never "₹30".
  mrp_basis   boolean not null default false,

  barcode_hint text not null default '',

  unique (package_version_id, level_name),
  -- One level per rung: the ladder is a chain, not a tree. This is also what
  -- makes two parents for the same level impossible, together with the unique
  -- index on child_level_id below.
  unique (package_version_id, depth),
  constraint package_levels_child_complete
    check ((child_level_id is null) = (child_count is null)),
  constraint package_levels_base_is_depth_zero
    check ((child_level_id is null) = (depth = 0)),
  constraint package_levels_base_factor_one
    check (depth > 0 or base_factor = 1)
);

create unique index if not exists package_levels_one_parent
  on jmc.package_levels (child_level_id) where child_level_id is not null;
create index if not exists package_levels_version_idx on jmc.package_levels (package_version_id, depth);

-- Exactly one level per version may carry the printed MRP.
create unique index if not exists package_levels_one_mrp_basis
  on jmc.package_levels (package_version_id) where mrp_basis;

/*
 * The arithmetic, checked where it is written.
 *
 * `base_factor` and `depth` are denormalized, so something has to keep them
 * honest. A UI that computes them correctly is not that something: the same
 * columns are reachable from a migration, a repair script and a psql session,
 * and a wrong `base_factor` does not look wrong — it looks like a pack size,
 * and it silently multiplies every receipt and every sale of that product.
 *
 * Because depth must be exactly one above the contained level, and is unique
 * per version, a cycle cannot be constructed: following child links strictly
 * decreases an integer bounded below by zero.
 */
create or replace function jmc.enforce_package_level_chain()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
declare
  child jmc.package_levels%rowtype;
begin
  if new.child_level_id is null then
    if new.depth <> 0 then
      raise exception 'A package level that contains nothing is the base level, at depth 0.';
    end if;
    if new.base_factor <> 1 then
      raise exception 'The base package level is one base unit, so its factor is 1.';
    end if;
    return new;
  end if;

  select * into child from jmc.package_levels where id = new.child_level_id;
  if not found then
    raise exception 'Package level % does not exist, so nothing can contain it.', new.child_level_id;
  end if;
  if child.id = new.id then
    raise exception 'A package level cannot contain itself.';
  end if;
  if child.package_version_id <> new.package_version_id then
    raise exception 'A package level may only contain a level of the same package version.';
  end if;
  if new.depth <> child.depth + 1 then
    raise exception 'A package level sits exactly one step above the level it contains (% would sit at %, not %).',
      new.level_name, child.depth + 1, new.depth;
  end if;
  if new.base_factor <> child.base_factor * new.child_count then
    raise exception '% would hold % base units, but % x % is %.',
      new.level_name, new.base_factor, new.child_count, child.base_factor,
      child.base_factor * new.child_count;
  end if;

  return new;
end;
$$;

drop trigger if exists package_levels_chain on jmc.package_levels;
create trigger package_levels_chain
before insert or update on jmc.package_levels
for each row execute function jmc.enforce_package_level_chain();

/*
 * A verified package version is frozen.
 *
 * Approval pack §6: "old package version stays active for old batches; a new
 * package version is created for new stock". Editing a verified ladder would
 * change what every batch that snapshotted it is understood to contain, which
 * is the failure this whole design exists to prevent. Retiring it and its
 * note are the only fields that may still move.
 */
create or replace function jmc.protect_verified_package()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
declare
  version_status text;
begin
  if tg_table_name = 'package_levels' then
    select status into version_status from jmc.package_versions
     where id = coalesce(new.package_version_id, old.package_version_id);
    if version_status is distinct from 'draft' then
      raise exception 'Package version % is no longer a draft. Create a new version instead of editing this one.',
        coalesce(new.package_version_id, old.package_version_id);
    end if;
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'A verified package version cannot be deleted; retire it.';
    end if;
    return old;
  end if;

  if old.status <> 'draft' then
    if new.medicine_id is distinct from old.medicine_id
       or new.version is distinct from old.version
       or new.base_unit is distinct from old.base_unit
       or new.entered_by is distinct from old.entered_by
       or new.verified_by is distinct from old.verified_by
       or new.verified_at is distinct from old.verified_at
       or new.verification_source is distinct from old.verification_source then
      raise exception 'A verified package version is frozen. Create a new version instead.';
    end if;
    if old.status = 'retired' and new.status <> 'retired' then
      raise exception 'A retired package version cannot be brought back; create a new version.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists package_versions_protected on jmc.package_versions;
create trigger package_versions_protected
before update or delete on jmc.package_versions
for each row execute function jmc.protect_verified_package();

-- Named to sort before `package_levels_chain`. Postgres fires row triggers in
-- alphabetical order, and an attempt to edit a verified ladder should be met
-- with "create a new version" rather than with an arithmetic complaint about
-- the value being edited to.
drop trigger if exists package_levels_protected on jmc.package_levels;
drop trigger if exists package_levels_are_frozen on jmc.package_levels;
create trigger package_levels_are_frozen
before insert or update or delete on jmc.package_levels
for each row execute function jmc.protect_verified_package();

-- The version a new receipt or sale should use: the newest verified one.
create or replace view jmc.medicine_active_package
with (security_invoker = true) as
select distinct on (pv.medicine_id)
       pv.id, pv.medicine_id, pv.id as package_version_id, pv.version, pv.base_unit, pv.status
  from jmc.package_versions pv
 where pv.status = 'verified'
 order by pv.medicine_id, pv.version desc;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. BARCODES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A plain GTIN identifies a trade item at one packaging level. It does NOT
-- identify a batch or an expiry — those live in GS1 application identifiers
-- (10) and (17), which only a GS1-128 or DataMatrix payload carries, and CDSCO's
-- QR guidance allows the code to sit on the secondary pack. So `carries_batch`
-- is recorded per code and defaults to false: a scan tells the pharmacist what
-- the item is and never what lot it came from unless the payload said so.
--
-- The mapping is to (medicine, level name) rather than to a package version.
-- A manufacturer who changes fifteen tablets per strip to ten should issue a
-- new GTIN, and often does not; keying to the version would either block the
-- new version or duplicate the code. Identity is the trade item; the
-- conversion a batch used is on the batch.

create table if not exists jmc.medicine_barcodes (
  id          text primary key,
  medicine_id text not null references jmc.medicines(id),
  level_name  text not null check (length(trim(level_name)) > 0),
  code        text not null unique check (length(trim(code)) > 0),
  symbology   text not null default 'unknown'
    check (symbology in ('unknown', 'ean13', 'ean8', 'upca', 'upce', 'itf14',
                         'gs1_128', 'gs1_datamatrix', 'qr', 'code128', 'other')),
  carries_batch boolean not null default false,
  verified_by text references jmc.staff(id),
  verified_at timestamptz,
  created_by  text not null references jmc.staff(id),
  created_at  timestamptz not null default now(),
  constraint medicine_barcodes_verified_completely
    check ((verified_by is null) = (verified_at is null))
);

create index if not exists medicine_barcodes_medicine_idx on jmc.medicine_barcodes (medicine_id);
create index if not exists medicine_barcodes_created_by_idx on jmc.medicine_barcodes (created_by);
create index if not exists medicine_barcodes_verified_by_idx on jmc.medicine_barcodes (verified_by);

-- A scan nobody has mapped. Not an error to swallow: it is a queue, because
-- the pharmacist standing at the counter cannot stop to map it and the admin
-- who can needs to know it happened.
create table if not exists jmc.unmapped_barcodes (
  code          text primary key check (length(trim(code)) > 0),
  symbology     text not null default 'unknown',
  seen_count    integer not null default 1 check (seen_count > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  first_seen_by text not null references jmc.staff(id),
  resolved_at   timestamptz,
  resolved_by   text references jmc.staff(id)
);

create index if not exists unmapped_barcodes_open_idx on jmc.unmapped_barcodes (last_seen_at desc)
  where resolved_at is null;
create index if not exists unmapped_barcodes_first_seen_by_idx on jmc.unmapped_barcodes (first_seen_by);
create index if not exists unmapped_barcodes_resolved_by_idx on jmc.unmapped_barcodes (resolved_by);


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. BATCHES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A batch is a lot of one product that arrived once, in one package
-- configuration, at one price. Everything about how it was counted when it
-- arrived is frozen on it — which is what lets a strip of fifteen and a strip
-- of ten sit on the same shelf and both be correct.

alter table jmc.batches
  add column if not exists package_version_id text references jmc.package_versions(id),
  -- The ladder as it stood at receipt, copied rather than referenced. The
  -- reference is there too; this is the belt to its braces, and it is what a
  -- report reads years later when somebody has retired the version.
  add column if not exists package_snapshot jsonb,
  add column if not exists base_unit text not null default '',

  add column if not exists mrp_basis_level  text not null default '',
  add column if not exists mrp_basis_factor bigint
    check (mrp_basis_factor is null or mrp_basis_factor > 0),
  add column if not exists purchase_basis_level  text not null default '',
  add column if not exists purchase_basis_factor bigint
    check (purchase_basis_factor is null or purchase_basis_factor > 0),

  -- Stock that arrived but has not been accepted onto the sellable shelf, and
  -- stock held back for a reason short of a whole-batch recall. Both are real
  -- quantities with their own ledger movements, not a flag on the available
  -- pool: a quarantined ten and an available ninety are two facts, and one
  -- number cannot hold both.
  add column if not exists quarantined_quantity integer not null default 0
    check (quarantined_quantity >= 0),
  add column if not exists blocked_quantity integer not null default 0
    check (blocked_quantity >= 0),

  add column if not exists status text not null default 'active'
    check (status in ('active', 'recalled', 'blocked')),
  add column if not exists status_reason text not null default '',
  add column if not exists status_changed_by text references jmc.staff(id),
  add column if not exists status_changed_at timestamptz;

create index if not exists batches_package_version_idx on jmc.batches (package_version_id);
create index if not exists batches_status_changed_by_idx on jmc.batches (status_changed_by);
create index if not exists batches_fefo_idx on jmc.batches (medicine_id, expiry, id)
  where status = 'active';
create index if not exists batches_quarantine_idx on jmc.batches (medicine_id)
  where quarantined_quantity > 0;

/*
 * The receipt-time snapshot cannot be edited.
 *
 * `available_quantity` moves all day, and the status may change when a recall
 * arrives. What arrived in the box does not: the package version, its frozen
 * ladder, the base unit, the batch number, the expiry, and the basis each
 * price was quoted against are statements about a delivery that has already
 * happened. Correcting one of them means a compensating ledger event and a new
 * receipt, not an UPDATE.
 *
 * Null-to-value is allowed once, so the Slice 3 backfill and a later
 * reconciliation can fill a column that predates this migration.
 */
create or replace function jmc.protect_batch_receipt()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A batch is a delivery that happened; it cannot be deleted. Write it off or block it.';
  end if;

  if old.medicine_id is distinct from new.medicine_id
     or old.batch_number is distinct from new.batch_number
     or old.expiry is distinct from new.expiry
     or old.received_at is distinct from new.received_at then
    raise exception 'The batch number, medicine, expiry and receipt time of a batch are what arrived; they cannot be changed.';
  end if;

  if old.package_version_id is not null and new.package_version_id is distinct from old.package_version_id then
    raise exception 'A batch keeps the package version it was received under. A changed pack size is a new version and a new batch.';
  end if;
  if old.package_snapshot is not null and new.package_snapshot is distinct from old.package_snapshot then
    raise exception 'The package conversion recorded when this batch arrived cannot be rewritten.';
  end if;
  if old.base_unit <> '' and new.base_unit is distinct from old.base_unit then
    raise exception 'A batch keeps the base unit it was counted in.';
  end if;
  if old.mrp_basis_factor is not null
     and (new.mrp_basis_factor is distinct from old.mrp_basis_factor
          or new.mrp_basis_level is distinct from old.mrp_basis_level) then
    raise exception 'The package the printed MRP applies to is part of the receipt and cannot be changed.';
  end if;
  if old.purchase_basis_factor is not null
     and (new.purchase_basis_factor is distinct from old.purchase_basis_factor
          or new.purchase_basis_level is distinct from old.purchase_basis_level) then
    raise exception 'The package the purchase price was quoted against cannot be changed.';
  end if;

  return new;
end;
$$;

drop trigger if exists batches_receipt_immutable on jmc.batches;
create trigger batches_receipt_immutable
before update or delete on jmc.batches
for each row execute function jmc.protect_batch_receipt();


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. THE LEDGER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Stock truth is the movement ledger (brief §7). The batch columns are a
-- cache of it, and §9 of this migration adds the view that proves they agree.

alter table jmc.stock_movements
  -- Which pool moved. Every row before this migration moved sellable stock,
  -- which is what the default says.
  add column if not exists bucket text not null default 'available'
    check (bucket in ('available', 'quarantine', 'blocked')),
  -- What the human actually entered — "2 boxes + 3 strips + 4 tablets" — kept
  -- beside the base-unit total the ledger moved. Approval pack §9 step 3.
  add column if not exists package_entry jsonb,
  add column if not exists reason text not null default '',
  add column if not exists approved_by text references jmc.staff(id),
  -- A compensating event names what it compensates. History is never rewritten;
  -- it is answered.
  add column if not exists reverses_movement_id text references jmc.stock_movements(id);

create index if not exists stock_movements_approved_by_idx on jmc.stock_movements (approved_by);
create index if not exists stock_movements_reverses_idx on jmc.stock_movements (reverses_movement_id)
  where reverses_movement_id is not null;
create index if not exists stock_movements_batch_bucket_idx on jmc.stock_movements (batch_id, bucket);
create index if not exists stock_movements_actor_idx on jmc.stock_movements (actor_id);
create index if not exists stock_movements_reference_idx on jmc.stock_movements (reference_type, reference_id);

-- Append-only, and enforced rather than described. A ledger somebody can
-- UPDATE is a balance, and a balance cannot be audited.
create or replace function jmc.reject_stock_movement_change()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
begin
  raise exception 'The stock ledger is append-only. Post a compensating movement instead of changing one.';
end;
$$;

drop trigger if exists stock_movements_immutable on jmc.stock_movements;
create trigger stock_movements_immutable
before update or delete on jmc.stock_movements
for each row execute function jmc.reject_stock_movement_change();


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. PURCHASING AND RECEIVING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A purchase order does not add stock. An accepted goods receipt does.

alter table jmc.purchase_order_lines
  -- What was ordered, in the units the clinic said it in. `ordered_quantity`
  -- stays the base-unit total, because every existing row and every query
  -- already means that by it.
  add column if not exists order_level_name text not null default '',
  add column if not exists order_level_count integer
    check (order_level_count is null or order_level_count > 0),
  add column if not exists package_version_id text references jmc.package_versions(id);

create index if not exists purchase_order_lines_medicine_idx on jmc.purchase_order_lines (medicine_id);
create index if not exists purchase_order_lines_package_version_idx
  on jmc.purchase_order_lines (package_version_id);
create index if not exists purchase_orders_supplier_idx on jmc.purchase_orders (supplier_id);
create index if not exists purchase_orders_created_by_idx on jmc.purchase_orders (created_by);

create table if not exists jmc.goods_receipts (
  id          text primary key,
  grn_number  text not null unique,
  supplier_id text not null references jmc.suppliers(id),
  purchase_order_id text references jmc.purchase_orders(id),
  supplier_invoice_number text not null default '',
  supplier_invoice_date   date,
  status      text not null check (status in ('posted', 'cancelled')),
  /*
   * The key that makes a retry safe.
   *
   * A receipt is the one screen in the pharmacy where a slow network and an
   * impatient thumb produce two of something expensive. The counter supplies
   * this; a second POST with the same key finds the first receipt and returns
   * it rather than adding the delivery twice.
   */
  idempotency_key text not null unique,
  subtotal  numeric(12,2) not null default 0 check (subtotal >= 0),
  tax_total numeric(12,2) not null default 0 check (tax_total >= 0),
  total     numeric(12,2) not null default 0 check (total >= 0),
  note        text not null default '',
  received_by text not null references jmc.staff(id),
  received_at timestamptz not null default now(),
  cancelled_by text references jmc.staff(id),
  cancelled_at timestamptz,
  cancellation_reason text not null default '',
  constraint goods_receipts_cancelled_completely
    check ((status = 'cancelled') = (cancelled_by is not null and cancelled_at is not null))
);

create index if not exists goods_receipts_supplier_idx on jmc.goods_receipts (supplier_id, received_at desc);
create index if not exists goods_receipts_order_idx on jmc.goods_receipts (purchase_order_id);
create index if not exists goods_receipts_received_by_idx on jmc.goods_receipts (received_by);
create index if not exists goods_receipts_cancelled_by_idx on jmc.goods_receipts (cancelled_by);

create table if not exists jmc.goods_receipt_lines (
  id text primary key,
  goods_receipt_id text not null references jmc.goods_receipts(id),
  line_number integer not null check (line_number > 0),
  purchase_order_line_id text references jmc.purchase_order_lines(id),
  medicine_id text not null references jmc.medicines(id),
  package_version_id text not null references jmc.package_versions(id),

  -- The physical entry, preserved. [{"levelName":"box","count":2,"baseFactor":150}, ...]
  entry_json jsonb not null,

  accepted_base_quantity    bigint not null check (accepted_base_quantity >= 0),
  free_base_quantity        bigint not null default 0 check (free_base_quantity >= 0),
  quarantined_base_quantity bigint not null default 0 check (quarantined_base_quantity >= 0),
  rejected_base_quantity    bigint not null default 0 check (rejected_base_quantity >= 0),
  rejection_reason text not null default '',

  batch_number text not null check (length(trim(batch_number)) > 0),
  expiry date not null,

  -- Price with its basis, never a naked number. "₹30 per strip of 15".
  mrp_amount numeric(12,2) not null check (mrp_amount >= 0),
  mrp_basis_level text not null check (length(trim(mrp_basis_level)) > 0),
  mrp_basis_factor bigint not null check (mrp_basis_factor > 0),
  purchase_amount numeric(12,2) not null check (purchase_amount >= 0),
  purchase_basis_level text not null check (length(trim(purchase_basis_level)) > 0),
  purchase_basis_factor bigint not null check (purchase_basis_factor > 0),

  tax_rate  numeric(6,3) not null default 0 check (tax_rate >= 0 and tax_rate <= 100),
  tax_amount numeric(12,2) not null default 0 check (tax_amount >= 0),
  line_total numeric(12,2) not null default 0 check (line_total >= 0),

  batch_id text references jmc.batches(id),

  unique (goods_receipt_id, line_number),
  -- Something has to have arrived, or the line is paperwork about nothing.
  constraint goods_receipt_lines_not_empty
    check (accepted_base_quantity + free_base_quantity
           + quarantined_base_quantity + rejected_base_quantity > 0),
  constraint goods_receipt_lines_rejection_explained
    check (rejected_base_quantity = 0 or length(trim(rejection_reason)) > 0)
);

create index if not exists goods_receipt_lines_receipt_idx on jmc.goods_receipt_lines (goods_receipt_id, line_number);
create index if not exists goods_receipt_lines_medicine_idx on jmc.goods_receipt_lines (medicine_id);
create index if not exists goods_receipt_lines_batch_idx on jmc.goods_receipt_lines (batch_id);
create index if not exists goods_receipt_lines_order_line_idx on jmc.goods_receipt_lines (purchase_order_line_id);
create index if not exists goods_receipt_lines_package_version_idx on jmc.goods_receipt_lines (package_version_id);

create sequence if not exists jmc.goods_receipt_seq;


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. THE BLIND OPENING COUNT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Policy register 14 and approval pack §9. The pharmacist counts without
-- seeing what the software expects; the admin reviews the variances; approved
-- differences post as append-only opening adjustments.
--
-- Blindness is structural, not a UI promise: `expected_base_quantity` is NULL
-- on every entry until the count is submitted, so the number does not exist to
-- be leaked by a snapshot, a report or a curious developer.

create table if not exists jmc.opening_counts (
  id        text primary key,
  reference text not null unique,
  status    text not null check (status in ('counting', 'submitted', 'recount', 'approved', 'abandoned')),
  -- Sales and receipts after this moment are reconciled separately; approval
  -- pack §9 closing note.
  cutoff_at timestamptz not null,
  note      text not null default '',
  started_by text not null references jmc.staff(id),
  started_at timestamptz not null default now(),
  submitted_by text references jmc.staff(id),
  submitted_at timestamptz,
  approved_by  text references jmc.staff(id),
  approved_at  timestamptz,
  abandoned_by text references jmc.staff(id),
  abandoned_at timestamptz,
  constraint opening_counts_approved_completely
    check ((status = 'approved') = (approved_by is not null and approved_at is not null)),
  constraint opening_counts_abandoned_completely
    check ((status = 'abandoned') = (abandoned_by is not null and abandoned_at is not null))
);

-- Two open counts is two people counting the same shelf into two sheets.
create unique index if not exists opening_counts_one_open
  on jmc.opening_counts ((1)) where status in ('counting', 'submitted', 'recount');

create index if not exists opening_counts_started_by_idx on jmc.opening_counts (started_by);
create index if not exists opening_counts_submitted_by_idx on jmc.opening_counts (submitted_by);
create index if not exists opening_counts_approved_by_idx on jmc.opening_counts (approved_by);
create index if not exists opening_counts_abandoned_by_idx on jmc.opening_counts (abandoned_by);

create table if not exists jmc.opening_count_entries (
  id text primary key,
  opening_count_id text not null references jmc.opening_counts(id),
  batch_id    text not null references jmc.batches(id),
  medicine_id text not null references jmc.medicines(id),
  attempt     integer not null default 1 check (attempt > 0),

  -- The physical entry, kept. The converted total is what reconciles.
  entry_json  jsonb not null,
  counted_base_quantity bigint not null check (counted_base_quantity >= 0),
  counted_by  text not null references jmc.staff(id),
  counted_at  timestamptz not null default now(),

  -- Written at submit, never before. NULL here is what "blind" means.
  expected_base_quantity bigint,
  variance       bigint,
  variance_value numeric(12,2),

  resolution text not null default 'pending'
    check (resolution in ('pending', 'approved', 'recount_requested', 'rejected')),
  reviewed_by text references jmc.staff(id),
  reviewed_at timestamptz,
  review_note text not null default '',

  unique (opening_count_id, batch_id, attempt),
  constraint opening_count_entries_reviewed_completely
    check ((resolution = 'pending') = (reviewed_by is null and reviewed_at is null))
);

create index if not exists opening_count_entries_count_idx
  on jmc.opening_count_entries (opening_count_id, attempt desc);
create index if not exists opening_count_entries_batch_idx on jmc.opening_count_entries (batch_id);
create index if not exists opening_count_entries_medicine_idx on jmc.opening_count_entries (medicine_id);
create index if not exists opening_count_entries_counted_by_idx on jmc.opening_count_entries (counted_by);
create index if not exists opening_count_entries_reviewed_by_idx on jmc.opening_count_entries (reviewed_by);

create sequence if not exists jmc.opening_count_seq;


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. WHAT THE SHELF SAYS, AND WHETHER IT AGREES WITH THE LEDGER
-- ═══════════════════════════════════════════════════════════════════════════

-- A batch and whether it may be picked from. One place, so the dispensing
-- code, the OTC code and the screen cannot disagree about what "available"
-- means. Expiry is compared in clinic time: the server runs five and a half
-- hours behind Chennai, and a batch that expired last night must not stay
-- sellable through the morning the pharmacy is opened up.
create or replace view jmc.batch_availability
with (security_invoker = true) as
select
  b.id,
  b.medicine_id,
  b.batch_number,
  b.expiry,
  b.available_quantity,
  b.quarantined_quantity,
  b.blocked_quantity,
  b.status,
  b.package_version_id,
  b.package_snapshot,
  b.base_unit,
  b.mrp,
  b.mrp_basis_level,
  b.mrp_basis_factor,
  b.purchase_price,
  b.purchase_basis_level,
  b.purchase_basis_factor,
  b.selling_price,
  (b.expiry::date < (now() at time zone 'Asia/Kolkata')::date) as expired,
  (
    b.status = 'active'
    and b.available_quantity > 0
    and b.expiry::date >= (now() at time zone 'Asia/Kolkata')::date
  ) as pickable
from jmc.batches b;

-- The reconciliation the brief asks for: cached balances must always be
-- reconcilable to the ledger. A test asserts every row of this reads zero.
create or replace view jmc.batch_ledger_reconciliation
with (security_invoker = true) as
select
  b.id as batch_id,
  b.medicine_id,
  b.available_quantity,
  coalesce(m.available_ledger, 0)   as available_ledger,
  b.quarantined_quantity,
  coalesce(m.quarantine_ledger, 0)  as quarantine_ledger,
  b.blocked_quantity,
  coalesce(m.blocked_ledger, 0)     as blocked_ledger,
  b.available_quantity   - coalesce(m.available_ledger, 0)  as available_drift,
  b.quarantined_quantity - coalesce(m.quarantine_ledger, 0) as quarantine_drift,
  b.blocked_quantity     - coalesce(m.blocked_ledger, 0)    as blocked_drift
from jmc.batches b
left join lateral (
  select
    sum(case when bucket = 'available'  then quantity_delta else 0 end) as available_ledger,
    sum(case when bucket = 'quarantine' then quantity_delta else 0 end) as quarantine_ledger,
    sum(case when bucket = 'blocked'    then quantity_delta else 0 end) as blocked_ledger
  from jmc.stock_movements where batch_id = b.id
) m on true;

-- Combined stock per medicine, in base units, with the per-batch decomposition
-- left to the caller: each batch decomposes using ITS OWN snapshot, so a
-- single "boxes and strips" figure across batches of different pack sizes
-- would be a lie the moment a pack size changes.
create or replace view jmc.medicine_stock
with (security_invoker = true) as
select
  m.id as medicine_id,
  coalesce(nullif(m.base_unit, ''), m.unit) as base_unit,
  coalesce(sum(a.available_quantity) filter (where a.pickable), 0)::bigint as sellable_base_quantity,
  coalesce(sum(a.available_quantity) filter (where a.status = 'active' and not a.expired), 0)::bigint
    as active_base_quantity,
  coalesce(sum(a.available_quantity) filter (where a.expired), 0)::bigint  as expired_base_quantity,
  coalesce(sum(a.quarantined_quantity), 0)::bigint                          as quarantined_base_quantity,
  coalesce(sum(a.blocked_quantity), 0)::bigint                              as blocked_base_quantity,
  coalesce(sum(a.available_quantity) filter (where a.status <> 'active'), 0)::bigint
    as unavailable_base_quantity,
  min(a.expiry) filter (where a.pickable) as earliest_pickable_expiry
from jmc.medicines m
left join jmc.batch_availability a on a.medicine_id = m.id
group by m.id, coalesce(nullif(m.base_unit, ''), m.unit);


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. ACCESS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Same posture as the other forty-two tables: row security enabled and never
-- forced, no grant to anon/authenticated/service_role/PUBLIC, and staff
-- authorization enforced in the authenticated Edge Function boundary — the
-- only layer that is told who is asking. §7 of docs/SCHEMA_AND_TYPES.md sets
-- out why a `using (true)` policy would be theatre.

do $$
declare t text;
begin
  foreach t in array array[
    'substances', 'clinical_drugs', 'clinical_drug_ingredients',
    'package_versions', 'package_levels', 'medicine_barcodes', 'unmapped_barcodes',
    'goods_receipts', 'goods_receipt_lines',
    'opening_counts', 'opening_count_entries'
  ] loop
    execute format('alter table jmc.%I enable row level security', t);
    execute format('alter table jmc.%I no force row level security', t);
    execute format('revoke all on table jmc.%I from public, anon, authenticated, service_role', t);
  end loop;
end $$;

revoke all on jmc.medicine_active_package, jmc.batch_availability,
              jmc.batch_ledger_reconciliation, jmc.medicine_stock
  from public, anon, authenticated, service_role;

revoke all on sequence jmc.goods_receipt_seq, jmc.opening_count_seq
  from public, anon, authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 11. THE STOCK THAT IS ALREADY ON THE SHELF
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Existing batches have no package version, because none existed. They are NOT
-- given one: inventing "this arrived in strips of fifteen" for a batch nobody
-- counted that way is precisely the guess Slice 2.1 was written to stop making,
-- and it would be frozen onto the batch by the trigger above.
--
-- What they do get is a base unit, taken from the product's existing `unit`
-- column — which is the unit `available_quantity` has always been counted in,
-- so it is a restatement rather than a decision.
--
-- The result is a shelf that reads correctly in base units from day one and a
-- report that says which batches cannot yet be decomposed into boxes and
-- strips. That report is the opening-count worklist.

update jmc.batches b
   set base_unit = coalesce(nullif(m.unit, ''), 'unit')
  from jmc.medicines m
 where m.id = b.medicine_id and b.base_unit = '';

update jmc.medicines
   set base_unit = coalesce(nullif(unit, ''), 'unit')
 where base_unit = '';

-- Every movement recorded before buckets existed moved sellable stock, which
-- the column default already says. This is the assertion, not a change: if the
-- default did not take, the reconciliation view would read non-zero on every
-- batch and Slice 4 would allocate against a number nothing supports.
do $$
declare drifted integer;
begin
  select count(*) into drifted from jmc.batch_ledger_reconciliation
   where available_drift <> 0 or quarantine_drift <> 0 or blocked_drift <> 0;
  if drifted > 0 then
    raise warning
      '% batch(es) do not reconcile to the stock ledger. This migration did not cause it — see jmc.batch_ledger_reconciliation — but the opening count must resolve it before Slice 4 allocates against these figures.',
      drifted;
  end if;
end $$;
