-- Shared patient intake: doctors and nurses can record vitals, while the
-- pharmacy counter cannot and a nurse still cannot open the consultation side.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('c9000000-0000-0000-0000-000000000001', 'Nurse Intake Test Clinic');

insert into staff (id, name, role, reg_no, auth_user_id) values
  ('59000000-0000-0000-0000-000000000001', 'Dr Rao', 'doctor', 'KMC-1001',
   'a9000000-0000-0000-0000-000000000001'),
  ('59000000-0000-0000-0000-000000000002', 'Nurse Priya', 'nurse', null,
   'a9000000-0000-0000-0000-000000000002'),
  ('59000000-0000-0000-0000-000000000003', 'Pharmacy Latha', 'counter', null,
   'a9000000-0000-0000-0000-000000000003'),
  ('59000000-0000-0000-0000-000000000004', 'Clinic Admin', 'admin', null,
   'a9000000-0000-0000-0000-000000000004');

insert into patients (id, name, age, sex) values
  ('69000000-0000-0000-0000-000000000001', 'Ravi Kumar', 42, 'M');

insert into appointments (id, patient_id, date, token_no, status, source) values
  ('79000000-0000-0000-0000-000000000001',
   '69000000-0000-0000-0000-000000000001', app.clinic_today(), 1, 'waiting', 'walkin');

select is(
  (select role::text from staff where id = '59000000-0000-0000-0000-000000000002'),
  'nurse',
  'nurse is a first-class staff role'
);

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

-- An admin can create a nurse through the same transition the People screen uses.
select set_config('request.jwt.claim.sub', 'a9000000-0000-0000-0000-000000000004', true);
select set_config('app.staff_session', 'sess-a9000000-0000-0000-0000-000000000004', true);

select is(
  (select (app.add_staff('Nurse Meena', 'nurse', '246810')).role::text),
  'nurse',
  'an administrator can add a nurse with a PIN'
);

-- RLS has to be exercised as the API role, not as the migration owner.
select set_config('request.jwt.claim.sub', 'a9000000-0000-0000-0000-000000000002', true);
select set_config('app.staff_session', 'sess-a9000000-0000-0000-0000-000000000002', true);

set local role authenticated;

select lives_ok(
  $$ insert into vitals (patient_id, appointment_id, bp, pulse, spo2, recorded_by)
     values ('69000000-0000-0000-0000-000000000001',
             '79000000-0000-0000-0000-000000000001', '120/80', 78, 98,
             '59000000-0000-0000-0000-000000000002') $$,
  'a nurse can record patient vitals under her own identity'
);

select is(
  (select appointment_id from vitals
   where recorded_by = '59000000-0000-0000-0000-000000000002' limit 1),
  '79000000-0000-0000-0000-000000000001'::uuid,
  'the vitals stay attached to the visit/token they were taken for'
);

select throws_ok(
  $$ insert into vitals (patient_id, appointment_id, bp, recorded_by)
     values ('69000000-0000-0000-0000-000000000001',
             '79000000-0000-0000-0000-000000000001', '130/90',
             '59000000-0000-0000-0000-000000000001') $$,
  '42501',
  null,
  'a nurse cannot attribute a vitals row to the doctor'
);

select throws_ok(
  $$ insert into encounters (patient_id, doctor_id, appointment_id)
     values ('69000000-0000-0000-0000-000000000001',
             '59000000-0000-0000-0000-000000000002',
             '79000000-0000-0000-0000-000000000001') $$,
  '42501',
  null,
  'a nurse cannot create a consultation encounter'
);

reset role;

select set_config('request.jwt.claim.sub', 'a9000000-0000-0000-0000-000000000003', true);
select set_config('app.staff_session', 'sess-a9000000-0000-0000-0000-000000000003', true);

set local role authenticated;

select throws_ok(
  $$ insert into vitals (patient_id, appointment_id, pulse, recorded_by)
     values ('69000000-0000-0000-0000-000000000001',
             '79000000-0000-0000-0000-000000000001', 80,
             '59000000-0000-0000-0000-000000000003') $$,
  '42501',
  null,
  'the pharmacy counter cannot record clinical vitals'
);

reset role;

select set_config('request.jwt.claim.sub', 'a9000000-0000-0000-0000-000000000001', true);
select set_config('app.staff_session', 'sess-a9000000-0000-0000-0000-000000000001', true);

set local role authenticated;

select lives_ok(
  $$ insert into vitals (patient_id, appointment_id, temp, recorded_by)
     values ('69000000-0000-0000-0000-000000000001',
             '79000000-0000-0000-0000-000000000001', 98.6,
             '59000000-0000-0000-0000-000000000001') $$,
  'the doctor can record vitals too'
);

select lives_ok(
  $$ insert into encounters (id, patient_id, doctor_id, appointment_id)
     values ('e9000000-0000-0000-0000-000000000001',
             '69000000-0000-0000-0000-000000000001',
             '59000000-0000-0000-0000-000000000001',
             '79000000-0000-0000-0000-000000000001') $$,
  'the doctor can create the consultation encounter'
);

reset role;

-- Nurse remains outside the prescription boundary even when a doctor-owned
-- encounter already exists.
select set_config('request.jwt.claim.sub', 'a9000000-0000-0000-0000-000000000002', true);
select set_config('app.staff_session', 'sess-a9000000-0000-0000-0000-000000000002', true);

set local role authenticated;

select throws_ok(
  $$ insert into prescriptions (encounter_id, patient_id, doctor_id, items)
     values ('e9000000-0000-0000-0000-000000000001',
             '69000000-0000-0000-0000-000000000001',
             '59000000-0000-0000-0000-000000000002', '[]'::jsonb) $$,
  '42501',
  null,
  'a nurse cannot create a prescription'
);

reset role;

-- The bootstrap admin is still treated as the doctor/owner in this custom
-- build, matching the existing first-run UI.
select set_config('request.jwt.claim.sub', 'a9000000-0000-0000-0000-000000000004', true);
select set_config('app.staff_session', 'sess-a9000000-0000-0000-0000-000000000004', true);

set local role authenticated;

select lives_ok(
  $$ insert into vitals (patient_id, appointment_id, weight, recorded_by)
     values ('69000000-0000-0000-0000-000000000001',
             '79000000-0000-0000-0000-000000000001', 72.5,
             '59000000-0000-0000-0000-000000000004') $$,
  'the first-run admin keeps clinical intake access'
);

reset role;

select * from finish();
rollback;
