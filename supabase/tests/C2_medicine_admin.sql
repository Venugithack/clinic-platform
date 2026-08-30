-- The medicine master belongs to the pharmacy, and direct table writes stay closed.
--
-- 20260830120000_pharmacy_owns_the_shelf: the person holding the strip is the
-- one who can read its name, salt, strength and pack size off the box. What did
-- NOT change is that every write still goes through an audited transition —
-- the two 42501 cases below are the proof of that and they are untouched.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('cb000000-0000-0000-0000-000000000001', 'Medicine Admin Test Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('5b000000-0000-0000-0000-000000000001', 'Clinic Admin', 'admin',
   'ab000000-0000-0000-0000-000000000001'),
  ('5b000000-0000-0000-0000-000000000002', 'Counter Staff', 'counter',
   'ab000000-0000-0000-0000-000000000002'),
  ('5b000000-0000-0000-0000-000000000003', 'Ward Nurse', 'nurse',
   'ab000000-0000-0000-0000-000000000003');

-- Only an administrator is identified by auth.uid() alone; everybody else is
-- identified by the PIN session token app.current_staff_id() looks for first.
-- Without this a counter session resolves to NULL staff and the tests below
-- measure nothing.
insert into staff_sessions (staff_id, token_hash, expires_at)
select id, encode(digest('sess-' || auth_user_id::text, 'sha256'), 'hex'),
       now() + interval '10 hours'
  from staff
 where auth_user_id is not null;

insert into suppliers (id, name) values
  ('52000000-0000-0000-0000-000000000001', 'Locked Supplier');

insert into drugs (
  id, name, generic, salt_composition, strength, form, base_unit,
  default_units_per_strip, default_strips_per_box, schedule,
  reorder_level_base, reorder_qty_base)
values (
  'd2000000-0000-0000-0000-000000000001', 'Lockedmed 500', 'Locked generic',
  'Locked salt', '500mg', 'tablet', 'tablet', 10, 10, 'OTC', 20, 100);

-- Old M0 grants allowed any staff member to mutate master data. That bypass is
-- closed now; having an app session is enough to read but not enough to write.
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000002', true);
select set_config('app.staff_session', 'sess-ab000000-0000-0000-0000-000000000002', true);
set local role authenticated;

select throws_ok(
  $$ update suppliers set name = 'Counter rewrote supplier' where id = '52000000-0000-0000-0000-000000000001' $$,
  '42501',
  null,
  'counter cannot bypass supplier admin by updating the table directly'
);

select throws_ok(
  $$ update drugs set reorder_level_base = 1 where id = 'd2000000-0000-0000-0000-000000000001' $$,
  '42501',
  null,
  'counter cannot bypass medicine admin by updating the table directly'
);

-- But the transition is open to them, and that is the whole point of the
-- change: a delivery containing a medicine the clinic has never stocked must
-- not require a telephone call to the owner.
select is(
  (app.add_drug('Countermed', 'Salt', '10mg', 'tablet', 'tablet')).name,
  'Countermed',
  'counter can add a medicine it is holding the box for'
);

select lives_ok(
  $$ select app.update_drug(
       (select id from drugs where name = 'Countermed'),
       'Countermed 10') $$,
  'counter can correct a medicine it just added'
);

reset role;

-- The shelf is the pharmacy's, not everybody's.
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000003', true);
select set_config('app.staff_session', 'sess-ab000000-0000-0000-0000-000000000003', true);
set local role authenticated;

select throws_ok(
  $$ select app.add_drug('Nursemed', 'Salt', '10mg', 'tablet', 'tablet') $$,
  'CL005',
  null,
  'a nurse still cannot add a medicine'
);

reset role;

-- Admin can create the clinical identity and configure reorder in one action.
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000001', true);
select set_config('app.staff_session', 'sess-ab000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select is(
  (app.add_drug(
     'Adminmed 650', 'Paracetamol', '650mg', 'tablet', 'tablet',
     'Paracetamol', 10, 10, 'strip', 'H', '3004', 50, 300)).name,
  'Adminmed 650',
  'admin can add a medicine'
);

select is(
  (select reorder_level_base from drugs where name = 'Adminmed 650'),
  50,
  'low-stock threshold is stored in base units'
);

select is(
  (select reorder_qty_base from drugs where name = 'Adminmed 650'),
  300,
  'configured reorder quantity is stored in base units'
);

select lives_ok(
  $$ select app.update_drug(
       (select id from drugs where name = 'Adminmed 650'),
       'Adminmed 650', 'Paracetamol', 15, 8, 'strip', 'H', '3004', 40, 240, true) $$,
  'admin can change operational medicine settings'
);

select is(
  (select default_units_per_strip from drugs where name = 'Adminmed 650'),
  15,
  'default receiving pack can be changed without rewriting recorded batches'
);

select is(
  (select reorder_level_base from drugs where name = 'Adminmed 650'),
  40,
  'admin can change the reorder threshold'
);

-- The operational update RPC has no salt/strength/form/base-unit parameters,
-- so those clinical/history-defining values remain the values created above.
select is(
  (select concat(salt_composition, '|', strength, '|', form, '|', base_unit::text)
   from drugs where name = 'Adminmed 650'),
  'Paracetamol|650mg|tablet|tablet',
  'clinical identity and base unit are not rewritten by settings edits'
);

select lives_ok(
  $$ select app.update_drug(
       (select id from drugs where name = 'Adminmed 650'),
       null, null, null, null, null, null, null, null, null, false) $$,
  'admin can deactivate a medicine without deleting it'
);

select ok(
  exists (select 1 from drugs where name = 'Adminmed 650' and not active),
  'inactive medicine remains for prescriptions, stock history and bills'
);

-- Nobody at all.
--
-- app.current_staff_role() returns NULL for a caller the database does not
-- recognise as staff, and the first draft of this guard was
-- `not in ('admin','counter')`, which evaluates to NULL on a NULL role and is
-- therefore FALSE to an IF. Written that way the check did not fire and an
-- unrecognised session could add a medicine. This is that bug, kept.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true);
select set_config('app.staff_session', '', true);
set local role authenticated;

select throws_ok(
  $q$ select app.add_drug('Ghostmed', 'Salt', '10mg', 'tablet', 'tablet') $q$,
  'CL005',
  null,
  'a caller the database does not know as staff cannot add a medicine'
);

reset role;
select * from finish();
rollback;