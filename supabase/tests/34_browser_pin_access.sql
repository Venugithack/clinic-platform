begin;
select * from no_plan();

-- Empty-clinic owner bootstrap is explicitly pre-authorized server-side.
insert into app.bootstrap_owner(email) values ('owner@example.com');

select set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.email', 'wrong@example.com', true);
select set_config('request.jwt.claims', '{"email":"wrong@example.com","is_anonymous":false}', true);

select throws_ok(
  $$ select app.first_run_owner('Owner', '481920') $$,
  'CL005', null,
  'an unconfigured email cannot claim an empty clinic'
);

select set_config('request.jwt.claim.email', 'owner@example.com', true);
select set_config('request.jwt.claims', '{"email":"owner@example.com","is_anonymous":false}', true);
create temporary table t_owner as
select app.first_run_owner('Owner', '481920') as result;

select is((select count(*)::int from staff), 1, 'first setup creates one administrator');
select is((select count(*)::int from devices), 0, 'first setup creates no trusted device');
select is((select name from clinic limit 1), 'Jayamurugan Clinic', 'clinic name is fixed');
select is((select email from staff limit 1), 'owner@example.com', 'owner email is bound to the administrator');
select is((select count(*)::int from app.bootstrap_owner), 0, 'bootstrap owner record is consumed');
select isnt_empty(
  $$ select result->>'session_token' from t_owner where coalesce(result->>'session_token','') <> '' $$,
  'first setup returns a browser staff session'
);

-- Switch back to an ordinary anonymous browser transport; PIN is the identity.
select set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claim.email', '', true);
select set_config('request.jwt.claims', '{"is_anonymous":true}', true);

create temporary table t_unlock as
select app.unlock_staff((select id from staff where name='Owner'), '481920') as result;
select is((select result->>'ok' from t_unlock), 'true', 'correct PIN unlocks from an untrusted browser');
select isnt_empty(
  $$ select result->>'session_token' from t_unlock where coalesce(result->>'session_token','') <> '' $$,
  'PIN unlock returns a browser session token'
);
select is(
  (select device_id from staff_sessions order by created_at desc limit 1),
  null::uuid,
  'browser session is not tied to a device'
);

-- Failure counters must persist, which is why credential failures return JSON
-- instead of raising an exception.
select app.unlock_staff((select id from staff where name='Owner'), '000001');
select app.unlock_staff((select id from staff where name='Owner'), '000002');
select app.unlock_staff((select id from staff where name='Owner'), '000003');
select app.unlock_staff((select id from staff where name='Owner'), '000004');
create temporary table t_fifth as
select app.unlock_staff((select id from staff where name='Owner'), '000005') as result;

select is((select result->>'reason' from t_fifth), 'locked', 'fifth wrong PIN locks the staff login');
select ok(
  (select pin_locked_until > now() from staff where name='Owner'),
  'lockout timestamp persists after the failed call'
);
select is(
  (app.unlock_staff((select id from staff where name='Owner'), '481920')->>'reason'),
  'locked',
  'even the correct PIN is blocked during the lockout window'
);

update staff set pin_locked_until = now() - interval '1 second' where name='Owner';
select is(
  (app.unlock_staff((select id from staff where name='Owner'), '481920')->>'ok'),
  'true',
  'correct PIN works again after lockout expires'
);

select ok(
  not has_function_privilege('authenticated', 'app.unlock(text,uuid,text)', 'EXECUTE'),
  'old device-token unlock is no longer a browser API'
);
select ok(
  not has_function_privilege('authenticated', 'app.trust_device_by_email(text,boolean,integer)', 'EXECUTE'),
  'email device trust is no longer a browser API'
);
select ok(
  not has_function_privilege('authenticated', 'app.register_device(text,boolean,integer)', 'EXECUTE'),
  'device registration is no longer a browser API'
);

select * from finish();
rollback;
