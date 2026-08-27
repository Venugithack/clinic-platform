-- Medicine configuration is admin-only and direct master writes are closed.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('cb000000-0000-0000-0000-000000000001', 'Medicine Admin Test Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('5b000000-0000-0000-0000-000000000001', 'Clinic Admin', 'admin',
   'ab000000-0000-0000-0000-000000000001'),
  ('5b000000-0000-0000-0000-000000000002', 'Counter Staff', 'counter',
   'ab000000-0000-0000-0000-000000000002');

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

select throws_ok(
  $$ select app.add_drug('Countermed', 'Salt', '10mg', 'tablet', 'tablet') $$,
  'CL005',
  null,
  'counter cannot add a medicine through the transition either'
);

reset role;

-- Admin can create the clinical identity and configure reorder in one action.
select set_config('request.jwt.claim.sub', 'ab000000-0000-0000-0000-000000000001', true);
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

reset role;
select * from finish();
rollback;