begin;
select * from no_plan();

-- Production seeds one owner email out-of-band before the first login. Tests do
-- the same explicitly so a random verified inbox cannot claim an empty clinic.
insert into app.bootstrap_owner(email) values ('owner@example.com');

-- Device-free staff sessions can exist without a legacy tablet row.
select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'staff_sessions'
      and column_name = 'device_id'
      and is_nullable = 'YES'
  ),
  'staff sessions no longer require a device'
);

-- A normal anonymous Supabase browser cannot claim first-run ownership even if
-- it knows the configured administrator email address.
select set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.email', 'owner@example.com', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-000000000001","email":"owner@example.com","is_anonymous":true}', true);

select throws_ok(
  $$ select app.first_run_owner('Clinic Owner', '481920') $$,
  'CL005', null,
  'anonymous auth cannot create the clinic owner'
);

-- Even a verified but different email cannot claim the empty clinic.
select set_config('request.jwt.claim.email', 'attacker@example.com', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-000000000009","email":"attacker@example.com","is_anonymous":false}', true);
select set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000000009', true);
select throws_ok(
  $$ select app.first_run_owner('Wrong Owner', '481920') $$,
  'CL005', null,
  'a different verified email cannot claim the empty clinic'
);

-- The pre-authorized verified email OTP identity can create the owner once.
select set_config('request.jwt.claim.email', 'owner@example.com', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-000000000001","email":"owner@example.com","is_anonymous":false}', true);
select set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000000001', true);

create temporary table t_owner as
select app.first_run_owner('Clinic Owner', '481920') as result;

select is((select name from clinic limit 1), 'Jayamurugan Clinic', 'first run fixes the clinic name');
select is((select role::text from staff where name = 'Clinic Owner'), 'admin', 'first owner is an administrator');
select is((select email from staff where name = 'Clinic Owner'), 'owner@example.com', 'first owner stores the verified email');
select is(
  (select auth_user_id from staff where name = 'Clinic Owner'),
  'b1000000-0000-0000-0000-000000000001'::uuid,
  'first owner binds the verified auth uid'
);
select is((select count(*)::int from devices), 0, 'first run creates no trusted device');
select is((select count(*)::int from staff_sessions), 0, 'first run creates no device session');
select is((select count(*)::int from app.bootstrap_owner), 0, 'owner bootstrap record is consumed');
select isnt_empty(
  $$ select app.owner_profile() where app.owner_profile()->>'staff_name' = 'Clinic Owner' $$,
  'verified owner identity resolves the administrator profile'
);

-- The public lock screen returns role but no credential/contact data.
select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'lock_screen_staff' and column_name = 'role'
  ),
  'lock screen exposes the staff role'
);
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'lock_screen_staff'
      and column_name in ('pin_hash', 'email', 'phone', 'auth_user_id')
  ),
  'lock screen does not expose credentials or contact data'
);

-- PIN sign-in works without any device token and creates a nullable-device
-- session. Clear the owner identity to model an ordinary public browser.
select set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.email', '', true);
select set_config('request.jwt.claims', '{"sub":"b2000000-0000-0000-0000-000000000001","is_anonymous":true}', true);

create temporary table t_pin as
select app.unlock_pin((select id from staff where name = 'Clinic Owner'), '481920') as result;

select is((select result->>'ok' from t_pin), 'true', 'correct PIN unlocks from an untrusted browser');
select is(
  (select device_id from staff_sessions order by created_at desc limit 1),
  null::uuid,
  'PIN session is not bound to a device'
);
select isnt_empty(
  $$ select result->>'session_token' from t_pin where coalesce(result->>'session_token','') <> '' $$,
  'PIN unlock returns an opaque staff session token'
);

-- End the successful session so the remaining tests isolate the rate limiter.
update staff_sessions set ended_at = now() where ended_at is null;

-- Four bad PINs remain usable but count down. The fifth applies a ten-minute
-- lock. These are JSON results, not exceptions, so the counter persists.
select is(
  (app.unlock_pin((select id from staff where name = 'Clinic Owner'), '000001')->>'attempts_remaining')::int,
  4,
  'first wrong PIN leaves four attempts'
);
select is(
  (app.unlock_pin((select id from staff where name = 'Clinic Owner'), '000002')->>'attempts_remaining')::int,
  3,
  'second wrong PIN leaves three attempts'
);
select is(
  (app.unlock_pin((select id from staff where name = 'Clinic Owner'), '000003')->>'attempts_remaining')::int,
  2,
  'third wrong PIN leaves two attempts'
);
select is(
  (app.unlock_pin((select id from staff where name = 'Clinic Owner'), '000004')->>'attempts_remaining')::int,
  1,
  'fourth wrong PIN leaves one attempt'
);
select is(
  app.unlock_pin((select id from staff where name = 'Clinic Owner'), '000005')->>'code',
  'locked',
  'fifth wrong PIN locks the account temporarily'
);
select ok(
  (select pin_locked_until > now() from staff where name = 'Clinic Owner'),
  'server stores the temporary PIN lock'
);
select is(
  app.unlock_pin((select id from staff where name = 'Clinic Owner'), '481920')->>'code',
  'locked',
  'even the correct PIN waits until an active brute-force lock ends'
);

-- Re-establish the verified admin identity. Resetting the PIN must clear the
-- lock, invalidate existing PIN sessions, and make the new PIN usable anywhere.
select set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.email', 'owner@example.com', true);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-0000-0000-000000000001","email":"owner@example.com","is_anonymous":false}', true);

select lives_ok(
  $$ select app.set_staff_pin((select id from staff where name = 'Clinic Owner'), '593104') $$,
  'administrator can reset a staff PIN through the control panel'
);
select is((select pin_failed_attempts from staff where name = 'Clinic Owner'), 0, 'PIN reset clears failed attempts');
select is((select pin_locked_until from staff where name = 'Clinic Owner'), null::timestamptz, 'PIN reset clears temporary lock');
select is((select count(*)::int from staff_sessions where ended_at is null), 0, 'PIN reset ends existing PIN sessions');

select set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.email', '', true);
select set_config('request.jwt.claims', '{"sub":"b2000000-0000-0000-0000-000000000001","is_anonymous":true}', true);
select is(
  app.unlock_pin((select id from staff where name = 'Clinic Owner'), '593104')->>'ok',
  'true',
  'new PIN works from an ordinary browser after reset'
);

-- Browser-accessible device enrollment is closed after the migration.
select ok(
  not has_function_privilege('authenticated', 'app.unlock(text,uuid,text)', 'EXECUTE'),
  'legacy device-bound unlock is not browser callable'
);
select ok(
  not has_function_privilege('authenticated', 'app.trust_device_by_email(text,boolean,integer)', 'EXECUTE'),
  'email can no longer trust a device'
);
select ok(
  not has_function_privilege('authenticated', 'app.register_device(text,boolean,integer)', 'EXECUTE'),
  'registration cannot create trusted devices'
);

select * from finish();
rollback;
