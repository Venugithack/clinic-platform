-- M11f — first run (PLAN.md §16, TABLET.md §5).
--
-- Every other test file in this suite starts by inserting a clinic and some
-- staff. This one starts from what production actually starts from: nothing.
--
-- The deadlock it closes is worth restating, because it is invisible in
-- development and total on go-live morning — a staff session needs an unlock,
-- an unlock needs a registered device, and registering a device needed an
-- admin session. Nothing could create the first tablet.
begin;
select * from no_plan();

-- ---------------------------------------------------------------------------
-- Nothing. Not a clinic, not a person, not a tablet.
-- ---------------------------------------------------------------------------
select is((select count(*)::int from clinic),  0, 'no clinic');
select is((select count(*)::int from staff),   0, 'no staff');
select is((select count(*)::int from devices), 0, 'and no registered tablet — which is where a real database begins');

-- The deadlock, stated as a test so it cannot quietly come back.
select throws_ok(
  $$ select app.register_device('Counter tablet') $$,
  'CL005',
  null,
  'registering a tablet needs an admin, and an admin needs a tablet to sign in on — that is the deadlock'
);

-- ---------------------------------------------------------------------------
-- What it refuses before it agrees to anything.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.first_run('', 'Dr Rao', '481920') $$,
  'CL006', null, 'the clinic needs a name');

select throws_ok(
  $$ select app.first_run('Sri Sai Clinic', '', '481920') $$,
  'CL006', null, 'and so does the person — it goes on every prescription they sign');

select throws_ok(
  $$ select app.first_run('Sri Sai Clinic', 'Dr Rao', '1234') $$,
  'CL006', null, 'and a PIN is six digits, here as everywhere else');

select is(
  (select count(*)::int from staff),
  0,
  'none of which left half a clinic behind'
);

-- ---------------------------------------------------------------------------
-- The one run it allows.
-- ---------------------------------------------------------------------------
create temporary table t_run as
select app.first_run('Sri Sai Clinic', 'Dr Rao', '481920', 'Cabin tablet') as result;

select is(
  (select result ->> 'clinic_name' from t_run),
  'Sri Sai Clinic',
  'the clinic exists'
);

select is(
  (select role::text from staff),
  'admin',
  'the first person is an admin — anything else is a database nobody can administer'
);

select is(
  (select length(result ->> 'device_token') from t_run),
  48,
  'and a device token comes back, generated in the database rather than by the browser'
);

select is(
  (select label from devices),
  'Cabin tablet',
  'attached to a tablet with the name that was typed'
);

select is(
  (select idle_timeout_seconds from devices),
  180,
  'locking in three minutes, because it is a tablet in a clinic (TABLET.md §5)'
);

-- The whole point: the credential works, through the ordinary front door.
select isnt(
  (select app.unlock(
     (select result ->> 'device_token' from t_run),
     (select id from staff),
     '481920')),
  null,
  'and the PIN just chosen unlocks that tablet — no psql, no second step'
);

select is(
  (select actor_type from audit_log where action = 'first_run'),
  'system',
  'the setup is audited as the system, because it is the one write in this build with no person behind it'
);

-- ---------------------------------------------------------------------------
-- And never again.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.first_run('Somebody Else''s Clinic', 'An Intruder', '111111') $$,
  'CL007',
  null,
  'it cannot run a second time — the guard is the data, not a flag somebody could clear'
);

select is(
  (select count(*)::int from staff),
  1,
  'so no second admin appeared'
);

-- The guard is two conditions, and this is why. A clinic whose tablets were
-- all revoked still has staff, and minting a fresh admin there would be a way
-- in past every PIN in the building.
delete from staff_sessions;
delete from devices;

select throws_ok(
  $$ select app.first_run('Sri Sai Clinic', 'An Intruder', '111111') $$,
  'CL007',
  null,
  'a clinic with staff but no tablets is a clinic that revoked them, not a new one'
);

select * from finish();
rollback;
