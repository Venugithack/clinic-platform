-- M11b — clinic settings (PLAN.md §16, §18 Q10).
--
-- The interesting assertions in this file are not "the update updates". They
-- are the two ways a settings screen quietly ruins a week:
--
--   a timetable that does not parse means CLOSED, forever, on the one page
--     nobody in the clinic ever looks at, because it is for patients;
--   a field the form did not send must keep its value, or saving the phone
--     number wipes the drug licence off every bill.
begin;
select * from no_plan();

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-000000000011', 'Dr Rao', 'doctor',
   'a0000000-0000-0000-0000-000000000011'),
  ('50000000-0000-0000-0000-000000000012', 'Latha', 'counter',
   'a0000000-0000-0000-0000-000000000012');

-- app.current_staff_id() resolves auth.uid() for administrators only since
-- 20260827224500 (device-free access); every other role now arrives with the
-- opaque PIN session token app.unlock_pin() issues. Give each seeded staff
-- member that session so this pre-rework fixture still acts as the role it
-- declares. The token tracks the actor on every switch below, because the
-- session branch is checked before the auth.uid() one.
insert into staff_sessions (staff_id, token_hash, expires_at)
select id, encode(digest('sess-' || auth_user_id::text, 'sha256'), 'hex'),
       now() + interval '10 hours'
  from staff
 where auth_user_id is not null;

-- ---------------------------------------------------------------------------
-- Day one of go-live: an empty database and a doctor with a form.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000011', true);
select set_config('app.staff_session', 'sess-a0000000-0000-0000-0000-000000000011', true);

select is(
  (select count(*)::int from clinic),
  0,
  'the database starts with no clinic at all'
);

select throws_ok(
  $$ select app.update_clinic(p_phone => '+91 90000 00001') $$,
  'CL026',
  null,
  'and it cannot be created sideways — a clinic needs a name before anything else'
);

select is(
  (select (app.update_clinic(
     p_name            => 'Sri Sai Clinic',
     p_address         => '12 Nehru Street, Kadapa',
     p_phone           => '+91 90000 00001',
     p_doctor_reg_no   => 'APMC-44321',
     p_drug_licence_no => 'AP/KDP/20B/1234',
     p_gstin           => '37abcde1234f1z5',
     p_consult_fee     => 300,
     p_open_hours      => '{"mon":["09:30-13:00","17:00-20:30"]}'::jsonb
   )).name),
  'Sri Sai Clinic',
  'the settings screen creates the clinic on an empty database — no psql on day one'
);

select is(
  (select gstin from clinic),
  '37ABCDE1234F1Z5',
  'and the GSTIN is stored upper-cased, because it is printed on every bill'
);

-- ---------------------------------------------------------------------------
-- The counter does not set the consultation fee.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000012', true);
select set_config('app.staff_session', 'sess-a0000000-0000-0000-0000-000000000012', true);

select throws_ok(
  $$ select app.update_clinic(p_consult_fee => 50) $$,
  'CL005',
  null,
  'the counter cannot change the fee or the licence numbers — they appear on every bill'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000011', true);
select set_config('app.staff_session', 'sess-a0000000-0000-0000-0000-000000000011', true);

-- ---------------------------------------------------------------------------
-- The timetable, which is the one that matters.
--
-- app.clinic_is_open treats a day it cannot read as closed. That is right for
-- a page patients drive to a clinic on, and it means a typo is invisible until
-- somebody drives there.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.update_clinic(p_open_hours => '{"mon":["9:30-1:00 pm"]}'::jsonb) $$,
  'CL026',
  null,
  'a window nobody can parse is refused here, rather than silently meaning "shut on Monday"'
);

select throws_ok(
  $$ select app.update_clinic(p_open_hours => '{"monday":["09:30-13:00"]}'::jsonb) $$,
  'CL026',
  null,
  'and so is a day spelled the way a person would spell it, because clinic_is_open reads "mon"'
);

select throws_ok(
  $$ select app.update_clinic(p_open_hours => '{"mon":["17:00-09:30"]}'::jsonb) $$,
  'CL026',
  null,
  'a window that ends before it starts is a transposition, and it is always closed'
);

select throws_ok(
  $$ select app.update_clinic(p_open_hours => '{"mon":["25:00-26:00"]}'::jsonb) $$,
  'CL026',
  null,
  'and an hour that does not exist is caught rather than cast'
);

select throws_like(
  $$ select app.update_clinic(
       p_open_hours => '{"mon":["09:30-13:00"],"sat":["17:00-09:30"]}'::jsonb) $$,
  '%sat%',
  'the refusal names the day, because the person reading it is looking at seven boxes'
);

select is(
  (select open_hours -> 'mon' ->> 0 from clinic),
  '09:30-13:00',
  'and none of those refusals changed the timetable that was already there'
);

select lives_ok(
  $$ select app.update_clinic(
       p_open_hours => '{"mon":["09:30-13:00","17:00-20:30"],
                         "sat":["09:30-13:00"],"sun":[]}'::jsonb) $$,
  'two sittings a day, a half day and a day off is the shape of a real week'
);

-- Built as a naive local time and then given the clinic's zone, deliberately.
-- Written the obvious way, date_trunc resolves to timestamptz, `at time zone`
-- runs the conversion backwards and Monday 10am becomes 3:30pm — which passed
-- the "closed" assertion below and failed this one, in a file about a
-- timetable being read correctly.
select is(
  (select app.clinic_is_open(
     (date_trunc('week', current_date)::timestamp + interval '10 hours')
       at time zone 'Asia/Kolkata')),
  true,
  'and Monday at 10am is open, which is the whole point of storing it'
);

select is(
  (select app.clinic_is_open(
     (date_trunc('week', current_date)::timestamp + interval '15 hours')
       at time zone 'Asia/Kolkata')),
  false,
  'Monday at 3pm is shut, because two sittings a day means a gap in the middle'
);

select is(
  (select app.clinic_is_open(
     (date_trunc('week', current_date)::timestamp + interval '6 days 10 hours')
       at time zone 'Asia/Kolkata')),
  false,
  'and Sunday is closed all day, because an empty list is a day off'
);

-- ---------------------------------------------------------------------------
-- Saving one field must not blank the others.
-- ---------------------------------------------------------------------------
select is(
  (select (app.update_clinic(p_phone => '+91 90000 00002')).drug_licence_no),
  'AP/KDP/20B/1234',
  'saving the phone number keeps the drug licence — the bill still says who dispensed'
);

select is(
  (select (app.update_clinic(p_consult_fee => 400)).doctor_reg_no),
  'APMC-44321',
  'and changing the fee keeps the registration number'
);

select is(
  (select consult_fee from clinic),
  400::numeric,
  'the fee that did change, changed'
);

select is(
  (select (app.update_clinic(p_gstin => '')).gstin),
  null,
  'an empty field clears it, which is how a clinic that is not registered says so'
);

select throws_ok(
  $$ select app.update_clinic(p_gstin => '37ABCDE1234F1Z') $$,
  'CL026',
  null,
  'but fourteen characters is a typo, and it would be printed on every bill'
);

-- ---------------------------------------------------------------------------
-- The audit row, because "since when has the fee been ₹400?" is asked later.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from audit_log where action = 'update_clinic'),
  4,
  'exactly the four changes that happened are in the log — every refusal above wrote nothing'
);

select is(
  (select (before ->> 'consult_fee') || ' to ' || (after ->> 'consult_fee')
   from audit_log
   where action = 'update_clinic'
     and before ->> 'consult_fee' is distinct from after ->> 'consult_fee'),
  '300.00 to 400.00',
  'and the fee change is recorded both ways round, which is the half that answers "since when?"'
);

select * from finish();
rollback;
