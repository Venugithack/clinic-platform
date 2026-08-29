-- M9 — idempotent replay (PLAN.md §8, §16).
--
-- One assertion in this file matters more than the rest of the milestone: a
-- queued dispense applied twice must move stock ONCE. Everything else here is
-- support for that sentence.
--
-- The second property is subtler and is what makes the queue usable rather than
-- merely safe: an operation that FAILS must stay retryable. Both fall out of
-- the key row and the effect committing in the same transaction.
begin;
select * from no_plan();

insert into clinic (id, name, consult_fee) values
  ('cffffff0-ffff-ffff-ffff-ffffffffffff', 'Test Clinic', 300);

insert into staff (id, name, role, auth_user_id) values
  ('50000000-0000-0000-0000-0000000000f1', 'Latha', 'counter',
   'a0000000-0000-0000-0000-0000000000f1');

insert into patients (id, name, consent_given_at) values
  ('70000000-0000-0000-0000-0000000000f1', 'Ravi Kumar', now());

insert into drugs (id, name, salt_composition, strength, form, base_unit, schedule) values
  ('d0000000-0000-0000-0000-0000000000f1', 'Dolo 650', 'Paracetamol', '650mg',
   'tablet', 'tablet', 'OTC');

insert into stock_batches
  (id, drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp, mrp_basis,
   cost_per_base_unit, qty_base_received, qty_base_on_hand)
values
  ('b0000000-0000-0000-0000-0000000000f1', 'd0000000-0000-0000-0000-0000000000f1',
   'DL-Q1', current_date + 300, 15, 10, 34.50, 'strip', 1.90, 100, 100);

insert into stock_movements (drug_id, batch_id, qty_base, type, staff_id)
values ('d0000000-0000-0000-0000-0000000000f1', 'b0000000-0000-0000-0000-0000000000f1',
        100, 'receipt', '50000000-0000-0000-0000-0000000000f1');

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

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000f1', true);
select set_config('app.staff_session', 'sess-a0000000-0000-0000-0000-0000000000f1', true);

-- ---------------------------------------------------------------------------
-- THE ASSERTION THE MILESTONE EXISTS FOR.
--
-- The tablet sold 15 tablets, lost the Wi-Fi before the answer came back, and
-- has no idea whether it worked. So it asks again with the same key.
-- ---------------------------------------------------------------------------
create temporary table t_first as
select app.replay(
  'aa000000-0000-0000-0000-00000000000f',
  'dispense',
  '{"lines": [{"drug_id": "d0000000-0000-0000-0000-0000000000f1", "qty_base": 15}],
    "patient_id": "70000000-0000-0000-0000-0000000000f1",
    "is_counter_sale": true}'::jsonb) as result;

select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'DL-Q1'),
  85,
  'the sale goes through and the shelf drops by fifteen'
);

create temporary table t_second as
select app.replay(
  'aa000000-0000-0000-0000-00000000000f',
  'dispense',
  '{"lines": [{"drug_id": "d0000000-0000-0000-0000-0000000000f1", "qty_base": 15}],
    "patient_id": "70000000-0000-0000-0000-0000000000f1",
    "is_counter_sale": true}'::jsonb) as result;

select is(
  (select qty_base_on_hand from stock_batches where batch_no = 'DL-Q1'),
  85,
  'the SAME key applied a second time moves nothing — this is the whole point of the milestone'
);

select is(
  (select result from t_second),
  (select result from t_first),
  'and hands back what the first attempt produced, so the tablet learns the answer it missed'
);

select is(
  (select count(*)::int from dispenses),
  1,
  'one dispense, not two'
);

select is(
  (select count(*)::int from stock_movements where type = 'sale'),
  1,
  'one ledger row, not two'
);

select is(
  (select replayed_count from replay_log
   where key = 'aa000000-0000-0000-0000-00000000000f'),
  1,
  'the second ask is counted rather than hidden — a dropped answer is a fact about the network, not a bug'
);

select is_empty(
  $$ select * from stock_cache_drift $$,
  'and rule 3 survives a replay'
);

-- ---------------------------------------------------------------------------
-- A failure has to stay retryable, or the queue silently swallows work.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.replay(
       'bb000000-0000-0000-0000-00000000000f',
       'dispense',
       '{"lines": [{"drug_id": "d0000000-0000-0000-0000-0000000000f1", "qty_base": 5000}],
         "patient_id": "70000000-0000-0000-0000-0000000000f1",
         "is_counter_sale": true}'::jsonb) $$,
  'CL001',
  null,
  'a queued sale can still fail on the way in — somebody sold the rest while the tablet was offline, and it is short'
);

select is(
  (select count(*)::int from replay_log
   where key = 'bb000000-0000-0000-0000-00000000000f'),
  0,
  'and the key rolls back with it, so the counter can fix the stock and try the same operation again'
);

select is(
  (select replays_without_result from clinic_health),
  0,
  'which is why a key with no result is an impossible state, and worth alerting on if it ever appears'
);

-- ---------------------------------------------------------------------------
-- The whitelist is a boundary, not a convenience.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$ select app.replay('cc000000-0000-0000-0000-00000000000f',
       'approve_stock_take', '{}'::jsonb) $$,
  'CL024',
  null,
  'only the counter''s three operations are replayable — a function name from a client is a remote code path'
);

select throws_ok(
  $$ select app.replay('cc000000-0000-0000-0000-00000000000f',
       'drop table patients', '{}'::jsonb) $$,
  'CL024',
  null,
  'and dispatch is a hand-written case, so there is nothing for a clever argument to reach'
);

-- ---------------------------------------------------------------------------
-- Billing replays too, because a bill raised twice is a patient charged twice.
-- ---------------------------------------------------------------------------
select is(
  (select (app.replay(
     'dd000000-0000-0000-0000-00000000000f', 'raise_bill',
     jsonb_build_object(
       'patient_id', '70000000-0000-0000-0000-0000000000f1',
       'dispense_ids', jsonb_build_array((select id from dispenses limit 1)),
       'consult_fee', 300)) ->> 'total')::numeric),
  334.00::numeric,
  'a queued bill goes in'
);

select is(
  (select (app.replay(
     'dd000000-0000-0000-0000-00000000000f', 'raise_bill',
     jsonb_build_object(
       'patient_id', '70000000-0000-0000-0000-0000000000f1',
       'dispense_ids', jsonb_build_array((select id from dispenses limit 1)),
       'consult_fee', 300)) ->> 'total')::numeric),
  334.00::numeric,
  'and going in again returns the same bill rather than raising a second one'
);

select is(
  (select count(*)::int from bills),
  1,
  'one bill, one number, one patient charged once'
);

-- ---------------------------------------------------------------------------
-- Transition-owned, like everything else.
-- ---------------------------------------------------------------------------
set local role authenticated;

select throws_ok(
  $$ update replay_log set result = '{}'::jsonb $$,
  '42501',
  null,
  'a replay record cannot be edited — forging one would make a real write disappear'
);

reset role;

select * from finish();
rollback;
