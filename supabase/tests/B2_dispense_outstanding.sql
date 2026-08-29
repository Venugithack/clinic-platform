-- A prescription cannot be dispensed for more than it asks for (CL028).
--
-- The bug this file pins down was reachable with two taps and no privilege:
-- the cabin tablet and the counter tablet both open one pending prescription,
-- both verify, both press Dispense. `app.dispense` checked the request against
-- the SHELF and never against the PRESCRIPTION, so both calls succeeded, twice
-- the stock left, both screens reported success, and the patient appeared twice
-- on the billing screen at the same amount and the same second.
--
-- Partial dispensing is why the guard was missing, so the assertions below are
-- deliberately built around it: the remainder must still work, and only the
-- unit past the remainder must fail.
begin;
select * from no_plan();

-- ---------------------------------------------------------------------------
-- Fixture. Expiries relative to today so the suite does not rot.
-- ---------------------------------------------------------------------------
insert into clinic (id, name) values
  ('c2222222-2222-2222-2222-222222222222', 'Guard Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('51000000-0000-0000-0000-000000000001', 'Dr Rao', 'doctor',  'a1000000-0000-0000-0000-000000000001'),
  ('51000000-0000-0000-0000-000000000002', 'Latha',  'counter', 'a1000000-0000-0000-0000-000000000002');

insert into patients (id, name) values
  ('61000000-0000-0000-0000-000000000001', 'Ravi Kumar');

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule) values
  ('d1000000-0000-0000-0000-000000000001', 'Dolo 650',   'Paracetamol', '650mg', 'tablet', 'tablet', 'OTC'),
  -- Same salt, same strength, same form: a legitimate substitute.
  ('d1000000-0000-0000-0000-000000000002', 'Calpol 650', 'Paracetamol', '650mg', 'tablet', 'tablet', 'OTC'),
  -- Never prescribed, plenty in stock.
  ('d1000000-0000-0000-0000-000000000003', 'Pan 40',     'Pantoprazole','40mg',  'tablet', 'tablet', 'OTC');

insert into stock_batches
  (id, drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp, mrp_basis,
   cost_per_base_unit, qty_base_received, qty_base_on_hand)
values
  ('b1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001',
   'DOLO', app.month_end(current_date + 300), 15, 10, 45.00, 'strip', 1.0000, 500, 500),
  ('b1000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000002',
   'CALP', app.month_end(current_date + 300), 15, 10, 45.00, 'strip', 1.0000, 500, 500),
  ('b1000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000003',
   'PAN',  app.month_end(current_date + 300), 15, 10, 60.00, 'strip', 2.0000, 500, 500);

insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id)
select b.drug_id, b.id, b.qty_base_received, 'receipt',
       '51000000-0000-0000-0000-000000000002'
from stock_batches b;

insert into encounters (id, patient_id, doctor_id) values
  ('e1000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001',
   '51000000-0000-0000-0000-000000000001');

-- 15 tablets of Dolo 650 — one strip, the commonest prescription there is.
insert into prescriptions (id, encounter_id, patient_id, doctor_id, items, signed_at) values
  ('91000000-0000-0000-0000-000000000001',
   'e1000000-0000-0000-0000-000000000001',
   '61000000-0000-0000-0000-000000000001',
   '51000000-0000-0000-0000-000000000001',
   jsonb_build_array(jsonb_build_object(
     'drug_id', 'd1000000-0000-0000-0000-000000000001', 'name', 'Dolo 650', 'qty_base', 15)),
   now());

-- app.current_staff_id() resolves auth.uid() for administrators only since
-- 20260827224500 (device-free access); every other role now arrives with the
-- opaque PIN session token app.unlock_pin() issues. Give each seeded staff
-- member that session so this pre-rework fixture still acts as the role it
-- declares. The token tracks the actor on every switch below, because the
-- session branch is checked before the auth.uid() one.
insert into staff_sessions (staff_id, token_hash, expires_at)
select id, encode(digest('sess-' || auth_user_id::text, 'sha256'), 'hex'),
       now() + interval '10 hours'
  from staff
 where auth_user_id is not null;

select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000002', true);
select set_config('app.staff_session', 'sess-a1000000-0000-0000-0000-000000000002', true);

-- ---------------------------------------------------------------------------
-- The bug, stated as an assertion: dispense it once, then try again.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd1000000-0000-0000-0000-000000000001', 'qty_base', 15)),
       '91000000-0000-0000-0000-000000000001',
       '61000000-0000-0000-0000-000000000001',
       false) $$,
  'the prescription dispenses in full the first time'
);

select is(
  (select status::text from prescriptions where id = '91000000-0000-0000-0000-000000000001'),
  'dispensed',
  'and is marked dispensed'
);

select throws_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd1000000-0000-0000-0000-000000000001', 'qty_base', 15)),
       '91000000-0000-0000-0000-000000000001',
       '61000000-0000-0000-0000-000000000001',
       false) $$,
  'CL028',
  '"Dolo 650" has already been dispensed in full against this prescription',
  'dispensing the same prescription a second time is refused'
);

select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'DOLO'),
  485,
  'and the shelf moved once, not twice'
);

select is(
  (select count(*)::int from dispenses where prescription_id = '91000000-0000-0000-0000-000000000001'),
  1,
  'exactly one dispense event stands against the prescription'
);

-- ---------------------------------------------------------------------------
-- Partial dispensing, which is the reason the guard could not simply be
-- "has this prescription been dispensed at all".
-- ---------------------------------------------------------------------------
insert into prescriptions (id, encounter_id, patient_id, doctor_id, items, signed_at) values
  ('91000000-0000-0000-0000-000000000002',
   'e1000000-0000-0000-0000-000000000001',
   '61000000-0000-0000-0000-000000000001',
   '51000000-0000-0000-0000-000000000001',
   jsonb_build_array(jsonb_build_object(
     'drug_id', 'd1000000-0000-0000-0000-000000000001', 'name', 'Dolo 650', 'qty_base', 10)),
   now());

select lives_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd1000000-0000-0000-0000-000000000001', 'qty_base', 4)),
       '91000000-0000-0000-0000-000000000002',
       '61000000-0000-0000-0000-000000000001',
       false) $$,
  'a partial dispense of 4 of 10 is allowed'
);

select lives_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd1000000-0000-0000-0000-000000000001', 'qty_base', 6)),
       '91000000-0000-0000-0000-000000000002',
       '61000000-0000-0000-0000-000000000001',
       false) $$,
  'and the remaining 6 completes it — the remainder is what is tested, not the count of dispenses'
);

select throws_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd1000000-0000-0000-0000-000000000001', 'qty_base', 1)),
       '91000000-0000-0000-0000-000000000002',
       '61000000-0000-0000-0000-000000000001',
       false) $$,
  'CL028',
  '"Dolo 650" has already been dispensed in full against this prescription',
  'the eleventh unit of a ten-unit prescription is refused'
);

-- Over-dispensing in a single call is the same refusal, and names the remainder
-- so the counter knows what it may actually hand over.
insert into prescriptions (id, encounter_id, patient_id, doctor_id, items, signed_at) values
  ('91000000-0000-0000-0000-000000000003',
   'e1000000-0000-0000-0000-000000000001',
   '61000000-0000-0000-0000-000000000001',
   '51000000-0000-0000-0000-000000000001',
   jsonb_build_array(jsonb_build_object(
     'drug_id', 'd1000000-0000-0000-0000-000000000001', 'name', 'Dolo 650', 'qty_base', 10)),
   now());

select throws_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd1000000-0000-0000-0000-000000000001', 'qty_base', 11)),
       '91000000-0000-0000-0000-000000000003',
       '61000000-0000-0000-0000-000000000001',
       false) $$,
  'CL028',
  'only 10 base units of "Dolo 650" are still outstanding on this prescription, not 11',
  'one call asking for more than the prescription says is refused, and names the remainder'
);

-- Two lines in one call that together exceed the prescription are caught too:
-- summing per drug is what stops the guard being sidestepped by splitting.
select throws_ok(
  $$ select app.dispense(
       jsonb_build_array(
         jsonb_build_object('drug_id', 'd1000000-0000-0000-0000-000000000001', 'qty_base', 6),
         jsonb_build_object('drug_id', 'd1000000-0000-0000-0000-000000000001', 'qty_base', 6)),
       '91000000-0000-0000-0000-000000000003',
       '61000000-0000-0000-0000-000000000001',
       false) $$,
  'CL028',
  'only 10 base units of "Dolo 650" are still outstanding on this prescription, not 12',
  'two lines for the same drug are summed, so splitting the request does not evade the guard'
);

-- ---------------------------------------------------------------------------
-- A substitute counts against the drug it replaced. If the guard keyed these
-- differently it would refuse every approved substitution — which is the way
-- this fix would most plausibly have broken something.
-- ---------------------------------------------------------------------------
insert into prescriptions (id, encounter_id, patient_id, doctor_id, items, signed_at) values
  ('91000000-0000-0000-0000-000000000004',
   'e1000000-0000-0000-0000-000000000001',
   '61000000-0000-0000-0000-000000000001',
   '51000000-0000-0000-0000-000000000001',
   jsonb_build_array(jsonb_build_object(
     'drug_id', 'd1000000-0000-0000-0000-000000000001', 'name', 'Dolo 650', 'qty_base', 15)),
   now());

select lives_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id',            'd1000000-0000-0000-0000-000000000002',
         'qty_base',           15,
         'prescribed_drug_id', 'd1000000-0000-0000-0000-000000000001',
         -- The constraint substitution_needs_approval: a substitute always
         -- names the person who approved it, or it cannot be written at all.
         'substitution_approved_by', '51000000-0000-0000-0000-000000000001')),
       '91000000-0000-0000-0000-000000000004',
       '61000000-0000-0000-0000-000000000001',
       false) $$,
  'an approved substitute dispenses against what it replaced'
);

select is(
  (select status::text from prescriptions where id = '91000000-0000-0000-0000-000000000004'),
  'dispensed',
  'and completes the prescription'
);

select throws_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id',            'd1000000-0000-0000-0000-000000000002',
         'qty_base',           15,
         'prescribed_drug_id', 'd1000000-0000-0000-0000-000000000001',
         -- The constraint substitution_needs_approval: a substitute always
         -- names the person who approved it, or it cannot be written at all.
         'substitution_approved_by', '51000000-0000-0000-0000-000000000001')),
       '91000000-0000-0000-0000-000000000004',
       '61000000-0000-0000-0000-000000000001',
       false) $$,
  'CL028',
  '"Dolo 650" has already been dispensed in full against this prescription',
  'and the substitute cannot be dispensed twice either'
);

-- ---------------------------------------------------------------------------
-- A drug that is not on the prescription at all. Medicine leaving the shelf
-- attributed to a prescription that never asked for it is a register entry
-- nobody can defend, so it is refused by name rather than silently recorded.
-- ---------------------------------------------------------------------------
insert into prescriptions (id, encounter_id, patient_id, doctor_id, items, signed_at) values
  ('91000000-0000-0000-0000-000000000005',
   'e1000000-0000-0000-0000-000000000001',
   '61000000-0000-0000-0000-000000000001',
   '51000000-0000-0000-0000-000000000001',
   jsonb_build_array(jsonb_build_object(
     'drug_id', 'd1000000-0000-0000-0000-000000000001', 'name', 'Dolo 650', 'qty_base', 15)),
   now());

select throws_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd1000000-0000-0000-0000-000000000003', 'qty_base', 5)),
       '91000000-0000-0000-0000-000000000005',
       '61000000-0000-0000-0000-000000000001',
       false) $$,
  'CL028',
  '"Pan 40" is not on this prescription',
  'a drug the prescription never asked for cannot be dispensed against it'
);

-- ---------------------------------------------------------------------------
-- The guard is scoped to prescriptions. A counter sale has no prescription to
-- be outstanding against and must be unaffected.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd1000000-0000-0000-0000-000000000003', 'qty_base', 30)),
       null,
       '61000000-0000-0000-0000-000000000001',
       true) $$,
  'a counter sale is untouched by the prescription guard'
);

select is_empty(
  $$ select * from stock_cache_drift $$,
  'the ledger and the on-hand cache still agree after every refusal above'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('app.staff_session', '', true);

select * from finish();
rollback;
