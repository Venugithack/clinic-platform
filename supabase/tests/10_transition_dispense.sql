-- The reference transition, proved end to end (BUILD.md §1.5).
--
-- `dispense` was chosen because it carries every real invariant at once. If the
-- pattern survives this file, it survives the other eleven transitions.
begin;
select * from no_plan();

-- ---------------------------------------------------------------------------
-- Fixture. Expiries are relative to today so the suite does not rot.
-- ---------------------------------------------------------------------------
insert into clinic (id, name) values
  ('c1111111-1111-1111-1111-111111111111', 'Test Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-000000000001', 'Dr Rao',  'doctor',  'a0000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000002', 'Latha',   'counter', 'a0000000-0000-0000-0000-000000000002');

insert into patients (id, name) values
  ('60000000-0000-0000-0000-000000000001', 'Ravi Kumar');

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule) values
  ('d0000000-0000-0000-0000-000000000001', 'Amoxil 500',  'Amoxicillin', '500mg', 'capsule', 'piece',  'H'),
  ('d0000000-0000-0000-0000-000000000002', 'Alprax 0.5',  'Alprazolam',  '0.5mg', 'tablet',  'tablet', 'H1'),
  ('d0000000-0000-0000-0000-000000000003', 'Cetzine',     'Cetirizine',  '10mg',  'tablet',  'tablet', 'OTC'),
  ('d0000000-0000-0000-0000-000000000004', 'Pan 40',      'Pantoprazole','40mg',  'tablet',  'tablet', 'OTC'),
  ('d0000000-0000-0000-0000-000000000005', 'Zincovit',    'Multivitamin','—',     'tablet',  'tablet', 'OTC'),
  ('d0000000-0000-0000-0000-000000000006', 'Dolo 650',    'Paracetamol', '650mg', 'tablet',  'tablet', 'OTC');

insert into stock_batches
  (id, drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp, mrp_basis,
   cost_per_base_unit, qty_base_received, qty_base_on_hand)
values
  -- Two batches of one drug: different expiries, different MRPs, different
  -- strip sizes. This is the M3 gate in BUILD.md §2, asserted at M0.
  ('b0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'EARLY', app.month_end(current_date + 60),  10, 10, 100.00, 'strip', 6.0000, 20, 20),
  ('b0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
   'LATE',  app.month_end(current_date + 300), 15, 10, 180.00, 'strip', 8.0000, 30, 30),
  -- Schedule H1, in stock and in date.
  ('b0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000002',
   'H1BATCH', app.month_end(current_date + 300), 15, 10, 45.00, 'strip', 2.0000, 50, 50),
  -- The only batch of this drug is expired.
  ('b0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000003',
   'GONE', app.month_end(current_date - 60), 10, 10, 30.00, 'strip', 1.5000, 100, 100),
  -- Five on hand, ten will be asked for.
  ('b0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000004',
   'SHORT', app.month_end(current_date + 300), 10, 10, 90.00, 'strip', 5.0000, 5, 5),
  -- A pack whose per-unit price does not divide into paise cleanly:
  -- 667.00 ÷ 200 = 3.335, which rounds UP past the pro-rata MRP.
  ('b0000000-0000-0000-0000-000000000006', 'd0000000-0000-0000-0000-000000000005',
   'ROUND', app.month_end(current_date + 300), 200, 1, 667.00, 'strip', 1.0000, 400, 400),
  -- A clean 15-to-a-strip batch, for the exact-strip price.
  ('b0000000-0000-0000-0000-000000000007', 'd0000000-0000-0000-0000-000000000006',
   'CLEAN', app.month_end(current_date + 300), 15, 10, 45.00, 'strip', 1.0000, 100, 100);

-- Stock arrives through the ledger, never by setting the cache. The GRN
-- transition writes both; the fixture has to do the same or rule 3's drift
-- check is comparing against a shelf that never legitimately filled.
insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id)
select b.drug_id, b.id, b.qty_base_received, 'receipt',
       '50000000-0000-0000-0000-000000000002'
from stock_batches b;

insert into encounters (id, patient_id, doctor_id) values
  ('e0000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
   '50000000-0000-0000-0000-000000000001');

insert into prescriptions (id, encounter_id, patient_id, doctor_id, items, signed_at) values
  ('90000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000001',
   '50000000-0000-0000-0000-000000000001',
   jsonb_build_array(jsonb_build_object(
     'drug_id', 'd0000000-0000-0000-0000-000000000002', 'name', 'Alprax 0.5', 'qty_base', 10)),
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

-- The counter staff member is the one standing there.
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000002', true);
select set_config('app.staff_session', 'sess-a0000000-0000-0000-0000-000000000002', true);

select is(app.current_staff_id(), '50000000-0000-0000-0000-000000000002'::uuid,
  'the acting staff member resolves before anything is dispensed');

-- ---------------------------------------------------------------------------
-- FEFO across two batches, and the audit row that comes with it.
-- ---------------------------------------------------------------------------
create temporary table t_fefo as
select app.dispense(
  jsonb_build_array(jsonb_build_object(
    'drug_id', 'd0000000-0000-0000-0000-000000000001', 'qty_base', 25)),
  null,
  '60000000-0000-0000-0000-000000000001',
  true
) as id;

select results_eq(
  $$ select b.batch_no, dl.qty_base
     from dispense_lines dl
     join stock_batches b on b.id = dl.batch_id
     where dl.dispense_id = (select id from t_fefo)
     order by b.expiry $$,
  $$ values ('EARLY', 20), ('LATE', 5) $$,
  'FEFO takes the earlier expiry first and splits the remainder across batches'
);

select results_eq(
  $$ select batch_no, qty_base_on_hand from stock_batches
     where batch_no in ('EARLY', 'LATE') order by batch_no $$,
  $$ values ('EARLY', 0), ('LATE', 25) $$,
  'the on-hand cache is decremented per batch, in the same transaction'
);

select is(
  (select sum(qty_base)::int from stock_movements
   where ref_id = (select id from t_fefo)),
  -25,
  'the ledger records each batch the units left from — the recall trail'
);

select is_empty(
  $$ select * from stock_cache_drift $$,
  'the qty_base_on_hand cache agrees with the ledger (PLAN.md §5.3 rule 3)'
);

-- The audit row. Written inside the transition, not by a caller who remembers.
select is(
  (select count(*)::int from audit_log
   where action = 'dispense' and entity_id = (select id from t_fefo)),
  1,
  'the dispense wrote exactly one audit row'
);

select is(
  (select actor_staff_id from audit_log
   where action = 'dispense' and entity_id = (select id from t_fefo)),
  '50000000-0000-0000-0000-000000000002'::uuid,
  'the audit row names the person, not the tablet (TABLET.md §5)'
);

select set_eq(
  $$ select jsonb_object_keys(after) from audit_log
     where action = 'dispense' and entity_id = (select id from t_fefo) $$,
  $$ values ('prescription_id'), ('patient_id'), ('is_counter_sale'), ('lines'), ('total') $$,
  'the audit row carries changed fields only, never a row snapshot (HOSTING.md §4)'
);

-- ---------------------------------------------------------------------------
-- What the inventory refuses (INVENTORY.md §3).
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd0000000-0000-0000-0000-000000000003', 'qty_base', 1)),
       null, '60000000-0000-0000-0000-000000000001', true) $$,
  'CL002',
  null,
  'an expired batch is excluded from on-hand entirely, not merely flagged'
);

select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'GONE'),
  100,
  'and the expired batch is left untouched — refused, not consumed'
);

select throws_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd0000000-0000-0000-0000-000000000004', 'qty_base', 10)),
       null, '60000000-0000-0000-0000-000000000001', true) $$,
  'CL001',
  null,
  'stock can never go negative: a short dispense fails rather than inventing stock'
);

select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'SHORT'),
  5,
  'and the partial allocation is rolled back with it — no half-dispense'
);

select throws_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd0000000-0000-0000-0000-000000000002', 'qty_base', 10)),
       null, '60000000-0000-0000-0000-000000000001', true) $$,
  'CL003',
  null,
  'a Schedule H1 drug cannot leave on a counter sale (PLAN.md §15.2)'
);

-- ---------------------------------------------------------------------------
-- The MRP ceiling. Rounding a loose-tablet price up past MRP is a legal
-- problem, not a rounding problem (INVENTORY.md §1).
-- ---------------------------------------------------------------------------
create temporary table t_round as
select app.dispense(
  jsonb_build_array(jsonb_build_object(
    'drug_id', 'd0000000-0000-0000-0000-000000000005', 'qty_base', 1)),
  null, '60000000-0000-0000-0000-000000000001', true
) as id;

select is(
  (select amount from dispense_lines where dispense_id = (select id from t_round)),
  3.33::numeric(12,2),
  'a loose unit is rounded DOWN to the paise: 667.00 ÷ 200 = 3.335 bills at 3.33, not 3.34'
);

create temporary table t_strip as
select app.dispense(
  jsonb_build_array(jsonb_build_object(
    'drug_id', 'd0000000-0000-0000-0000-000000000006', 'qty_base', 15)),
  null, '60000000-0000-0000-0000-000000000001', true
) as id;

select is(
  (select amount from dispense_lines where dispense_id = (select id from t_strip)),
  45.00::numeric(12,2),
  'a full strip bills at exactly the printed MRP'
);

-- ---------------------------------------------------------------------------
-- Against a prescription: H1 is allowed, and the status follows what was
-- actually dispensed.
-- ---------------------------------------------------------------------------
create temporary table t_rx as
select app.dispense(
  jsonb_build_array(jsonb_build_object(
    'drug_id', 'd0000000-0000-0000-0000-000000000002', 'qty_base', 4)),
  '90000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000001',
  false
) as id;

select is(
  (select status::text from prescriptions where id = '90000000-0000-0000-0000-000000000001'),
  'partial',
  '4 of 10 dispensed leaves the prescription partial'
);

select lives_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd0000000-0000-0000-0000-000000000002', 'qty_base', 6)),
       '90000000-0000-0000-0000-000000000001',
       '60000000-0000-0000-0000-000000000001',
       false) $$,
  'Schedule H1 dispenses normally against a prescription'
);

select is(
  (select status::text from prescriptions where id = '90000000-0000-0000-0000-000000000001'),
  'dispensed',
  'the remaining 6 completes it'
);

-- ---------------------------------------------------------------------------
-- Attribution is not optional. Without a signed-in staff member there is no
-- name for the Schedule H1 register, so the transition refuses to run at all.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '', true);
select set_config('app.staff_session', '', true);

select throws_ok(
  $$ select app.dispense(
       jsonb_build_array(jsonb_build_object(
         'drug_id', 'd0000000-0000-0000-0000-000000000006', 'qty_base', 1)),
       null, '60000000-0000-0000-0000-000000000001', true) $$,
  'CL005',
  null,
  'a dispense with nobody signed in is refused'
);

select * from finish();
rollback;
