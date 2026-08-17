-- M3 — reordering that learns, and still never acts alone (INVENTORY.md §8).
--
-- Two properties matter here and they pull against each other. The numbers have
-- to be good enough that the doctor trusts them, and nothing may ever turn one
-- of them into an order by itself (PLAN.md §5.3 rule 4). So: the arithmetic is
-- tested, and so is the absence of a path from a suggestion to a sent order.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('caaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Test Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-0000000000a1', 'Dr Rao', 'doctor',
   'a0000000-0000-0000-0000-0000000000a1'),
  ('50000000-0000-0000-0000-0000000000a2', 'Latha', 'counter',
   'a0000000-0000-0000-0000-0000000000a2');

insert into suppliers (id, name, lead_time_days) values
  -- Claims two days. Actually takes about six, and is wildly inconsistent.
  ('50990000-0000-0000-0000-0000000000a1', 'Kumar Distributors', 2),
  ('50990000-0000-0000-0000-0000000000a2', 'Reddy Pharma',       4);

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule,
                   default_units_per_strip, default_strips_per_box,
                   default_supplier_id, reorder_level_base, reorder_qty_base) values
  ('d0000000-0000-0000-0000-0000000000a1', 'Dolo 650', 'Paracetamol', '650mg',
   'tablet', 'tablet', 'OTC', 15, 10, '50990000-0000-0000-0000-0000000000a1', 300, 900),
  -- Never moved, no stock, and a manual reorder level: the day-one case, before
  -- the ledger has anything to say.
  ('d0000000-0000-0000-0000-0000000000a2', 'Calpol 650', 'Paracetamol', '650mg',
   'tablet', 'tablet', 'OTC', 15, 10, '50990000-0000-0000-0000-0000000000a2', 150, 450);

insert into stock_batches
  (id, drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp, mrp_basis,
   cost_per_base_unit, qty_base_received, qty_base_on_hand, supplier_id)
values
  ('b0000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-0000000000a1',
   'DL1', current_date + 300, 15, 10, 34.50, 'strip', 1.90, 1000, 100,
   '50990000-0000-0000-0000-0000000000a1');

insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id, at)
values ('d0000000-0000-0000-0000-0000000000a1', 'b0000000-0000-0000-0000-0000000000a1',
        1000, 'receipt', '50000000-0000-0000-0000-0000000000a2', now() - interval '40 days');

-- 900 units out over the last 30 days: 30 a day, exactly.
insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id, at)
select 'd0000000-0000-0000-0000-0000000000a1', 'b0000000-0000-0000-0000-0000000000a1',
       -30, 'dispense', '50000000-0000-0000-0000-0000000000a2',
       now() - (n || ' days')::interval
from generate_series(1, 30) as n;

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000a1', true);

-- ---------------------------------------------------------------------------
-- Velocity, and what does not count as demand.
-- ---------------------------------------------------------------------------
select is(
  (select per_day_30 from consumption_velocity where drug_name = 'Dolo 650'),
  30.000::numeric,
  'thirty a day for thirty days is thirty a day'
);

insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id, reason)
values ('d0000000-0000-0000-0000-0000000000a1', 'b0000000-0000-0000-0000-0000000000a1',
        -50, 'writeoff_expiry', '50000000-0000-0000-0000-0000000000a2', 'expired');

select is(
  (select per_day_30 from consumption_velocity where drug_name = 'Dolo 650'),
  30.000::numeric,
  'and a write-off is not demand — counting it would reorder exactly what nobody wanted'
);

-- ---------------------------------------------------------------------------
-- Lead time: measured, or honest about not being.
-- ---------------------------------------------------------------------------
select is(
  (select source from supplier_lead_time where supplier_name = 'Kumar Distributors'),
  'claimed',
  'with no purchase orders yet, the supplier''s own claim is used and labelled as a claim'
);

-- Three orders, sent and received: 4 days, 6 days, 8 days.
insert into purchase_orders (id, supplier_id, status, created_by, sent_at) values
  ('90000000-0000-0000-0000-0000000000a1', '50990000-0000-0000-0000-0000000000a1',
   'sent', '50000000-0000-0000-0000-0000000000a1', now() - interval '30 days'),
  ('90000000-0000-0000-0000-0000000000a2', '50990000-0000-0000-0000-0000000000a1',
   'sent', '50000000-0000-0000-0000-0000000000a1', now() - interval '20 days'),
  ('90000000-0000-0000-0000-0000000000a3', '50990000-0000-0000-0000-0000000000a1',
   'sent', '50000000-0000-0000-0000-0000000000a1', now() - interval '10 days');

insert into goods_receipts (supplier_id, po_id, invoice_no, received_by, received_at) values
  ('50990000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-0000000000a1',
   'INV-1', '50000000-0000-0000-0000-0000000000a2', now() - interval '26 days'),
  ('50990000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-0000000000a2',
   'INV-2', '50000000-0000-0000-0000-0000000000a2', now() - interval '14 days'),
  ('50990000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-0000000000a3',
   'INV-3', '50000000-0000-0000-0000-0000000000a2', now() - interval '2 days');

select is(
  (select source from supplier_lead_time where supplier_name = 'Kumar Distributors'),
  'measured',
  'three real deliveries later, the measurement replaces the claim'
);

select is(
  (select measured_days from supplier_lead_time where supplier_name = 'Kumar Distributors'),
  6.0::numeric,
  'and it is six days, not the two he says on the phone'
);

select is(
  (select buffer_days from supplier_lead_time where supplier_name = 'Kumar Distributors'),
  2,
  'the buffer is sized from his own inconsistency, not a flat multiplier for everyone'
);

-- ---------------------------------------------------------------------------
-- The suggestion.
-- ---------------------------------------------------------------------------
-- 30/day, 6 days lead, 2 days buffer, 30 days cover = 1140 wanted, 100 on hand.
select is(
  (select suggested_qty_base from reorder_suggestions where drug_name = 'Dolo 650'),
  1040,
  'the suggestion is the gap between what will be needed and what is on the shelf'
);

select is(
  (select days_of_cover_left from reorder_suggestions where drug_name = 'Dolo 650'),
  3,
  'and it says how long the shelf lasts, which is the number that makes it urgent'
);

select alike(
  (select basis from reorder_suggestions where drug_name = 'Dolo 650'),
  '%measured%',
  'the reason is shown beside the number — a proposal nobody can argue with is one nobody corrects'
);

select is(
  (select suggested_qty_base from reorder_suggestions where drug_name = 'Calpol 650'),
  450,
  'a drug with no movement yet falls back to the manual reorder quantity (PLAN.md §12.4)'
);

select alike(
  (select basis from reorder_suggestions where drug_name = 'Calpol 650'),
  '%no movement recorded yet%',
  'and says that is what it is doing'
);

-- ---------------------------------------------------------------------------
-- Stockouts.
-- ---------------------------------------------------------------------------
select is(
  (select coalesce(times_at_zero, 0) from stockout_history
   where drug_id = 'd0000000-0000-0000-0000-0000000000a1'),
  0,
  'a shelf that never emptied has no stockout history'
);

insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id)
values ('d0000000-0000-0000-0000-0000000000a1', 'b0000000-0000-0000-0000-0000000000a1',
        -50, 'dispense', '50000000-0000-0000-0000-0000000000a2');

select is(
  (select times_at_zero from stockout_history
   where drug_id = 'd0000000-0000-0000-0000-0000000000a1'),
  1,
  'and one that did has one, counted as a crossing rather than as days spent empty'
);

-- ---------------------------------------------------------------------------
-- Price history — the number he needs at the moment he can act on it.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from supplier_price_history
   where drug_id = 'd0000000-0000-0000-0000-0000000000a1'),
  0,
  'nothing has been bought through a GRN yet, so there is no price history to show'
);

select lives_ok(
  $$ select app.receive_goods(
       '[{"drug_id": "d0000000-0000-0000-0000-0000000000a1", "batch_no": "DL9",
          "expiry": "2027-10-01", "units_per_strip": 15, "strips_per_box": 10,
          "mrp": 34.50, "cost_per_base_unit": 2.10, "qty_packs": 10}]'::jsonb,
       '50990000-0000-0000-0000-0000000000a1', 'INV-9', current_date) $$,
  'goods arrive'
);

select is(
  (select cost_per_base_unit from supplier_price_history
   where drug_id = 'd0000000-0000-0000-0000-0000000000a1' and purchase_no = 1),
  2.1000::numeric,
  'and the price paid is on the record, per drug per supplier, ready for the next order'
);

-- ---------------------------------------------------------------------------
-- Rule 4. This is the assertion the whole section is held to.
-- ---------------------------------------------------------------------------
select is(
  (select app.draft_purchase_orders(
     '[{"drug_id": "d0000000-0000-0000-0000-0000000000a1",
        "supplier_id": "50990000-0000-0000-0000-0000000000a1",
        "qty_base": 1040, "suggested_qty_base": 1040,
        "expected_cost_per_base_unit": 2.10},
       {"drug_id": "d0000000-0000-0000-0000-0000000000a2",
        "supplier_id": "50990000-0000-0000-0000-0000000000a2",
        "qty_base": 450, "suggested_qty_base": 450}]'::jsonb)),
  2,
  'two suppliers, two orders — one order per supplier however the lines arrive'
);

select is(
  (select count(*)::int from purchase_orders
   where status <> 'draft' and created_by = '50000000-0000-0000-0000-0000000000a1'
     and sent_at is null),
  0,
  'and everything this created is a draft'
);

-- Updated in M5, which added the send. The claim being guarded was never "no
-- function may touch a purchase order" — it is that the function turning
-- SUGGESTIONS into orders has no path to sending one. Sending is a separate
-- transition and it demands the doctor; app.send_purchase_order's own refusal
-- is asserted in A1_purchasing.sql.
select is(
  (select count(*)::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app'
     and p.proname = 'draft_purchase_orders'
     and p.prosrc like '%''sent''%'),
  0,
  'nothing in the drafting path can send an order — that is a second, deliberate act by a person (rule 4)'
);

select results_eq(
  $$ select qty_base, suggested_qty_base from po_lines
     where drug_id = 'd0000000-0000-0000-0000-0000000000a1' $$,
  $$ values (1040, 1040) $$,
  'the line keeps what was suggested beside what was ordered, so the suggestion can be judged later'
);

select is(
  (select estimated_total from purchase_orders
   where supplier_id = '50990000-0000-0000-0000-0000000000a1' and status = 'draft'),
  2184.00::numeric,
  'valued at the last price actually paid'
);

select throws_ok(
  $$ select app.draft_purchase_orders('[{"drug_id": "d0000000-0000-0000-0000-0000000000a1",
       "supplier_id": "50990000-0000-0000-0000-0000000000a1", "qty_base": 0}]'::jsonb) $$,
  'CL006',
  null,
  'an order line has to order something'
);

set local role authenticated;

select throws_ok(
  $$ update purchase_orders set status = 'sent', sent_at = now() $$,
  '42501',
  null,
  'and no screen can send one with a direct write either'
);

reset role;

select * from finish();
rollback;
