begin;
select * from no_plan();

-- A browser's ordinary anonymous Supabase session is authenticated at the SQL
-- role level, but it is not an owner identity.
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.email', 'owner@example.com', true);
select set_config('request.jwt.claims', '{"email":"owner@example.com","is_anonymous":true}', true);

select throws_ok(
  $$ select app.first_run_email('Email Clinic', 'Dr Owner', '481920', 'Cabin tablet') $$,
  'CL005', null,
  'an anonymous browser cannot claim an empty clinic'
);

-- The verified magic-link identity can stand up the empty clinic once.
select set_config('request.jwt.claims', '{"email":"owner@example.com","is_anonymous":false}', true);
create temporary table t_first as
select app.first_run_email('Email Clinic', 'Dr Owner', '481920', 'Cabin tablet') as result;

select is(
  (select email from staff where name = 'Dr Owner'),
  'owner@example.com',
  'first setup binds the verified owner email'
);
select is(
  (select auth_user_id from staff where name = 'Dr Owner'),
  'a1000000-0000-0000-0000-000000000001'::uuid,
  'first setup binds the Supabase auth uid'
);
select is(
  (select count(*)::int from devices where revoked_at is null),
  1,
  'first setup trusts the tablet in the same transaction'
);
select isnt_empty(
  $$ select result->>'session_token' from t_first where result->>'session_token' <> '' $$,
  'first setup signs the owner into the tablet it just trusted'
);

select ok(
  not has_function_privilege('authenticated', 'app.first_run(text,text,text,text)', 'EXECUTE'),
  'the old email-less first_run bootstrap is no longer callable by browsers'
);

-- A configured owner can trust another device without a registration code.
create temporary table t_second as
select app.trust_device_by_email('Owner laptop', false, null) as result;
select is(
  (select count(*)::int from devices where revoked_at is null),
  2,
  'owner email trusts another device directly'
);
select is(
  (select idle_timeout_seconds from devices where label = 'Owner laptop'),
  600,
  'outside-clinic email enrollment gets the longer idle lock'
);

-- Configure a doctor email while acting as the bound admin.
select lives_ok(
  $$ select app.add_staff('Dr Second', 'doctor', '593104', null, 'REG-2') $$,
  'admin can add a doctor normally'
);
select lives_ok(
  $$ select app.set_staff_email((select id from staff where name = 'Dr Second'), 'second@example.com') $$,
  'admin can pre-authorize a doctor email'
);

select throws_ok(
  $$ select app.set_staff_email((select id from staff where name = 'Dr Second'), 'owner@example.com') $$,
  'CL006', null,
  'one email cannot belong to two staff members'
);

select lives_ok(
  $$ select app.add_staff('Nurse No Mail', 'nurse', '593105', null, null) $$,
  'admin can add a nurse'
);
select throws_ok(
  $$ select app.set_staff_email((select id from staff where name = 'Nurse No Mail'), 'nurse@example.com') $$,
  'CL005', null,
  'nurses do not get email device ownership'
);

-- First verified sign-in with a pre-authorized doctor email binds that uid.
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claim.email', 'second@example.com', true);
select set_config('request.jwt.claims', '{"email":"second@example.com","is_anonymous":false}', true);

select lives_ok(
  $$ select app.trust_device_by_email('Doctor laptop', false, null) $$,
  'a pre-authorized doctor email can trust its device'
);
select is(
  (select auth_user_id from staff where name = 'Dr Second'),
  'a1000000-0000-0000-0000-000000000002'::uuid,
  'first doctor email sign-in binds its auth uid atomically'
);

-- Anonymous session with the same email still fails after binding.
select set_config('request.jwt.claims', '{"email":"second@example.com","is_anonymous":true}', true);
select throws_ok(
  $$ select app.trust_device_by_email('Fake tablet', true, null) $$,
  'CL005', null,
  'knowing an authorized email address is not enough without email verification'
);

select * from finish();
rollback;
