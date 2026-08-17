-- M6 — presence, and the page patients act on (PLAN.md §13).
--
-- The gate is three sentences and each one is a different failure being closed:
--
--   he logs in            → status live within 30 seconds
--   the laptop sleeps     → away within 5 minutes, with nothing scheduled
--   closing time          → closed regardless of any session
--
-- All three are asserted here by moving the clock rather than waiting on it,
-- because the whole design computes presence on read instead of storing it.
begin;
select * from no_plan();

insert into clinic (id, name, timezone, open_hours) values
  ('cdddddd0-dddd-dddd-dddd-dddddddddddd', 'Test Clinic', 'Asia/Kolkata',
   -- Open all day every day, so the timetable is out of the way until the test
   -- that is about the timetable.
   '{"mon":["00:00-23:59"],"tue":["00:00-23:59"],"wed":["00:00-23:59"],
     "thu":["00:00-23:59"],"fri":["00:00-23:59"],"sat":["00:00-23:59"],
     "sun":["00:00-23:59"]}'::jsonb);

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-0000000000d1', 'Dr Rao', 'doctor',
   'a0000000-0000-0000-0000-0000000000d1'),
  ('50000000-0000-0000-0000-0000000000d2', 'Latha', 'counter',
   'a0000000-0000-0000-0000-0000000000d2');

insert into devices (id, label, device_token, is_clinic_device, registered_by) values
  ('de000000-0000-0000-0000-0000000000d1', 'Cabin tablet', 'tok-cabin', true,
   '50000000-0000-0000-0000-0000000000d1'),
  ('de000000-0000-0000-0000-0000000000d2', 'Home laptop',  'tok-home',  false,
   '50000000-0000-0000-0000-0000000000d1');

-- Two live PIN sessions, one on each device. The session token is what tells
-- the transitions which device is asking.
insert into staff_sessions (staff_id, device_id, token_hash, expires_at) values
  ('50000000-0000-0000-0000-0000000000d1', 'de000000-0000-0000-0000-0000000000d1',
   encode(digest('sess-cabin', 'sha256'), 'hex'), now() + interval '10 hours'),
  ('50000000-0000-0000-0000-0000000000d1', 'de000000-0000-0000-0000-0000000000d2',
   encode(digest('sess-home', 'sha256'), 'hex'), now() + interval '10 hours');

-- ---------------------------------------------------------------------------
-- He arrives, on a clinic tablet.
-- ---------------------------------------------------------------------------
select set_config('app.staff_session', 'sess-cabin', true);

select is(
  (select status::text from app.presence_ping()),
  'in_clinic',
  'a heartbeat from a clinic tablet is enough to say he is here'
);

select is(
  (select status from clinic_now),
  'in_clinic',
  'and the public page says so straight away'
);

select isnt(
  (select as_of from clinic_now),
  null,
  'with an "as of" beside it, because a reading without one is a promise (rule 6)'
);

-- ---------------------------------------------------------------------------
-- The laptop sleeps. Nothing runs; the answer changes anyway.
-- ---------------------------------------------------------------------------
update presence set last_heartbeat_at = now() - interval '6 minutes'
where staff_id = '50000000-0000-0000-0000-0000000000d1';

select is(
  (select status from clinic_now),
  'away',
  'six minutes without a heartbeat reads as away — computed on read, so no job can fail to run'
);

select is(
  (select declared_status::text from presence_detail
   where staff_id = '50000000-0000-0000-0000-0000000000d1'),
  'in_clinic',
  'what he last said is still on the record'
);

select is(
  (select effective_status from presence_detail
   where staff_id = '50000000-0000-0000-0000-0000000000d1'),
  'away',
  'and what a patient is told differs from it, which is exactly when it matters'
);

-- ---------------------------------------------------------------------------
-- The home laptop: signs in fine, and may not say he is in the clinic.
-- ---------------------------------------------------------------------------
select set_config('app.staff_session', 'sess-home', true);

select throws_ok(
  $$ select app.set_presence('in_clinic') $$,
  'CL023',
  null,
  'his laptop at home cannot say he is standing in the clinic — the weekly "logged in from home" lie, closed'
);

select lives_ok(
  $$ select app.set_presence('away', null, 'catching up on paperwork') $$,
  'it can say he is away, which is true and useful'
);

select is(
  (select status::text from app.presence_ping()),
  'away',
  'and a heartbeat from it does not promote him to in_clinic either'
);

-- ---------------------------------------------------------------------------
-- What he says himself outranks what the tablet assumes.
-- ---------------------------------------------------------------------------
select set_config('app.staff_session', 'sess-cabin', true);

select is(
  (select status::text from app.set_presence(
     'break', now() + interval '45 minutes', 'lunch')),
  'break',
  'he taps "back by" on the way out'
);

select is(
  (select status::text from app.presence_ping()),
  'break',
  'and the tablet still sitting on his desk does NOT undo it — overwriting that is the lie the table exists to stop'
);

select is(
  (select status from clinic_now),
  'break',
  'so the page keeps saying he stepped out'
);

select isnt(
  (select break_until from clinic_now),
  null,
  'and says when he expects to be back'
);

-- ---------------------------------------------------------------------------
-- Closing time beats everything, including a live session.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select app.set_presence('in_clinic') $$,
  'he is back, and the clinic is open'
);

select is(
  (select status from clinic_now),
  'in_clinic',
  'confirmed before the clock is moved'
);

-- Shut the timetable: no hours on any day.
update clinic set open_hours = '{}'::jsonb;

select is(
  (select status from clinic_now),
  'closed',
  'past closing time the answer is closed, no matter who is signed in or how recently'
);

select ok(
  not (select clinic_open from clinic_now),
  'and the page can say the clinic itself is shut, rather than that he is missing'
);

update clinic set open_hours = '{"mon":["00:00-23:59"],"tue":["00:00-23:59"],
  "wed":["00:00-23:59"],"thu":["00:00-23:59"],"fri":["00:00-23:59"],
  "sat":["00:00-23:59"],"sun":["00:00-23:59"]}'::jsonb;

select is(
  (select status from clinic_now),
  'in_clinic',
  'and it opens again on its own, because nothing was stored'
);

-- ---------------------------------------------------------------------------
-- The unexpected closure, and the one push message §13.3 allows.
-- ---------------------------------------------------------------------------
insert into patients (id, name, consent_given_at) values
  ('70000000-0000-0000-0000-0000000000d1', 'Ravi Kumar', now());
insert into appointments (patient_id, date, token_no, status) values
  ('70000000-0000-0000-0000-0000000000d1', current_date, 1, 'booked');

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000d2', true);
select set_config('app.staff_session', '', true);

select throws_ok(
  $$ select app.close_clinic_today('emergency') $$,
  'CL005',
  null,
  'the counter does not close the clinic'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000d1', true);

select throws_ok(
  $$ select app.close_clinic_today('   ') $$,
  'CL006',
  null,
  'and a closure without a reason is refused — the reason is what the patients are told'
);

select is(
  (select app.close_clinic_today('called away')),
  1,
  'closing tells him how many people already have an appointment today'
);

select is(
  (select status from clinic_now),
  'closed',
  'the page goes closed immediately, with his tablet still awake on the desk'
);

select lives_ok(
  $$ select app.reopen_clinic_today() $$,
  'and it can be undone'
);

select is(
  (select status from clinic_now),
  'in_clinic',
  'putting the page back where it was'
);

-- ---------------------------------------------------------------------------
-- The public surface, which is the one thing anon may read.
-- ---------------------------------------------------------------------------
set local role anon;

select lives_ok(
  $$ select status, as_of from clinic_now $$,
  'the status page can be read with no session at all — it is a pull, not a push (§13.3)'
);

select throws_ok(
  $$ select * from presence $$,
  '42501',
  null,
  'while the table behind it stays shut to anon'
);

select throws_ok(
  $$ select * from patients $$,
  '42501',
  null,
  'and nothing about a patient is one join away from a public page'
);

reset role;

select * from finish();
rollback;
