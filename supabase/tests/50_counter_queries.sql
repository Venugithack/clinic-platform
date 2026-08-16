-- M2 — the doctor ↔ counter loop (PLAN.md §11.1, INVENTORY.md §7).
--
-- The property under test throughout: the counter PROPOSES and the doctor
-- DECIDES. Nothing substitutes itself, and "equivalent" means the same salt,
-- the same strength and the same form — never "similar".
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('c5555555-5555-5555-5555-555555555555', 'Test Clinic');

insert into staff (id, name, role, reg_no, auth_user_id) values
  ('50000000-0000-0000-0000-0000000000d1', 'Dr Rao',  'doctor',  'KMC-1234',
   'a0000000-0000-0000-0000-0000000000d1'),
  ('50000000-0000-0000-0000-0000000000d2', 'Dr Iyer', 'doctor',  'KMC-5678',
   'a0000000-0000-0000-0000-0000000000d2'),
  ('50000000-0000-0000-0000-0000000000c1', 'Latha',   'counter', null,
   'a0000000-0000-0000-0000-0000000000c1');

insert into patients (id, name) values
  ('60000000-0000-0000-0000-0000000000f1', 'Ravi Kumar');

-- Two brands of the same salt, strength and form: substitutable.
-- One of a different strength, and one of a different salt: not.
insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule) values
  ('d0000000-0000-0000-0000-0000000000a1', 'Dolo 650',   'Paracetamol', '650mg', 'tablet', 'tablet', 'OTC'),
  ('d0000000-0000-0000-0000-0000000000a2', 'Calpol 650', 'Paracetamol', '650mg', 'tablet', 'tablet', 'OTC'),
  ('d0000000-0000-0000-0000-0000000000a3', 'Dolo 500',   'Paracetamol', '500mg', 'tablet', 'tablet', 'OTC'),
  ('d0000000-0000-0000-0000-0000000000a4', 'Cetzine',    'Cetirizine',  '10mg',  'tablet', 'tablet', 'OTC'),
  ('d0000000-0000-0000-0000-0000000000a5', 'Pan 40',     'Pantoprazole','40mg',  'tablet', 'tablet', 'H');

-- Calpol is on the shelf, Dolo is not, Pan is short.
insert into stock_batches
  (id, drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp, mrp_basis,
   cost_per_base_unit, qty_base_received, qty_base_on_hand)
values
  ('b0000000-0000-0000-0000-0000000000a2', 'd0000000-0000-0000-0000-0000000000a2',
   'CAL1', app.month_end(current_date + 300), 15, 10, 34.50, 'strip', 1.9, 300, 300),
  ('b0000000-0000-0000-0000-0000000000a5', 'd0000000-0000-0000-0000-0000000000a5',
   'PAN1', app.month_end(current_date + 300), 15, 10, 165.00, 'strip', 9.5, 4, 4);

insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id)
select b.drug_id, b.id, b.qty_base_received, 'receipt', '50000000-0000-0000-0000-0000000000c1'
from stock_batches b;

insert into encounters (id, patient_id, doctor_id) values
  ('e0000000-0000-0000-0000-0000000000e1', '60000000-0000-0000-0000-0000000000f1',
   '50000000-0000-0000-0000-0000000000d1');

insert into prescriptions (id, encounter_id, patient_id, doctor_id, items, signed_at, status) values
  -- Signed: two lines, one out of stock and one short.
  ('90000000-0000-0000-0000-0000000000fa',
   'e0000000-0000-0000-0000-0000000000e1',
   '60000000-0000-0000-0000-0000000000f1',
   '50000000-0000-0000-0000-0000000000d1',
   jsonb_build_array(
     jsonb_build_object('drug_id', 'd0000000-0000-0000-0000-0000000000a1', 'name', 'Dolo 650', 'qty_base', 10),
     jsonb_build_object('drug_id', 'd0000000-0000-0000-0000-0000000000a5', 'name', 'Pan 40',   'qty_base', 10)),
   now(), 'pending'),
  -- Unsigned draft.
  ('90000000-0000-0000-0000-0000000000fb',
   'e0000000-0000-0000-0000-0000000000e1',
   '60000000-0000-0000-0000-0000000000f1',
   '50000000-0000-0000-0000-0000000000d1',
   jsonb_build_array(
     jsonb_build_object('drug_id', 'd0000000-0000-0000-0000-0000000000a1', 'qty_base', 10)),
   null, 'pending');

-- The pharmacist is at the counter.
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000c1', true);

-- ---------------------------------------------------------------------------
-- The pharmacy queue's colour (TABLET.md §7).
-- ---------------------------------------------------------------------------
select is(
  (select stock_state from pharmacy_queue where prescription_id = '90000000-0000-0000-0000-0000000000fa'),
  'out',
  'a line with nothing on the shelf colours the whole prescription "out"'
);

select is(
  (select lines_out from pharmacy_queue where prescription_id = '90000000-0000-0000-0000-0000000000fa'),
  1,
  'and it counts which lines cannot be filled at all'
);

select is(
  (select lines_in_stock from pharmacy_queue where prescription_id = '90000000-0000-0000-0000-0000000000fa'),
  0,
  '4 on hand against 10 prescribed is not "in stock"'
);

select is_empty(
  $$ select 1 from pharmacy_queue where prescription_id = '90000000-0000-0000-0000-0000000000fb' $$,
  'an unsigned draft never reaches the counter'
);

-- ---------------------------------------------------------------------------
-- Raising.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.raise_counter_query('90000000-0000-0000-0000-0000000000fb',
       'd0000000-0000-0000-0000-0000000000a1', 'out_of_stock') $$,
  'CL006',
  null,
  'a draft cannot be queried — there is nothing to dispense against yet'
);

select throws_ok(
  $$ select app.raise_counter_query('90000000-0000-0000-0000-0000000000fa',
       'd0000000-0000-0000-0000-0000000000a4', 'out_of_stock') $$,
  'CL006',
  null,
  'nor can a drug that is not on the prescription'
);

select throws_ok(
  $$ select app.raise_counter_query('90000000-0000-0000-0000-0000000000fa',
       'd0000000-0000-0000-0000-0000000000a1', 'substitution') $$,
  'CL006',
  null,
  'a substitution query has to name what is being proposed'
);

-- The heart of it: "similar" is not a thing.
select throws_ok(
  $$ select app.raise_counter_query('90000000-0000-0000-0000-0000000000fa',
       'd0000000-0000-0000-0000-0000000000a1', 'substitution',
       'd0000000-0000-0000-0000-0000000000a4') $$,
  'CL009',
  null,
  'a different salt is not a substitute, however convenient'
);

select throws_ok(
  $$ select app.raise_counter_query('90000000-0000-0000-0000-0000000000fa',
       'd0000000-0000-0000-0000-0000000000a1', 'substitution',
       'd0000000-0000-0000-0000-0000000000a3') $$,
  'CL009',
  null,
  'and neither is the same salt at a different strength'
);

create temporary table t_query as
select * from app.raise_counter_query(
  '90000000-0000-0000-0000-0000000000fa',
  'd0000000-0000-0000-0000-0000000000a1',
  'substitution',
  'd0000000-0000-0000-0000-0000000000a2',
  'Dolo is out, Calpol is on the shelf');

select is(
  (select status::text from t_query),
  'open',
  'same salt, same strength, same form: the counter may propose it'
);

select is(
  (select raised_by from t_query),
  '50000000-0000-0000-0000-0000000000c1'::uuid,
  'and the proposal is recorded against the person who made it'
);

select is(
  (select count(*)::int from audit_log where action = 'raise_counter_query'),
  1,
  'raising is audited'
);

select throws_ok(
  $$ select app.raise_counter_query('90000000-0000-0000-0000-0000000000fa',
       'd0000000-0000-0000-0000-0000000000a1', 'out_of_stock') $$,
  'CL010',
  null,
  'one open question per line — asking twice is the first one having scrolled away'
);

select is(
  (select open_queries from pharmacy_queue
   where prescription_id = '90000000-0000-0000-0000-0000000000fa'),
  1,
  'the counter queue shows the question is outstanding'
);

-- ---------------------------------------------------------------------------
-- Answering. The doctor decides, and only the prescribing one.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.answer_counter_query((select id from t_query), 'approved') $$,
  'CL005',
  null,
  'the counter cannot answer its own question'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000d2', true);

select throws_ok(
  $$ select app.answer_counter_query((select id from t_query), 'approved') $$,
  'CL005',
  null,
  'and neither can a doctor who did not write the prescription'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000d1', true);

select throws_ok(
  $$ select app.answer_counter_query((select id from t_query), 'amended',
       'd0000000-0000-0000-0000-0000000000a4') $$,
  'CL009',
  null,
  'the doctor cannot amend to a different salt either — the rule binds both ends'
);

select throws_ok(
  $$ select app.answer_counter_query((select id from t_query), 'amended') $$,
  'CL006',
  null,
  'an amendment has to name a drug'
);

select is(
  (select status::text from counter_queries where id = (select id from t_query)),
  'open',
  'and none of those refusals closed the question'
);

select lives_ok(
  $$ select app.answer_counter_query((select id from t_query), 'approved',
       null, 'Fine, dispense Calpol') $$,
  'the prescribing doctor approves the substitution'
);

select results_eq(
  $$ select status::text, decision::text, approved_drug_id, answered_by
     from counter_queries where id = (select id from t_query) $$,
  $$ values ('answered', 'approved',
             'd0000000-0000-0000-0000-0000000000a2'::uuid,
             '50000000-0000-0000-0000-0000000000d1'::uuid) $$,
  'approving names the proposed drug, and records who approved it (INVENTORY.md §7)'
);

select throws_ok(
  $$ select app.answer_counter_query((select id from t_query), 'rejected') $$,
  'CL008',
  null,
  'a question is answered once'
);

select is(
  (select open_queries from pharmacy_queue
   where prescription_id = '90000000-0000-0000-0000-0000000000fa'),
  0,
  'and the counter queue stops flagging it'
);

-- The line is free to be queried again once the first question is closed.
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000c1', true);

select lives_ok(
  $$ select app.raise_counter_query('90000000-0000-0000-0000-0000000000fa',
       'd0000000-0000-0000-0000-0000000000a1', 'clarification', null, 'How many days?') $$,
  'a closed question does not block the next one on the same line'
);

-- ---------------------------------------------------------------------------
-- Withdrawing.
-- ---------------------------------------------------------------------------
create temporary table t_short as
select * from app.raise_counter_query(
  '90000000-0000-0000-0000-0000000000fa',
  'd0000000-0000-0000-0000-0000000000a5',
  'out_of_stock', null, 'Only 4 of 10');

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000d1', true);

select throws_ok(
  $$ select app.withdraw_counter_query((select id from t_short)) $$,
  'CL005',
  null,
  'the doctor answers a question, they do not withdraw it'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000c1', true);

select lives_ok(
  $$ select app.withdraw_counter_query((select id from t_short), 'Found another box') $$,
  'the counter withdraws its own question'
);

select is(
  (select status::text from counter_queries where id = (select id from t_short)),
  'withdrawn',
  'withdrawn, not deleted — the doctor may already have read it'
);

-- ---------------------------------------------------------------------------
-- Transition-owned.
-- ---------------------------------------------------------------------------
set local role authenticated;

select throws_ok(
  $$ insert into counter_queries (prescription_id, drug_id, kind, raised_by)
     values ('90000000-0000-0000-0000-0000000000fa',
             'd0000000-0000-0000-0000-0000000000a1', 'out_of_stock',
             '50000000-0000-0000-0000-0000000000c1') $$,
  '42501',
  null,
  'a question cannot be raised by a direct write'
);

select throws_ok(
  $$ update counter_queries set decision = 'approved' where status = 'open' $$,
  '42501',
  null,
  'and an approval cannot be forged by one — INVENTORY.md §7 wants the doctor named'
);

reset role;

select * from finish();
rollback;
