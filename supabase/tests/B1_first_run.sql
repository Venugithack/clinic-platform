-- First run now starts with a verified owner email, then returns to device + PIN.
begin;
select * from no_plan();

select is((select count(*)::int from clinic), 0, 'no clinic');
select is((select count(*)::int from staff), 0, 'no staff');
select is((select count(*)::int from devices), 0, 'no trusted device');

select set_config('request.jwt.claim.sub', 'a6000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.email', 'owner@first.example', true);
select set_config('request.jwt.claims', '{"email":"owner@first.example","is_anonymous":false}', true);

select throws_ok(
  $$ select app.first_run_email('', 'Dr Rao', '481920') $$,
  'CL006', null, 'the clinic needs a name');
select throws_ok(
  $$ select app.first_run_email('Sri Sai Clinic', '', '481920') $$,
  'CL006', null, 'the administrator needs a name');
select throws_ok(
  $$ select app.first_run_email('Sri Sai Clinic', 'Dr Rao', '1234') $$,
  'CL006', null, 'the PIN is six digits');
select is((select count(*)::int from staff), 0, 'refused setup leaves no partial staff row');

create temporary table t_run as
select app.first_run_email('Sri Sai Clinic', 'Dr Rao', '481920', 'Cabin tablet') as result;

select is((select result->>'clinic_name' from t_run), 'Sri Sai Clinic', 'the clinic exists');
select is((select role::text from staff), 'admin', 'the first person is the administrator');
select is((select email from staff), 'owner@first.example', 'the first administrator owns the verified email');
select is((select auth_user_id from staff), 'a6000000-0000-0000-0000-000000000001'::uuid, 'the auth uid is bound from the verified email session');
select is((select length(result->>'device_token') from t_run), 48, 'the first device trust token is generated in the database');
select is((select label from devices), 'Cabin tablet', 'the first device is named');
select is((select idle_timeout_seconds from devices), 180, 'clinic device uses the three-minute idle lock');

select isnt(
  (select app.unlock(
    (select result->>'device_token' from t_run),
    (select id from staff),
    '481920')),
  null,
  'the normal PIN front door works immediately after email setup'
);

select is(
  (select actor_type from audit_log where action = 'first_run_email'),
  'system',
  'first setup is audited as the one legitimate pre-staff system action'
);

select throws_ok(
  $$ select app.first_run_email('Other Clinic', 'Intruder', '111111') $$,
  'CL007', null,
  'verified email setup cannot run a second time'
);
select is((select count(*)::int from staff), 1, 'no second administrator appears');

select ok(
  not has_function_privilege('authenticated', 'app.first_run(text,text,text,text)', 'EXECUTE'),
  'the old email-less browser bootstrap is retired'
);

select * from finish();
rollback;
