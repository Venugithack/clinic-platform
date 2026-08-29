-- M11 — the drug master import (PLAN.md §16 step 1, INVENTORY.md §9).
--
-- The properties under test are the three that decide whether a busy person can
-- actually get five hundred rows into this system:
--
--   a dry run tells him what will happen before anything happens;
--   one bad row stops the whole file, because a half-imported master is worse
--     than none;
--   running the same file twice updates instead of duplicating, because he will
--     run it twice.
begin;
select * from no_plan();

insert into clinic (id, name) values
  ('c1111111-1111-1111-1111-111111111111', 'Test Clinic');

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

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000012', true);
select set_config('app.staff_session', 'sess-a0000000-0000-0000-0000-000000000012', true);

select throws_ok(
  $$ select app.import_drugs('[{"name": "Dolo 650", "strength": "650mg",
       "salt_composition": "Paracetamol", "form": "tablet"}]'::jsonb, false) $$,
  'CL005',
  null,
  'the counter does not load the drug master — it decides what can be prescribed and what a strip is worth'
);

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000011', true);
select set_config('app.staff_session', 'sess-a0000000-0000-0000-0000-000000000011', true);

-- ---------------------------------------------------------------------------
-- The dry run, which is what he sees first.
-- ---------------------------------------------------------------------------
create temporary table t_file as select '[
  {"name": "Dolo 650", "generic": "Paracetamol", "salt_composition": "Paracetamol",
   "strength": "650mg", "form": "tablet", "base_unit": "tablet",
   "units_per_strip": 15, "strips_per_box": 10, "schedule": "OTC",
   "supplier": "Kumar Distributors", "reorder_level_base": 300},
  {"name": "Alprax 0.25", "salt_composition": "Alprazolam", "strength": "0.25mg",
   "form": "tablet", "base_unit": "tablet", "units_per_strip": 15,
   "strips_per_box": 10, "schedule": "H1", "supplier": "Kumar Distributors"},
  {"name": "Ascoril LS", "salt_composition": "Levosalbutamol + Ambroxol",
   "strength": "100ml", "form": "syrup", "base_unit": "ml",
   "units_per_strip": 100, "strips_per_box": 1, "schedule": "H",
   "supplier": "Reddy Pharma"}
]'::jsonb as rows;

select is(
  (select (app.import_drugs((select rows from t_file)) ->> 'created')::int),
  3,
  'a dry run says how many rows are new'
);

select is(
  (select count(*)::int from drugs),
  0,
  'and writes absolutely nothing while doing it'
);

-- ---------------------------------------------------------------------------
-- One bad row stops the file.
-- ---------------------------------------------------------------------------
create temporary table t_bad as select '[
  {"name": "Dolo 650", "salt_composition": "Paracetamol", "strength": "650mg",
   "form": "tablet"},
  {"name": "Combiflam", "strength": "400/325mg", "form": "tablet"},
  {"name": "Zerodol", "salt_composition": "Aceclofenac", "strength": "100mg",
   "form": "tablet", "schedule": "Schedule H"},
  {"strength": "10mg", "salt_composition": "Cetirizine", "form": "tablet"}
]'::jsonb as rows;

select is(
  (select jsonb_array_length(app.import_drugs((select rows from t_bad)) -> 'errors')),
  3,
  'the dry run reports EVERY bad row, not the first — one error per attempt is how somebody gives up on a file'
);

select alike(
  (select (app.import_drugs((select rows from t_bad)) -> 'errors' -> 0 ->> 'message')),
  '%salt composition%',
  'and says what is wrong in words the person who typed the file can act on'
);

select throws_ok(
  format($$ select app.import_drugs(%L::jsonb, false) $$, (select rows from t_bad)),
  'CL025',
  null,
  'and a real import of that file is refused outright'
);

select is(
  (select count(*)::int from drugs),
  0,
  'with nothing written — the good rows do NOT go in, because a half-imported master is worse than none'
);

-- ---------------------------------------------------------------------------
-- The real thing.
-- ---------------------------------------------------------------------------
create temporary table t_first as
select app.import_drugs((select rows from t_file), false) as result;

select is(
  (select (result ->> 'created')::int from t_first),
  3,
  'the file goes in'
);

select is(
  (select (result ->> 'suppliers_created')::int from t_first),
  2,
  'and the suppliers named in it are created too, because that is how his spreadsheet is shaped'
);

select is(
  (select name from suppliers where lower(name) = 'kumar distributors'),
  'Kumar Distributors',
  'by name, with nothing else invented — a WhatsApp number and a return window are decisions, not import data'
);

select is(
  (select schedule::text from drugs where name = 'Alprax 0.25'),
  'H1',
  'the schedule survives, which is what makes the counter refuse it later'
);

select is(
  (select base_unit::text from drugs where name = 'Ascoril LS'),
  'ml',
  'and a syrup is ml, not tablets (INVENTORY.md §1)'
);

-- ---------------------------------------------------------------------------
-- He will run it twice. Everybody does.
-- ---------------------------------------------------------------------------
create temporary table t_second as
select app.import_drugs((select rows from t_file), false) as result;

select is(
  (select (result ->> 'updated')::int from t_second),
  3,
  'the same file again updates rather than duplicating'
);

select is(
  (select count(*)::int from drugs),
  3,
  'so the master stays three drugs, not six — a duplicated drug master is a week of cleanup'
);

select is(
  (select (result ->> 'suppliers_created')::int from t_second),
  0,
  'and the suppliers are matched, not re-created'
);

-- ---------------------------------------------------------------------------
-- A second run must not undo work done on a screen since the first.
-- ---------------------------------------------------------------------------
update drugs set reorder_qty_base = 900 where name = 'Dolo 650';

select is(
  (select (app.import_drugs('[{"name": "Dolo 650", "salt_composition": "Paracetamol",
     "strength": "650mg", "form": "tablet"}]'::jsonb, false) ->> 'updated')::int),
  1,
  'a trimmed-down file still imports'
);

select is(
  (select reorder_qty_base from drugs where name = 'Dolo 650'),
  900,
  'and a column the file leaves empty keeps what somebody set on a screen last week'
);

select is(
  (select count(*)::int from drugs where active),
  3,
  'a drug missing from the file is left alone, never deleted — a missing row is far more often a mistake than a decision'
);

-- ---------------------------------------------------------------------------
-- Matching is on name AND strength.
-- ---------------------------------------------------------------------------
select is(
  (select (app.import_drugs('[{"name": "Dolo 650", "salt_composition": "Paracetamol",
     "strength": "500mg", "form": "tablet"}]'::jsonb, false) ->> 'created')::int),
  1,
  'the same brand at a different strength is a different product, and the master will contain both'
);

select * from finish();
rollback;
