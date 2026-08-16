-- Schema invariants: the rules that are meant to hold for tables that have not
-- been written yet. These fail on the migration that breaks them, which is the
-- only moment they are cheap to fix.
begin;
select * from no_plan();

-- ---------------------------------------------------------------------------
-- RLS on every table, in the same migration that creates it (BUILD.md §1.4).
-- Retrofitted RLS is how a table ends up readable.
-- ---------------------------------------------------------------------------
select is_empty(
  $$ select c.relname
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and not c.relrowsecurity
       and c.relname <> 'schema_migrations' $$,
  'RLS is enabled on every table in public'
);

-- ---------------------------------------------------------------------------
-- INVENTORY.md §1 / PLAN.md §5.3 rule 9, as schema assertions.
--
-- Every stock number is in base units, and pack configuration lives on the
-- batch. If a later migration puts units_per_strip back on the drug, this is
-- the test that stops it — before any stock has been recorded against it.
-- ---------------------------------------------------------------------------
select is_empty(
  $$ select table_name || '.' || column_name
     from information_schema.columns
     where table_schema = 'public'
       and column_name in ('qty', 'quantity', 'qty_on_hand', 'qty_received') $$,
  'every quantity column is named qty_base, never qty (BUILD.md §1.4)'
);

select has_column('stock_batches', 'units_per_strip',
  'pack config lives on the batch: units_per_strip');
select has_column('stock_batches', 'strips_per_box',
  'pack config lives on the batch: strips_per_box');
select has_column('stock_batches', 'mrp',
  'MRP lives on the batch — it is printed per batch');
select has_column('stock_batches', 'cost_per_base_unit',
  'cost lives on the batch (INVENTORY.md §4)');

select hasnt_column('drugs', 'units_per_strip',
  'the drug carries no authoritative pack config — only a default');
select hasnt_column('drugs', 'mrp',
  'the drug carries no MRP: one supplier changing a run would corrupt history');

select has_column('drugs', 'base_unit',
  'base_unit lives on the drug — it never changes');
select has_column('drugs', 'salt_composition',
  'salt is a structured field, not something inside the brand name (INVENTORY.md §7)');
select col_not_null('drugs', 'salt_composition',
  'salt is mandatory: substitution is a lookup, and it needs this');
select col_not_null('drugs', 'strength',
  'strength is mandatory for the same reason');

-- ---------------------------------------------------------------------------
-- Stock can never go negative — no override, no staff role. The transition
-- enforces it; this column check is the last line of defence behind it.
-- ---------------------------------------------------------------------------
select col_has_check('stock_batches', 'qty_base_on_hand',
  'a negative shelf is refused by the column, not only by the transition');

-- ---------------------------------------------------------------------------
-- Append-only: the ledger and the audit log. Corrections are compensating rows.
-- ---------------------------------------------------------------------------
select has_trigger('stock_movements', 'stock_movements_is_append_only',
  'the stock ledger is append-only');
select has_trigger('audit_log', 'audit_log_is_append_only',
  'the audit log is append-only');

-- ---------------------------------------------------------------------------
-- Availability excludes expired stock rather than flagging it (INVENTORY.md §3
-- — the conflation that let expired stock over the counter in the prototype).
-- ---------------------------------------------------------------------------
select has_view('available_stock', 'available_stock exists');
select has_view('stock_cache_drift', 'the rule-3 drift check exists');

select * from finish();
rollback;
