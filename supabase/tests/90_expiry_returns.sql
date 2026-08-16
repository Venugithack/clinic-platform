-- M3 — expiry worked all the way through (INVENTORY.md §6).
--
-- The property under test is the one that costs real money: the date that
-- decides whether stock can go back to the supplier is NOT the expiry date. It
-- is `expiry - return_window_days`, it differs per supplier, and it passes
-- while the stock still looks perfectly fine on the shelf.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('c9999999-9999-9999-9999-999999999999', 'Test Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-0000000000e1', 'Dr Rao', 'doctor',
   'a0000000-0000-0000-0000-0000000000e1'),
  ('50000000-0000-0000-0000-0000000000e2', 'Latha', 'counter',
   'a0000000-0000-0000-0000-0000000000e2');

-- Two suppliers, and the whole point is that their windows differ.
insert into suppliers (id, name, return_window_days) values
  ('50990000-0000-0000-0000-0000000000e1', 'Kumar Distributors', 180),
  ('50990000-0000-0000-0000-0000000000e2', 'Reddy Pharma',        90),
  -- No window recorded at all. Not "no limit" — not knowing.
  ('50990000-0000-0000-0000-0000000000e3', 'Unknown Terms Ltd',  null);

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule) values
  ('d0000000-0000-0000-0000-0000000000e1', 'Zincovit', 'Multivitamin', '—',
   'tablet', 'tablet', 'OTC'),
  ('d0000000-0000-0000-0000-0000000000e2', 'Shelcal 500', 'Calcium Carbonate', '500mg',
   'tablet', 'tablet', 'OTC'),
  ('d0000000-0000-0000-0000-0000000000e3', 'Betadine', 'Povidone Iodine', '5%',
   'ointment', 'piece', 'OTC');

insert into stock_batches
  (id, drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp, mrp_basis,
   cost_per_base_unit, qty_base_received, qty_base_on_hand, supplier_id)
values
  -- Expires in 200 days. Kumar wants it back 180 days before that, so the door
  -- shuts in 20 days — long before anything would call this "expiring soon".
  ('b0000000-0000-0000-0000-0000000000e1', 'd0000000-0000-0000-0000-0000000000e2',
   'SC1', current_date + 200, 15, 10, 112.00, 'strip', 6.00, 300, 300,
   '50990000-0000-0000-0000-0000000000e1'),
  -- Expires in 45 days and is still perfectly good, but Kumar's window closed
  -- 135 days ago. Pure loss, and nobody was told.
  ('b0000000-0000-0000-0000-0000000000e2', 'd0000000-0000-0000-0000-0000000000e1',
   'ZV1', current_date + 45, 15, 10, 98.00, 'strip', 5.00, 150, 150,
   '50990000-0000-0000-0000-0000000000e1'),
  -- Already expired: excluded from availability, and therefore invisible unless
  -- something goes looking for it.
  ('b0000000-0000-0000-0000-0000000000e3', 'd0000000-0000-0000-0000-0000000000e3',
   'BD1', current_date - 40, 1, 1, 148.00, 'strip', 90.00, 12, 12,
   '50990000-0000-0000-0000-0000000000e1'),
  -- Same 200-day expiry, different supplier: Reddy's shorter window means this
  -- one is returnable for another 110 days. Same stock, different deadline.
  ('b0000000-0000-0000-0000-0000000000e4', 'd0000000-0000-0000-0000-0000000000e2',
   'SC2', current_date + 200, 15, 10, 112.00, 'strip', 6.00, 100, 100,
   '50990000-0000-0000-0000-0000000000e2');

insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id)
select b.drug_id, b.id, b.qty_base_received, 'receipt', '50000000-0000-0000-0000-0000000000e2'
from stock_batches b;

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000e2', true);

-- ---------------------------------------------------------------------------
-- The list, and why it is not an expiry list.
-- ---------------------------------------------------------------------------
select is(
  (select days_to_return_by from expiring_soon where batch_no = 'SC1'),
  20,
  'the deadline is expiry minus the supplier''s window, not the expiry'
);

select ok(
  (select returnable from expiring_soon where batch_no = 'SC1'),
  'and with 20 days left it is still returnable'
);

select is(
  (select count(*)::int from expiring_soon where batch_no = 'SC2'),
  0,
  'the same stock from a shorter-window supplier is not urgent yet, and is not on the list'
);

select ok(
  not (select returnable from expiring_soon where batch_no = 'ZV1'),
  'stock 45 days from expiry can be perfectly good and no longer returnable'
);

select is(
  (select count(*)::int from expiring_soon where batch_no = 'BD1'),
  0,
  'expired stock is not "expiring soon" — it is a different list and a different decision'
);

select is(
  (select value_at_cost from expired_stock where batch_no = 'BD1'),
  1080.00::numeric,
  'and it is on that one, valued at what it cost'
);

select is(
  (select count(*)::int from available_stock where batch_id = 'b0000000-0000-0000-0000-0000000000e3'),
  0,
  'while still being excluded from availability entirely (INVENTORY.md §3)'
);

-- ---------------------------------------------------------------------------
-- Returning, and the refusal that is the whole point.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.return_to_supplier(
       '[{"batch_id": "b0000000-0000-0000-0000-0000000000e2"}]'::jsonb,
       '50990000-0000-0000-0000-0000000000e1') $$,
  'CL016',
  null,
  'a return after the window closed is refused — that stock is a write-off now, and saying so is the point'
);

select throws_ok(
  $$ select app.return_to_supplier(
       '[{"batch_id": "b0000000-0000-0000-0000-0000000000e1"}]'::jsonb,
       '50990000-0000-0000-0000-0000000000e3') $$,
  'CL016',
  null,
  'and a supplier with no recorded window is "we do not know", not "any time"'
);

select throws_ok(
  $$ select app.return_to_supplier(
       '[{"batch_id": "b0000000-0000-0000-0000-0000000000e1"}]'::jsonb,
       '50990000-0000-0000-0000-0000000000e2') $$,
  'CL006',
  null,
  'stock cannot be returned to a supplier it never came from'
);

select throws_ok(
  $$ select app.return_to_supplier(
       '[{"batch_id": "b0000000-0000-0000-0000-0000000000e1", "qty_base": 500}]'::jsonb,
       '50990000-0000-0000-0000-0000000000e1') $$,
  'CL001',
  null,
  'and a return cannot send back more than is on the shelf, any more than a sale can'
);

create temporary table t_return as
select * from app.return_to_supplier(
  '[{"batch_id": "b0000000-0000-0000-0000-0000000000e1", "qty_base": 150}]'::jsonb,
  '50990000-0000-0000-0000-0000000000e1',
  'half the Shelcal, window closing');

select is(
  (select total_at_cost from t_return),
  900.00::numeric,
  'the return note is valued at cost, not MRP — it is a credit, not a sale'
);

select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'SC1'),
  150,
  'the stock left the shelf'
);

select is(
  (select qty_base from stock_movements
   where batch_id = 'b0000000-0000-0000-0000-0000000000e1' and type = 'return_out'),
  -150,
  'through the ledger, as a return_out — not by editing the number'
);

select is_empty(
  $$ select * from stock_cache_drift $$,
  'and rule 3 survives a return'
);

select is(
  (select outstanding from open_supplier_credits
   where return_id = (select id from t_return)),
  900.00::numeric,
  'the credit is opened in the same transaction — a return note without one is how a clinic forgets it is owed money'
);

-- ---------------------------------------------------------------------------
-- Writing off, and the refusal that stops good stock being destroyed.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.write_off_expired(
       '[{"batch_id": "b0000000-0000-0000-0000-0000000000e2"}]'::jsonb) $$,
  'CL017',
  null,
  'stock that has not expired cannot be written off as expiry — it has two better outcomes'
);

select is(
  (select app.write_off_expired(
     '[{"batch_id": "b0000000-0000-0000-0000-0000000000e3"}]'::jsonb,
     'expired, destroyed on site')),
  1080.00::numeric,
  'expired stock is written off at cost, and the transition returns what it cost him'
);

select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'BD1'),
  0,
  'the cupboard is empty of it'
);

select is(
  (select count(*)::int from stock_movements where type = 'writeoff_expiry'),
  1,
  'one writeoff_expiry movement, carrying its reason'
);

select is_empty(
  $$ select * from expired_stock $$,
  'and the write-off queue is clear'
);

-- ---------------------------------------------------------------------------
-- The credit, reconciled against a later invoice.
-- ---------------------------------------------------------------------------
create temporary table t_grn as
select * from app.receive_goods(
  '[{"drug_id": "d0000000-0000-0000-0000-0000000000e2", "batch_no": "SC3",
     "expiry": "2027-12-01", "units_per_strip": 15, "strips_per_box": 10,
     "mrp": 112.00, "cost_per_base_unit": 6.00, "qty_packs": 10}]'::jsonb,
  '50990000-0000-0000-0000-0000000000e1', 'INV-9001', current_date);

select throws_ok(
  format($$ select app.settle_credit(%L, %L, 2000.00) $$,
         (select credit_id from open_supplier_credits limit 1),
         (select id from t_grn)),
  'CL018',
  null,
  'a credit cannot be settled for more than it is worth — that is a typo or the wrong credit'
);

select is(
  (select amount_settled from app.settle_credit(
     (select credit_id from open_supplier_credits limit 1),
     (select id from t_grn),
     400.00)),
  400.00::numeric,
  'partial settlement is the normal case: one credit comes off several invoices'
);

select is(
  (select outstanding from open_supplier_credits limit 1),
  500.00::numeric,
  'and what is left is still visible, which is the difference between a credit and a favour'
);

select is(
  (select status::text from supplier_credits
   where id = (select credit_id from open_supplier_credits limit 1)),
  'open',
  'a partly-settled credit is still open'
);

select lives_ok(
  $$ select app.settle_credit(
       (select credit_id from open_supplier_credits limit 1),
       (select id from t_grn),
       500.00) $$,
  'the rest comes off the next invoice'
);

select is_empty(
  $$ select * from open_supplier_credits $$,
  'and then it is settled, and stops being chased'
);

-- ---------------------------------------------------------------------------
-- Transition-owned, like everything else that moves stock or money.
-- ---------------------------------------------------------------------------
set local role authenticated;

select throws_ok(
  $$ insert into supplier_credits (supplier_id, amount_expected)
     values ('50990000-0000-0000-0000-0000000000e1', 5000) $$,
  '42501',
  null,
  'a credit cannot be invented by a direct write'
);

select throws_ok(
  $$ update supplier_returns set total_at_cost = 0 $$,
  '42501',
  null,
  'and a return note cannot be quietly revalued'
);

reset role;

select * from finish();
rollback;
