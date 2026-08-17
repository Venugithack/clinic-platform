-- M5 — purchasing and the supplier send (PLAN.md §8, §10.4, §12.5).
--
-- Two properties carry this milestone.
--
-- The first is rule 4: an order is a financial commitment to somebody else, so
-- the doctor sends it and nothing else can.
--
-- The second is rule 5 and rule 6 together, and it is subtler. A deep link
-- means the app hands text to WhatsApp and never learns what happened next. So
-- the message row is written BEFORE the hand-off, and its status stops at
-- `handed_off` — the build does not get to claim a delivery it cannot observe.
begin;
select * from no_plan();

insert into clinic (id, name, consult_fee) values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Seed Clinic', 300);

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-0000000000c1', 'Dr Rao', 'doctor',
   'a0000000-0000-0000-0000-0000000000c1'),
  ('50000000-0000-0000-0000-0000000000c2', 'Latha', 'counter',
   'a0000000-0000-0000-0000-0000000000c2');

insert into suppliers (id, name, whatsapp_number, lead_time_days) values
  ('50990000-0000-0000-0000-0000000000c1', 'Kumar Distributors', '+919000000001', 2),
  -- No number recorded. Not a rare case: half a drug master arrives without one.
  ('50990000-0000-0000-0000-0000000000c2', 'Reddy Pharma', null, 4);

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule,
                   default_units_per_strip, default_strips_per_box,
                   default_supplier_id, reorder_level_base, reorder_qty_base) values
  ('d0000000-0000-0000-0000-0000000000c1', 'Dolo 650', 'Paracetamol', '650mg',
   'tablet', 'tablet', 'OTC', 15, 10, '50990000-0000-0000-0000-0000000000c1', 300, 900),
  ('d0000000-0000-0000-0000-0000000000c2', 'Cetzine', 'Cetirizine', '10mg',
   'tablet', 'tablet', 'OTC', 10, 10, '50990000-0000-0000-0000-0000000000c1', 100, 300);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000c2', true);

-- The counter drafts. That much it may do — a draft commits nothing.
select is(
  (select app.draft_purchase_orders(
     '[{"drug_id": "d0000000-0000-0000-0000-0000000000c1",
        "supplier_id": "50990000-0000-0000-0000-0000000000c1",
        "qty_base": 300, "suggested_qty_base": 300,
        "expected_cost_per_base_unit": 1.90}]'::jsonb)),
  1,
  'the counter can draft an order'
);

create temporary table t_po as
select id from purchase_orders where status = 'draft' limit 1;

select is(
  (select po_no from purchase_orders where id = (select id from t_po)),
  null,
  'a draft has no number — numbering an order nobody has sent burns references on orders that never existed'
);

-- ---------------------------------------------------------------------------
-- Editing, right up to the send and not past it.
-- ---------------------------------------------------------------------------
select is(
  (select app.set_po_lines((select id from t_po),
     '[{"drug_id": "d0000000-0000-0000-0000-0000000000c1", "qty_base": 300,
        "expected_cost_per_base_unit": 1.90},
       {"drug_id": "d0000000-0000-0000-0000-0000000000c2", "qty_base": 250,
        "expected_cost_per_base_unit": 2.60}]'::jsonb)),
  2,
  'quantities and lines are editable while it is a draft — pack sizes are a human judgement (§10.4)'
);

select is(
  (select estimated_total from purchase_orders where id = (select id from t_po)),
  1220.00::numeric,
  'and the estimate follows the edit'
);

-- ---------------------------------------------------------------------------
-- Rule 4: who is allowed to commit the clinic's money.
-- ---------------------------------------------------------------------------
select throws_ok(
  format($$ select * from app.send_purchase_order(%L) $$, (select id from t_po)),
  'CL005',
  null,
  'the counter cannot send it — one wrong reorder level is ten times the stock, paid for'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000c1', true);

-- ---------------------------------------------------------------------------
-- A supplier with no number.
-- ---------------------------------------------------------------------------
insert into purchase_orders (id, supplier_id, created_by)
values ('90000000-0000-0000-0000-0000000000c9',
        '50990000-0000-0000-0000-0000000000c2',
        '50000000-0000-0000-0000-0000000000c1');
insert into po_lines (po_id, drug_id, qty_base)
values ('90000000-0000-0000-0000-0000000000c9',
        'd0000000-0000-0000-0000-0000000000c2', 100);

select throws_ok(
  $$ select * from app.send_purchase_order('90000000-0000-0000-0000-0000000000c9') $$,
  'CL022',
  null,
  'an order cannot be sent to a supplier with no WhatsApp number, and the refusal says whose'
);

-- ---------------------------------------------------------------------------
-- The send.
-- ---------------------------------------------------------------------------
create temporary table t_send as
select * from app.send_purchase_order((select id from t_po));

select matches(
  (select order_no from t_send),
  '^PO \d{4}-\d{2}/0001$',
  'the number is assigned at the send, and carries the financial year'
);

select matches(
  (select message_body from t_send),
  'Dolo 650 650mg — 2 boxes \(300\)',
  'quantities are said in the units the supplier sells in, with base units in brackets so nothing is ambiguous'
);

select matches(
  (select message_body from t_send),
  'Cetzine 10mg — 25 strips \(250\)',
  'and 250 of a ten-strip is strips, not a fraction of a box'
);

select is(
  (select send_to_number from t_send),
  '+919000000001',
  'addressed to the supplier''s own number'
);

select is(
  (select status::text from purchase_orders where id = (select id from t_po)),
  'sent',
  'the order is sent — which is the doctor''s assertion, not the app''s observation'
);

-- The distinction the whole design turns on.
select is(
  (select status::text from wa_messages where id = (select message_id from t_send)),
  'handed_off',
  'the message stops at handed_off: the app gave the text to WhatsApp and cannot know what happened next (rule 6)'
);

select is(
  (select count(*)::int from wa_messages
   where ref_type = 'purchase_order' and ref_id = (select id from t_po)),
  1,
  'and the row exists whether or not anybody pressed send — a record that over-states beats one that misses (rule 5)'
);

-- ---------------------------------------------------------------------------
-- Re-sending, and the number that must not move.
-- ---------------------------------------------------------------------------
create temporary table t_first_sent as
select sent_at from purchase_orders where id = (select id from t_po);

select is(
  (select send_count from app.send_purchase_order((select id from t_po))),
  2,
  '"did you get my order?" is a real message and produces a second record'
);

select is(
  (select sent_at from purchase_orders where id = (select id from t_po)),
  (select sent_at from t_first_sent),
  'but the FIRST send is what stands — a chase three days later must not make the supplier look faster than they were'
);

select is(
  (select po_no from purchase_orders where id = (select id from t_po)),
  (select order_no from t_send),
  'and the order keeps the number both sides are now talking about'
);

-- ---------------------------------------------------------------------------
-- The reply, typed in by a person because there is no webhook to type it in.
-- ---------------------------------------------------------------------------
select is(
  (select status::text from app.record_supplier_reply(
     (select id from t_po), 'Confirmed, Dolo short by 1 box', current_date + 2)),
  'acknowledged',
  'somebody read the reply and wrote it down, which is the honest version of an acknowledgement'
);

select is(
  (select expected_on from purchase_orders where id = (select id from t_po)),
  current_date + 2,
  'including when they said it would come'
);

-- ---------------------------------------------------------------------------
-- Goods against the order.
-- ---------------------------------------------------------------------------
create temporary table t_grn as
select * from app.receive_against_po(
  (select id from t_po),
  '[{"drug_id": "d0000000-0000-0000-0000-0000000000c1", "batch_no": "DL-PO1",
     "expiry": "2027-12-01", "units_per_strip": 15, "strips_per_box": 10,
     "mrp": 34.50, "cost_per_base_unit": 1.90, "qty_packs": 10}]'::jsonb,
  'INV-5001', current_date);

select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'DL-PO1'),
  150,
  'the goods create batches and the stock rises — through app.receive_goods, not a copy of it'
);

select is(
  (select po_id from goods_receipts where id = (select id from t_grn)),
  (select id from t_po),
  'and the receipt is tied to the order it came from'
);

select is(
  (select status::text from purchase_orders where id = (select id from t_po)),
  'partial',
  'half a delivery is partial — an order half-arrived must not look like one fully arrived'
);

select is(
  (select outstanding_qty_base from purchase_order_lines
   where po_id = (select id from t_po) and drug_name = 'Dolo 650'),
  150,
  'with what is still owed visible on the line'
);

select throws_ok(
  format($$ select app.cancel_purchase_order(%L, 'changed my mind') $$,
         (select id from t_po)),
  'CL007',
  null,
  'and it can no longer be cancelled — goods have arrived against it and cancelling would orphan them'
);

-- The rest of it, in the supplier's second van.
select lives_ok(
  format($$ select app.receive_against_po(%L,
    '[{"drug_id": "d0000000-0000-0000-0000-0000000000c1", "batch_no": "DL-PO2",
       "expiry": "2027-12-01", "units_per_strip": 15, "strips_per_box": 10,
       "mrp": 34.50, "cost_per_base_unit": 1.90, "qty_packs": 10},
      {"drug_id": "d0000000-0000-0000-0000-0000000000c2", "batch_no": "CZ-PO1",
       "expiry": "2027-12-01", "units_per_strip": 10, "strips_per_box": 10,
       "mrp": 44.00, "cost_per_base_unit": 2.60, "qty_packs": 25}]'::jsonb,
    'INV-5002', current_date) $$, (select id from t_po)),
  'the second van arrives'
);

select is(
  (select status::text from purchase_orders where id = (select id from t_po)),
  'received',
  'and now every line is met, so the order is closed'
);

select isnt(
  (select closed_at from purchase_orders where id = (select id from t_po)),
  null,
  'with a closing time on it'
);

select is_empty(
  $$ select * from purchase_orders_open
     where po_id = (select id from t_po) $$,
  'a closed order drops off the open list'
);

select is_empty(
  $$ select * from stock_cache_drift $$,
  'and rule 3 survives the whole lifecycle'
);

-- ---------------------------------------------------------------------------
-- The lead time M3 could only claim, now measured — and still labelled.
-- ---------------------------------------------------------------------------
select is(
  (select receipts_measured from supplier_lead_time
   where supplier_name = 'Kumar Distributors'),
  2,
  'the sent-to-received gap is now real data'
);

select is(
  (select source from supplier_lead_time where supplier_name = 'Kumar Distributors'),
  'claimed',
  'and two deliveries is still an anecdote, so the view keeps saying the number came from the supplier'
);

-- ---------------------------------------------------------------------------
-- Transition-owned.
-- ---------------------------------------------------------------------------
set local role authenticated;

select throws_ok(
  $$ insert into wa_messages (to_number, body, idempotency_key)
     values ('+919000000009', 'hello', 'forged') $$,
  '42501',
  null,
  'a message record cannot be forged by a direct write'
);

select throws_ok(
  $$ update purchase_orders set status = 'sent' $$,
  '42501',
  null,
  'and an order cannot be marked sent by one either'
);

reset role;

select * from finish();
rollback;
