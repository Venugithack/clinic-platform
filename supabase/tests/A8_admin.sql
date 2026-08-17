-- M11c — staff and device administration (PLAN.md §16, TABLET.md §5).
--
-- Three properties, and none of them is "the insert inserts":
--
--   an empty database can make its first admin, and then never again;
--   the last admin cannot be demoted or switched off, because a clinic that
--     locks itself out needs a developer to get back in;
--   revoking a tablet ends the session running on it, not just the next one.
begin;
select * from no_plan();

-- ---------------------------------------------------------------------------
-- Day one: nobody exists, and somebody has to.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from staff),
  0,
  'the database starts with no staff at all'
);

select is(
  (select (app.add_staff('Venu', 'counter', '481920')).role::text),
  'admin',
  'the first person through the door is an admin whatever the form said — anything else is a database nobody can administer'
);

-- The window is shut now, and this is the assertion that keeps it shut.
select throws_ok(
  $$ select app.add_staff('A Stranger', 'admin', '111111') $$,
  'CL005',
  null,
  'and the bootstrap closes the instant that row exists — the second person needs an admin'
);

select set_config('request.jwt.claim.sub', null, true);

insert into staff (id, name, role, auth_user_id, pin_hash) values
  ('50000000-0000-0000-0000-000000000011', 'Dr Rao', 'doctor',
   'a0000000-0000-0000-0000-000000000011', crypt('481920', gen_salt('bf', 4))),
  ('50000000-0000-0000-0000-000000000012', 'Latha', 'counter',
   'a0000000-0000-0000-0000-000000000012', crypt('481920', gen_salt('bf', 4))),
  ('50000000-0000-0000-0000-000000000013', 'Admin One', 'admin',
   'a0000000-0000-0000-0000-000000000013', crypt('481920', gen_salt('bf', 4)));

-- ---------------------------------------------------------------------------
-- Who may do this at all.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000011', true);

select throws_ok(
  $$ select app.add_staff('New Pharmacist', 'counter', '246810') $$,
  'CL005',
  null,
  'the doctor does not add staff — the person who can reset a PIN can sign in as anybody'
);

select throws_ok(
  $$ select app.register_device('A tablet at home', false) $$,
  'CL005',
  null,
  'and does not register tablets, because a device row is what lets a PIN unlock anything'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000013', true);

select is(
  (select (app.add_staff('New Pharmacist', 'counter', '246810', '+91 90000 00009')).name),
  'New Pharmacist',
  'an admin adds the pharmacist who starts on Monday'
);

select throws_ok(
  $$ select app.add_staff('No PIN', 'counter', '') $$,
  'CL006',
  null,
  'the PIN is not optional: somebody without one is on the lock screen and cannot pass it'
);

select throws_ok(
  $$ select app.add_staff('Short PIN', 'counter', '1234') $$,
  'CL006',
  null,
  'and four digits is not a six-digit PIN'
);

select is(
  (select count(*)::int from staff where name = 'No PIN' or name = 'Short PIN'),
  0,
  'neither of those left a half-made staff member behind'
);

-- ---------------------------------------------------------------------------
-- The lock-out guard, which is the reason this file exists.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select app.update_staff('50000000-0000-0000-0000-000000000012',
       p_active => false) $$,
  'the pharmacist who left is deactivated, not deleted — her name is on prescriptions'
);

select is(
  (select count(*)::int from staff where id = '50000000-0000-0000-0000-000000000012'),
  1,
  'the row is still there, because the H1 register names her'
);

-- Two admins exist at this point: the bootstrap one and Admin One.
select lives_ok(
  $$ select app.update_staff(
       (select id from staff where name = 'Venu'), p_role => 'counter') $$,
  'one of two admins can be demoted'
);

select throws_ok(
  $$ select app.update_staff('50000000-0000-0000-0000-000000000013',
       p_role => 'doctor') $$,
  'CL027',
  null,
  'but the LAST admin cannot — a clinic that locks itself out needs a developer to get back in'
);

select throws_ok(
  $$ select app.update_staff('50000000-0000-0000-0000-000000000013',
       p_active => false) $$,
  'CL027',
  null,
  'and switching the last admin off is the same mistake wearing a different hat'
);

select is(
  (select role::text from staff where id = '50000000-0000-0000-0000-000000000013'),
  'admin',
  'so the clinic still has an administrator'
);

-- ---------------------------------------------------------------------------
-- Devices. The tablet left in an auto-rickshaw.
-- ---------------------------------------------------------------------------
create temporary table t_device as
select app.register_device('Counter tablet') as result;

select is(
  (select length(result ->> 'device_token') from t_device),
  48,
  'the token is generated in the database, not by whatever random source the browser had'
);

select is(
  (select (result ->> 'idle_timeout_seconds')::int from t_device),
  180,
  'a tablet facing the public locks in three minutes (TABLET.md §5)'
);

select is(
  (select (app.register_device('His laptop at home', false) ->> 'idle_timeout_seconds')::int),
  600,
  'and one that does not gets ten'
);

select is(
  (select is_clinic_device from devices where label = 'His laptop at home'),
  false,
  'the laptop is not a clinic device, which is what stops it claiming he is in the clinic'
);

-- A live session on the tablet that is about to go missing.
insert into staff_sessions (staff_id, device_id, token_hash, expires_at)
select '50000000-0000-0000-0000-000000000013',
       (select id from devices where label = 'Counter tablet'),
       'not-a-real-token-hash',
       now() + interval '10 minutes';

select is(
  (select app.revoke_device((select id from devices where label = 'Counter tablet'))),
  1,
  'revoking the tablet ends the session running on it — revoked_at alone only stops the NEXT unlock'
);

select is(
  (select count(*)::int from staff_sessions
   where device_id = (select id from devices where label = 'Counter tablet')
     and ended_at is null),
  0,
  'so the tablet in somebody else'' bag stops working now, not when it idles out'
);

select isnt(
  (select revoked_at from devices where label = 'Counter tablet'),
  null,
  'and it can never unlock again'
);

select is(
  (select app.revoke_device((select id from devices where label = 'Counter tablet'))),
  0,
  'revoking it twice is not an error — it is somebody making sure'
);

-- ---------------------------------------------------------------------------
-- Nothing here is reachable without going through the transitions.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
   from information_schema.table_privileges
   where grantee = 'authenticated' and table_name in ('staff', 'devices')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE')),
  0,
  'staff and devices take no direct writes at all — the last table exempt from rule 2 is not exempt any more'
);

select * from finish();
rollback;
