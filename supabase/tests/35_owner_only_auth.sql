begin;
select * from no_plan();

-- Create an ordinary doctor with a historical auth_user_id. The new model must
-- not treat that Supabase identity as a staff login; non-admin staff require a
-- PIN session even if an old row still contains an auth UID.
insert into staff (name, role, pin_hash, pin_set_at, auth_user_id)
values (
  'Historical Doctor',
  'doctor',
  crypt('123456', gen_salt('bf', 12)),
  now(),
  'c1000000-0000-0000-0000-000000000001'::uuid
);

select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-0000-0000-000000000001","is_anonymous":false}', true);
select set_config('app.staff_session', '', true);

select is(
  app.current_staff_id(),
  null::uuid,
  'doctor auth uid cannot bypass PIN sign-in'
);

-- A valid PIN session still identifies the same doctor.
create temporary table t_doctor as
select app.unlock_pin((select id from staff where name = 'Historical Doctor'), '123456') as result;
select set_config('app.staff_session', (select result->>'session_token' from t_doctor), true);
select is(
  app.current_staff_id(),
  (select id from staff where name = 'Historical Doctor'),
  'doctor is identified only after a valid PIN session'
);

select * from finish();
rollback;
