-- Supplier master and medicine↔supplier mapping belong to the pharmacy.
--
-- 20260830120000_pharmacy_owns_the_shelf: the person who phones the supplier is
-- the person who keeps their number. `counter` joins `admin` here; nobody else
-- does, which is what the nurse case below exists to hold.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('ca000000-0000-0000-0000-000000000001', 'Supplier Admin Test Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('5a000000-0000-0000-0000-000000000001', 'Clinic Admin', 'admin',
   'aa000000-0000-0000-0000-000000000001'),
  ('5a000000-0000-0000-0000-000000000002', 'Counter Staff', 'counter',
   'aa000000-0000-0000-0000-000000000002'),
  ('5a000000-0000-0000-0000-000000000003', 'Ward Nurse', 'nurse',
   'aa000000-0000-0000-0000-000000000003');

-- Only an administrator is identified by auth.uid() alone; everybody else is
-- identified by the PIN session token app.current_staff_id() looks for first.
-- Without this a counter session resolves to NULL staff and the tests below
-- measure nothing.
insert into staff_sessions (staff_id, token_hash, expires_at)
select id, encode(digest('sess-' || auth_user_id::text, 'sha256'), 'hex'),
       now() + interval '10 hours'
  from staff
 where auth_user_id is not null;

insert into suppliers (id, name, whatsapp_number, active) values
  ('51000000-0000-0000-0000-000000000001', 'Existing Pharma', '+919000000001', true),
  ('51000000-0000-0000-0000-000000000002', 'Alternate Pharma', '+919000000002', true);

insert into drugs (
  id, name, salt_composition, strength, form, base_unit,
  default_units_per_strip, default_strips_per_box, default_supplier_id,
  reorder_level_base, reorder_qty_base)
values (
  'd1000000-0000-0000-0000-000000000001', 'Testmed 500', 'Testsalt', '500mg',
  'tablet', 'tablet', 10, 10, null, 20, 100);

-- The pharmacy keeps its own supplier list.
select set_config('request.jwt.claim.sub', 'aa000000-0000-0000-0000-000000000002', true);
select set_config('app.staff_session', 'sess-aa000000-0000-0000-0000-000000000002', true);
set local role authenticated;

select is(
  (app.add_supplier('Counter Supplier')).name,
  'Counter Supplier',
  'counter can add a supplier'
);

-- Adding without being able to correct is its own dead end: a typo in a
-- supplier name would need an administrator to fix.
select lives_ok(
  $$ select app.update_supplier(
       (select id from suppliers where name = 'Counter Supplier'),
       'Counter Supplier Ltd') $$,
  'counter can correct a supplier it just added'
);

reset role;

-- Opening the shelf to the pharmacy must not open it to everybody signed in.
select set_config('request.jwt.claim.sub', 'aa000000-0000-0000-0000-000000000003', true);
select set_config('app.staff_session', 'sess-aa000000-0000-0000-0000-000000000003', true);
set local role authenticated;

select throws_ok(
  $$ select app.add_supplier('Nurse Supplier') $$,
  'CL005',
  null,
  'a nurse still cannot add a supplier'
);

reset role;

-- Admin creates a supplier with the WhatsApp details the order hand-off needs.
select set_config('request.jwt.claim.sub', 'aa000000-0000-0000-0000-000000000001', true);
select set_config('app.staff_session', 'sess-aa000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select is(
  (app.add_supplier('New Pharma', 'Ravi', '+919999999999', null, null, null, 2, 120, '30 days')).name,
  'New Pharma',
  'admin can add a supplier'
);

select is(
  (select whatsapp_number from suppliers where name = 'New Pharma'),
  '+919999999999',
  'WhatsApp number is stored for the existing one-click order flow'
);

-- A medicine can have more than one active supplier.
select lives_ok(
  $$ select app.set_drug_supplier(
       'd1000000-0000-0000-0000-000000000001',
       '51000000-0000-0000-0000-000000000001', true, null, null, true) $$,
  'admin can link a preferred supplier to a medicine'
);

select lives_ok(
  $$ select app.set_drug_supplier(
       'd1000000-0000-0000-0000-000000000001',
       '51000000-0000-0000-0000-000000000002', false, null, null, true) $$,
  'admin can link an alternate supplier to the same medicine'
);

select is(
  (select count(*)::int from drug_suppliers
   where drug_id = 'd1000000-0000-0000-0000-000000000001' and active),
  2,
  'both supplier links remain active'
);

select is(
  (select default_supplier_id::text from drugs
   where id = 'd1000000-0000-0000-0000-000000000001'),
  '51000000-0000-0000-0000-000000000001',
  'preferred link is mirrored to drugs.default_supplier_id for existing reorder logic'
);

-- Promoting the alternate atomically demotes the first one.
select lives_ok(
  $$ select app.set_drug_supplier(
       'd1000000-0000-0000-0000-000000000001',
       '51000000-0000-0000-0000-000000000002', true, null, null, true) $$,
  'alternate supplier can be promoted'
);

select is(
  (select count(*)::int from drug_suppliers
   where drug_id = 'd1000000-0000-0000-0000-000000000001'
     and active and is_preferred),
  1,
  'there is exactly one active preferred supplier'
);

select is(
  (select default_supplier_id::text from drugs
   where id = 'd1000000-0000-0000-0000-000000000001'),
  '51000000-0000-0000-0000-000000000002',
  'promoting an alternate changes the supplier used by reorder'
);

-- Stopping use of a supplier is not a delete. Historical supplier rows remain,
-- while future reorder must stop pointing to it.
select lives_ok(
  $$ select app.update_supplier(
       '51000000-0000-0000-0000-000000000002',
       null, null, null, null, null, null, null, null, null, false) $$,
  'admin can deactivate a supplier'
);

select ok(
  exists (select 1 from suppliers where id = '51000000-0000-0000-0000-000000000002'),
  'deactivated supplier remains for purchasing history'
);

select is(
  (select default_supplier_id::text from drugs
   where id = 'd1000000-0000-0000-0000-000000000001'),
  null,
  'deactivating the preferred supplier clears future reorder routing'
);

select is(
  (select count(*)::int from drug_suppliers
   where supplier_id = '51000000-0000-0000-0000-000000000002' and active),
  0,
  'medicine links to an inactive supplier stop being orderable'
);

-- Nobody at all.
--
-- app.current_staff_role() returns NULL for a caller the database does not
-- recognise as staff, and the first draft of this guard was
-- `not in ('admin','counter')`, which evaluates to NULL on a NULL role and is
-- therefore FALSE to an IF. Written that way the check did not fire and an
-- unrecognised session could add a supplier. This is that bug, kept.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true);
select set_config('app.staff_session', '', true);
set local role authenticated;

select throws_ok(
  $q$ select app.add_supplier('Ghost Supplier') $q$,
  'CL005',
  null,
  'a caller the database does not know as staff cannot add a supplier'
);

reset role;
select * from finish();
rollback;
