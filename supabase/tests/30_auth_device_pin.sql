-- Sign-in on a shared device (TABLET.md §5): the device holds the session, the
-- PIN holds the identity.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('c3333333-3333-3333-3333-333333333333', 'Test Clinic');

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-00000000000a', 'Venu',  'admin',
   'a0000000-0000-0000-0000-00000000000a'),
  ('50000000-0000-0000-0000-00000000000b', 'Latha', 'counter',
   'a0000000-0000-0000-0000-00000000000b');

insert into devices (id, label, device_token, idle_timeout_seconds, registered_by) values
  ('de000000-0000-0000-0000-00000000000c', 'Counter tablet', 'device-counter-token', 180,
   '50000000-0000-0000-0000-00000000000a'),
  ('de000000-0000-0000-0000-00000000000d', 'Old tablet',     'device-lost-token',    180,
   '50000000-0000-0000-0000-00000000000a');

update devices set revoked_at = now() where device_token = 'device-lost-token';

-- The admin sets the counter staff member's PIN.
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);

select lives_ok(
  $$ select app.set_staff_pin('50000000-0000-0000-0000-00000000000b', '481920') $$,
  'an admin can set a staff PIN'
);

select isnt(
  (select pin_hash from staff where id = '50000000-0000-0000-0000-00000000000b'),
  '481920',
  'the PIN is stored as a digest, never as the digits'
);

select throws_ok(
  $$ select app.set_staff_pin('50000000-0000-0000-0000-00000000000b', '4819') $$,
  'PT006',
  null,
  'a staff PIN is exactly 6 digits'
);

-- ---------------------------------------------------------------------------
-- Unlocking.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.unlock('device-counter-token', '50000000-0000-0000-0000-00000000000b', '000000') $$,
  'PT005',
  null,
  'the wrong PIN is refused'
);

select throws_ok(
  $$ select app.unlock('device-lost-token', '50000000-0000-0000-0000-00000000000b', '481920') $$,
  'PT005',
  null,
  'a revoked device is refused before the PIN is even considered — the lost-tablet story'
);

select throws_ok(
  $$ select app.unlock('no-such-device', '50000000-0000-0000-0000-00000000000b', '481920') $$,
  'PT005',
  null,
  'an unregistered device is refused: a PIN alone is useless on any other device'
);

create temporary table t_session as
select app.unlock('device-counter-token', '50000000-0000-0000-0000-00000000000b', '481920') as token;

select isnt_empty(
  $$ select token from t_session where token is not null $$,
  'the right PIN on a registered device returns a session token'
);

select is_empty(
  $$ select 1 from staff_sessions s where s.token_hash = (select token from t_session) $$,
  'the token is stored only as a digest — a leaked table is not a set of live sessions'
);

-- ---------------------------------------------------------------------------
-- Attribution. This is the reason the PIN exists: the Schedule H1 register
-- needs a person's name, and the tablet's own session cannot supply one.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '', true);
select set_config('app.staff_session', (select token from t_session), true);

select is(
  app.current_staff_id(),
  '50000000-0000-0000-0000-00000000000b'::uuid,
  'the PIN session names the person, with no auth user in play at all'
);

select is(
  (select count(*)::int from audit_log
   where action = 'unlock' and entity_id = '50000000-0000-0000-0000-00000000000b'),
  1,
  'the unlock is itself audited'
);

-- ---------------------------------------------------------------------------
-- Idle lock: 3 minutes on the counter, 10 in the cabin.
-- ---------------------------------------------------------------------------
select ok(
  (select expires_at - started_at from staff_sessions
   where staff_id = '50000000-0000-0000-0000-00000000000b' and ended_at is null)
  = interval '180 seconds',
  'the idle window comes from the device, because it is a property of where the tablet stands'
);

select ok(app.touch_session((select token from t_session)),
  'activity extends the idle window');

update staff_sessions set expires_at = now() - interval '1 second'
where staff_id = '50000000-0000-0000-0000-00000000000b';

select is(
  app.current_staff_id(),
  null,
  'once idle-locked, the session names nobody'
);

select ok(
  not app.touch_session((select token from t_session)),
  'and an expired session cannot be extended back to life'
);

-- ---------------------------------------------------------------------------
-- Explicit lock.
-- ---------------------------------------------------------------------------
update staff_sessions set expires_at = now() + interval '180 seconds'
where staff_id = '50000000-0000-0000-0000-00000000000b';

select is(
  app.current_staff_id(),
  '50000000-0000-0000-0000-00000000000b'::uuid,
  'the session resolves again once it is inside its window'
);

select lives_ok(
  $$ select app.lock((select token from t_session)) $$,
  'locking ends the session'
);

select is(
  app.current_staff_id(),
  null,
  'and a locked session names nobody'
);

select * from finish();
rollback;
