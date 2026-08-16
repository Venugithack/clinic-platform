-- M3 — goods receipt, and the two refusals that catch a mistyped year.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('c6666666-6666-6666-6666-666666666666', 'Test Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-0000000000e1', 'Latha', 'counter',
   'a0000000-0000-0000-0000-0000000000e1');

insert into suppliers (id, name) values
  ('50990000-0000-0000-0000-0000000000e1', 'Kumar Distributors');

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule,
                   default_units_per_strip, default_strips_per_box) values
  ('d0000000-0000-0000-0000-0000000000e1', 'Dolo 650', 'Paracetamol', '650mg',
   'tablet', 'tablet', 'OTC', 15, 10),
  ('d0000000-0000-0000-0000-0000000000e2', 'Cetzine', 'Cetirizine', '10mg',
   'tablet', 'tablet', 'OTC', 10, 10);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000e1', true);

-- ---------------------------------------------------------------------------
-- Packs in, base units stored (INVENTORY.md §1).
-- ---------------------------------------------------------------------------
create temporary table t_grn as
select * from app.receive_goods(
  jsonb_build_array(jsonb_build_object(
    'drug_id', 'd0000000-0000-0000-0000-0000000000e1',
    'batch_no', 'DL2601',
    'expiry', (current_date + 400)::text,
    'units_per_strip', 15, 'strips_per_box', 10,
    'mrp', 34.50, 'mrp_basis', 'strip',
    'cost_per_base_unit', 1.9,
    'qty_packs', 2, 'pack_basis', 'box')),
  '50990000-0000-0000-0000-0000000000e1',
  'INV-001', current_date);

-- The worked example from INVENTORY.md §1: 2 boxes in, 300 tablets recorded.
select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'DL2601'),
  300,
  '2 boxes of 10 strips of 15 arrive as 300 base units, not as "2"'
);

select is(
  (select units_per_strip from stock_batches where batch_no = 'DL2601'),
  15,
  'the pack configuration is recorded on the batch, not read off the drug'
);

select is(
  (select expiry from stock_batches where batch_no = 'DL2601'),
  app.month_end(current_date + 400),
  'a printed month is normalised to the last day it can be sold'
);

select is(
  (select sum(qty_base)::int from stock_movements where type = 'receipt'),
  300,
  'and the ledger says the same thing the cache does'
);

select is_empty(
  $$ select * from stock_cache_drift $$,
  'rule 3 holds through a receipt'
);

select is(
  (select count(*)::int from audit_log where action = 'receive_goods'),
  1,
  'receiving is audited'
);

-- ---------------------------------------------------------------------------
-- The refusals that exist to catch a typo (INVENTORY.md §3).
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.receive_goods(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd0000000-0000-0000-0000-0000000000e2',
         'batch_no', 'OLD1', 'expiry', (current_date - 90)::text,
         'mrp', 44.00, 'cost_per_base_unit', 3.6,
         'qty_packs', 1, 'pack_basis', 'box')),
       null, 'INV-002', current_date) $$,
  'CL011',
  null,
  'a batch that has already expired cannot be received — the year is wrong, or the stock should not be on the shelf'
);

-- Dispense some of the long-dated batch, so a later receipt has something to
-- be inconsistent with.
insert into patients (id, name) values
  ('60000000-0000-0000-0000-0000000000e1', 'Ravi Kumar');

select lives_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd0000000-0000-0000-0000-0000000000e1', 'qty_base', 15)),
       null, '60000000-0000-0000-0000-0000000000e1', true) $$,
  'the counter sells a strip out of the received batch'
);

select throws_ok(
  $$ select app.receive_goods(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd0000000-0000-0000-0000-0000000000e1',
         'batch_no', 'DL2501', 'expiry', (current_date + 40)::text,
         'units_per_strip', 15, 'strips_per_box', 10,
         'mrp', 34.50, 'cost_per_base_unit', 1.9,
         'qty_packs', 1, 'pack_basis', 'box')),
       null, 'INV-003', current_date) $$,
  'CL012',
  null,
  'a batch expiring earlier than one already dispensed against means FEFO was wrong then or the date is wrong now'
);

-- ---------------------------------------------------------------------------
-- Sold before received (INVENTORY.md §3). The stock is on the shelf and the
-- invoice is not in the system, which happens daily.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.receive_goods(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd0000000-0000-0000-0000-0000000000e2',
         'batch_no', 'CZ2601', 'expiry', (current_date + 300)::text,
         'mrp', 44.00, 'cost_per_base_unit', 3.6,
         'qty_packs', 1, 'pack_basis', 'box')),
       null, null, null) $$,
  'CL006',
  null,
  'a receipt without an invoice number has to say so deliberately'
);

create temporary table t_quick as
select * from app.receive_goods(
  jsonb_build_array(jsonb_build_object(
    'drug_id', 'd0000000-0000-0000-0000-0000000000e2',
    'batch_no', 'CZ2601', 'expiry', (current_date + 300)::text,
    'units_per_strip', 10, 'strips_per_box', 10,
    'mrp', 44.00, 'cost_per_base_unit', 3.6,
    'qty_packs', 1, 'pack_basis', 'box')),
  null, null, null, true, 'quick GRN at the counter');

select ok(
  (select awaiting_invoice from t_quick),
  'the quick GRN posts real stock and flags the paperwork as owed'
);

select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'CZ2601'),
  100,
  'and the stock is genuinely there — no negative shelf, no pretending'
);

-- ---------------------------------------------------------------------------
-- Free goods and weighted average cost (INVENTORY.md §4).
-- ---------------------------------------------------------------------------
create temporary table t_free as
select * from app.receive_goods(
  jsonb_build_array(jsonb_build_object(
    'drug_id', 'd0000000-0000-0000-0000-0000000000e2',
    'batch_no', 'CZ2602', 'expiry', (current_date + 300)::text,
    'units_per_strip', 10, 'strips_per_box', 10,
    'mrp', 44.00, 'cost_per_base_unit', 4.00,
    'qty_packs', 9, 'free_packs', 1, 'pack_basis', 'strip')),
  null, 'INV-004', current_date);

select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'CZ2602'),
  100,
  '9 strips bought plus 1 free is 100 units on the shelf'
);

select is(
  (select cost_per_base_unit from stock_batches where batch_no = 'CZ2602'),
  3.6000::numeric(12,4),
  'and the free strip dilutes the cost across all of it — 4.00 paid over 100 units is 3.60'
);

-- ---------------------------------------------------------------------------
-- Valuation (INVENTORY.md §4).
-- ---------------------------------------------------------------------------
select is(
  (select value_at_cost from stock_valuation
   where drug_name = 'Dolo 650'),
  round(285 * 1.9, 2)::numeric,
  'the shelf is worth what it cost, over the units still on it'
);

select is_empty(
  $$ select * from stock_cache_drift $$,
  'and rule 3 still holds after all of that'
);

-- ---------------------------------------------------------------------------
-- Transition-owned.
-- ---------------------------------------------------------------------------
set local role authenticated;

select throws_ok(
  $$ insert into goods_receipts (received_by) values ('50000000-0000-0000-0000-0000000000e1') $$,
  '42501',
  null,
  'stock cannot be received by a direct write'
);

reset role;

select * from finish();
rollback;
