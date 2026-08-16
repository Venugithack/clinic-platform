-- M1 — the clinic core transitions.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('c4444444-4444-4444-4444-444444444444', 'Test Clinic');

insert into staff (id, name, role, reg_no, auth_user_id) values
  ('50000000-0000-0000-0000-00000000001a', 'Dr Rao',   'doctor',  'KMC-1234',
   'a0000000-0000-0000-0000-00000000001a'),
  ('50000000-0000-0000-0000-00000000001b', 'Dr Iyer',  'doctor',  'KMC-5678',
   'a0000000-0000-0000-0000-00000000001b'),
  ('50000000-0000-0000-0000-00000000001c', 'Latha',    'counter', null,
   'a0000000-0000-0000-0000-00000000001c');

insert into patients (id, name, age, sex) values
  ('60000000-0000-0000-0000-00000000001a', 'Ravi Kumar',   42, 'M'),
  ('60000000-0000-0000-0000-00000000001b', 'Lakshmi Devi', 61, 'F'),
  ('60000000-0000-0000-0000-00000000001c', 'Arun Prasad',  29, 'M');

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule) values
  ('d0000000-0000-0000-0000-00000000001a', 'Dolo 650', 'Paracetamol', '650mg',
   'tablet', 'tablet', 'OTC');

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000001c', true);

-- ---------------------------------------------------------------------------
-- The daily token.
-- ---------------------------------------------------------------------------
-- `select * from f()` rather than `select (f()).*`: the second form expands to
-- one call per output column, which for a function that inserts a row means
-- one appointment per column of the appointments table.
create temporary table t_tokens as
select * from app.book_appointment('60000000-0000-0000-0000-00000000001a');

insert into t_tokens select * from app.book_appointment('60000000-0000-0000-0000-00000000001b');
insert into t_tokens select * from app.book_appointment('60000000-0000-0000-0000-00000000001c');

select results_eq(
  $$ select token_no from t_tokens order by token_no $$,
  $$ values (1), (2), (3) $$,
  'tokens are allocated contiguously from 1'
);

select is(
  (select count(distinct status)::int from t_tokens),
  1,
  'a walk-in booked for today goes straight to waiting'
);

select is(
  (select distinct status::text from t_tokens),
  'waiting',
  'and that status is waiting, not booked'
);

-- Tomorrow is a different day and starts its own sequence.
create temporary table t_tomorrow as
select * from app.book_appointment(
  '60000000-0000-0000-0000-00000000001a', current_date + 1, 'phone', 'follow-up');

select is(
  (select token_no from t_tomorrow),
  1,
  'each day has its own token sequence'
);

select is(
  (select status::text from t_tomorrow),
  'booked',
  'a future appointment is booked, not waiting — nobody is in the room yet'
);

-- A JSON-RPC caller sends {"p_date": null} rather than omitting the key, and a
-- parameter DEFAULT does not apply to an explicit null. The earlier assertions
-- all omitted the argument, so they never saw this; the browser did, on the
-- first registration it attempted.
create temporary table t_explicit_null as
select * from app.book_appointment(
  '60000000-0000-0000-0000-00000000001b', null, null, null);

select is(
  (select date from t_explicit_null),
  current_date,
  'an explicitly null date still books for today'
);

select is(
  (select source::text from t_explicit_null),
  'walkin',
  'and an explicitly null source is still a walk-in'
);

select throws_ok(
  $$ select app.book_appointment('60000000-0000-0000-0000-00000000001a', current_date - 1) $$,
  'PT006',
  null,
  'a clinic does not take bookings for last week'
);

select throws_ok(
  $$ select app.book_appointment('60000000-0000-0000-0000-0000000000ff') $$,
  'PT006',
  null,
  'an unknown patient cannot be given a token'
);

select is(
  (select count(*)::int from audit_log where action = 'book_appointment'),
  5,
  'every booking is audited'
);

-- ---------------------------------------------------------------------------
-- "3 ahead of you" (PLAN.md §14).
-- ---------------------------------------------------------------------------
select is(
  (select ahead::int from queue_today where token_no = 3),
  2,
  'the third token has two people ahead of it'
);

select lives_ok(
  $$ select app.set_appointment_status(
       (select id from t_tokens where token_no = 1), 'in_consult') $$,
  'the first patient goes in'
);

select is(
  (select ahead::int from queue_today where token_no = 3),
  1,
  'and the count ahead drops as the queue moves — it counts who is waiting, not who booked'
);

-- ---------------------------------------------------------------------------
-- The state machine.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$ select app.set_appointment_status(
       (select id from t_tokens where token_no = 1), 'done') $$,
  'in_consult → done'
);

select throws_ok(
  $$ select app.set_appointment_status(
       (select id from t_tokens where token_no = 1), 'in_consult') $$,
  'PT007',
  null,
  'done is terminal: a queue that walks backwards cannot be reconstructed at closing time'
);

select lives_ok(
  $$ select app.set_appointment_status(
       (select id from t_tokens where token_no = 2), 'no_show') $$,
  'waiting → no_show'
);

select throws_ok(
  $$ select app.set_appointment_status(
       (select id from t_tokens where token_no = 2), 'in_consult') $$,
  'PT007',
  null,
  'and no_show is terminal too'
);

-- ---------------------------------------------------------------------------
-- Signing.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000001a', true);

insert into encounters (id, patient_id, doctor_id, appointment_id) values
  ('e0000000-0000-0000-0000-00000000001a', '60000000-0000-0000-0000-00000000001a',
   '50000000-0000-0000-0000-00000000001a', (select id from t_tokens where token_no = 1));

insert into prescriptions (id, encounter_id, patient_id, doctor_id, items) values
  ('90000000-0000-0000-0000-00000000001a',
   'e0000000-0000-0000-0000-00000000001a',
   '60000000-0000-0000-0000-00000000001a',
   '50000000-0000-0000-0000-00000000001a',
   jsonb_build_array(jsonb_build_object(
     'drug_id', 'd0000000-0000-0000-0000-00000000001a', 'name', 'Dolo 650',
     'dose', '1', 'freq', '1-0-1', 'days', 3, 'qty_base', 6))),
  ('90000000-0000-0000-0000-00000000001b',
   'e0000000-0000-0000-0000-00000000001a',
   '60000000-0000-0000-0000-00000000001a',
   '50000000-0000-0000-0000-00000000001a',
   '[]'::jsonb),
  ('90000000-0000-0000-0000-00000000001c',
   'e0000000-0000-0000-0000-00000000001a',
   '60000000-0000-0000-0000-00000000001a',
   '50000000-0000-0000-0000-00000000001a',
   jsonb_build_array(jsonb_build_object(
     'drug_id', 'd0000000-0000-0000-0000-0000000000ff', 'qty_base', 6)));

select throws_ok(
  $$ select app.sign_prescription('90000000-0000-0000-0000-00000000001b') $$,
  'PT006',
  null,
  'an empty prescription cannot be signed'
);

select throws_ok(
  $$ select app.sign_prescription('90000000-0000-0000-0000-00000000001c') $$,
  'PT006',
  null,
  'nor one naming a drug that is not in the catalogue'
);

-- The other doctor tries to sign it.
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000001b', true);

select throws_ok(
  $$ select app.sign_prescription('90000000-0000-0000-0000-00000000001a') $$,
  'PT005',
  null,
  'only the prescribing doctor signs — §15.2 wants the prescriber against every H1 line'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000001a', true);

select lives_ok(
  $$ select app.sign_prescription('90000000-0000-0000-0000-00000000001a') $$,
  'the prescribing doctor signs'
);

select isnt(
  (select signed_at from prescriptions where id = '90000000-0000-0000-0000-00000000001a'),
  null,
  'signing stamps the time'
);

select throws_ok(
  $$ select app.sign_prescription('90000000-0000-0000-0000-00000000001a') $$,
  'PT008',
  null,
  'and it cannot be signed twice'
);

select is(
  (select actor_staff_id from audit_log where action = 'sign_prescription'),
  '50000000-0000-0000-0000-00000000001a'::uuid,
  'the signature is audited against the doctor who gave it'
);

-- ---------------------------------------------------------------------------
-- Immutability after signing, and the transition-owned tables.
-- ---------------------------------------------------------------------------
set local role authenticated;

select throws_ok(
  $$ insert into appointments (patient_id, date, token_no)
     values ('60000000-0000-0000-0000-00000000001a', current_date, 99) $$,
  '42501',
  null,
  'a token cannot be handed out by a direct write — that is how two people get number 7'
);

-- A signed prescription is closed to further edits. The RLS policy filters the
-- row out rather than raising, so the assertion is that nothing was changed:
-- the paper in the patient's hand and the row in the database must not disagree.
with attempted as (
  update prescriptions set items = '[]'::jsonb
  where id = '90000000-0000-0000-0000-00000000001a'
  returning 1
)
select is(
  (select count(*)::int from attempted),
  0,
  'a signed prescription cannot be edited, even by the doctor who signed it'
);

select is(
  (select jsonb_array_length(items) from prescriptions
   where id = '90000000-0000-0000-0000-00000000001a'),
  1,
  'and its lines are still there'
);

-- An unsigned one of his own is still his to compose.
with attempted as (
  update prescriptions set items = '[]'::jsonb
  where id = '90000000-0000-0000-0000-00000000001b'
  returning 1
)
select is(
  (select count(*)::int from attempted),
  1,
  'an unsigned prescription is still editable by its prescriber'
);

reset role;

select * from finish();
rollback;
