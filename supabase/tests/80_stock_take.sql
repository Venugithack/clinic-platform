-- M3 — the blind stock-take (INVENTORY.md §5).
--
-- The property under test: a stock-take that shows the expected number next to
-- the count field finds nothing. Blind has to be enforced, not requested.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('c8888888-8888-8888-8888-888888888888', 'Test Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-0000000000f1', 'Dr Rao', 'doctor',
   'a0000000-0000-0000-0000-0000000000f1'),
  ('50000000-0000-0000-0000-0000000000f2', 'Latha', 'counter',
   'a0000000-0000-0000-0000-0000000000f2');

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule) values
  ('d0000000-0000-0000-0000-0000000000f1', 'Dolo 650', 'Paracetamol', '650mg',
   'tablet', 'tablet', 'OTC'),
  ('d0000000-0000-0000-0000-0000000000f2', 'Thyronorm', 'Levothyroxine', '50mcg',
   'tablet', 'tablet', 'H');

insert into stock_batches
  (id, drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp, mrp_basis,
   cost_per_base_unit, qty_base_received, qty_base_on_hand)
values
  -- Cheap: a big count difference, very little money.
  ('b0000000-0000-0000-0000-0000000000f1', 'd0000000-0000-0000-0000-0000000000f1',
   'DL1', app.month_end(current_date + 300), 15, 10, 34.50, 'strip', 1.00, 500, 500),
  -- Expensive: a small count difference, real money.
  ('b0000000-0000-0000-0000-0000000000f2', 'd0000000-0000-0000-0000-0000000000f2',
   'TH1', app.month_end(current_date + 300), 30, 5, 900.00, 'strip', 60.00, 100, 100);

insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id)
select b.drug_id, b.id, b.qty_base_received, 'receipt', '50000000-0000-0000-0000-0000000000f2'
from stock_batches b;

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000f2', true);

-- ---------------------------------------------------------------------------
-- Counting.
-- ---------------------------------------------------------------------------
create temporary table t_take as
-- Threshold ₹100: enough that 22 rupees of Dolo passes and 300 rupees of
-- Thyronorm does not.
select * from app.start_stock_take('Full count', 100);

select is(
  (select status::text from t_take),
  'counting',
  'a stock-take opens in counting'
);

select throws_ok(
  $$ select app.start_stock_take('Another one') $$,
  'PT014',
  null,
  'two concurrent counts of the same shelf produce two answers and no way to choose'
);

-- 20 short on the cheap one (worth 20), 5 short on the expensive one (worth 300).
select lives_ok(
  $$ select app.count_batch((select id from t_take),
       'b0000000-0000-0000-0000-0000000000f1', 480) $$,
  'the counter counts a shelf'
);

select lives_ok(
  $$ select app.count_batch((select id from t_take),
       'b0000000-0000-0000-0000-0000000000f2', 95) $$,
  'and another'
);

-- The heart of it.
select is_empty(
  $$ select * from stock_take_variance where take_id = (select id from t_take) $$,
  'while counting, the variance report is empty — nobody can check their answer'
);

select lives_ok(
  $$ select app.count_batch((select id from t_take),
       'b0000000-0000-0000-0000-0000000000f1', 478) $$,
  'a recount during counting simply replaces the number'
);

select is_empty(
  $$ select * from stock_cache_drift $$,
  'and nothing has touched the ledger yet — a count in progress does not move stock'
);

-- ---------------------------------------------------------------------------
-- Variance, once counting is closed.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select app.submit_stock_take((select id from t_take)) $$,
  'the counter submits'
);

select results_eq(
  $$ select drug_name, variance_base, variance_value
     from stock_take_variance where take_id = (select id from t_take)
     order by abs(variance_value) desc $$,
  $$ values ('Thyronorm', -5, -300.00::numeric),
            ('Dolo 650', -22, -22.00::numeric) $$,
  'sorted by the value of the discrepancy, not its size — 5 missing Thyronorm outrank 22 missing Dolo'
);

select ok(
  (select needs_recount from stock_take_variance
   where take_id = (select id from t_take) and drug_name = 'Thyronorm'),
  '300 rupees missing is over the ₹100 threshold and goes back for a second count'
);

select ok(
  not (select needs_recount from stock_take_variance
       where take_id = (select id from t_take) and drug_name = 'Dolo 650'),
  '22 rupees is under it, and posts on the first count'
);

-- ---------------------------------------------------------------------------
-- Approval, and only then the ledger.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.approve_stock_take((select id from t_take)) $$,
  'PT005',
  null,
  'the counter cannot approve its own count'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000f1', true);

select throws_ok(
  $$ select app.approve_stock_take((select id from t_take)) $$,
  'PT015',
  null,
  'and the doctor cannot either, while a line over the threshold is uncounted'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000f2', true);

select lives_ok(
  $$ select app.count_batch((select id from t_take),
       'b0000000-0000-0000-0000-0000000000f2', 96) $$,
  'the second count comes in, and it disagrees with the first'
);

select is(
  (select variance_base from stock_take_variance
   where take_id = (select id from t_take) and drug_name = 'Thyronorm'),
  -4,
  'the recount is what counts — that is why it was asked for'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000f1', true);

select is(
  (select app.approve_stock_take((select id from t_take))),
  2,
  'the doctor approves, and two batches are adjusted'
);

select results_eq(
  $$ select batch_no, qty_base_on_hand from stock_batches
     where batch_no in ('DL1', 'TH1') order by batch_no $$,
  $$ values ('DL1', 478), ('TH1', 96) $$,
  'the shelf now says what was counted'
);

select is(
  (select count(*)::int from stock_movements where type = 'adjust'),
  2,
  'one adjust movement per batch, and not one before approval'
);

select is(
  (select count(*)::int from stock_movements
   where type = 'adjust' and reason like 'stock-take %'),
  2,
  'each carrying the stock-take id as its reason'
);

select is_empty(
  $$ select * from stock_cache_drift $$,
  'and rule 3 survives the adjustment'
);

select throws_ok(
  $$ select app.approve_stock_take((select id from t_take)) $$,
  'PT007',
  null,
  'an approved stock-take cannot be approved again'
);

-- ---------------------------------------------------------------------------
-- Blind, enforced rather than requested.
-- ---------------------------------------------------------------------------
set local role authenticated;

select throws_ok(
  $$ select system_qty_base from stock_take_lines limit 1 $$,
  '42501',
  null,
  'the counting role has no privilege on the expected quantity at all — a screen that decided to peek would get an error'
);

select lives_ok(
  $$ select counted_qty_base from stock_take_lines limit 1 $$,
  'while what it counted is readable, as it must be'
);

select throws_ok(
  $$ update stock_take_lines set counted_qty_base = 999 $$,
  '42501',
  null,
  'and a count cannot be edited by a direct write'
);

reset role;

select * from finish();
rollback;
