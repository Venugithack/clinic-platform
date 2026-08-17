-- Idempotent replay, and the offline write queue behind it. PLAN.md §8 M9, §16.
--
-- The clinic's Wi-Fi will drop while somebody is mid-sale. That is not a
-- hypothetical: it is a router, a concrete wall and a 4G backup that takes
-- thirty seconds to take over (HOSTING.md §6). The counter cannot stop, so the
-- write has to wait on the tablet and go in when the network returns.
--
-- Which creates the only genuinely dangerous bug in this whole build: a queued
-- dispense applied TWICE. Stock leaves the shelf once and the ledger says it
-- left twice, or the patient is billed twice. A retry that is not idempotent is
-- worse than no retry at all, because the failure is silent and it is money.
--
-- THE MECHANISM, AND WHY IT IS SAFE.
--
-- Every queued operation carries a key the tablet generated before it first
-- tried. `app.replay` takes the key, the operation and its arguments:
--
--   * if that key already has a RESULT, the operation ran to completion once
--     and the stored result is handed back. Nothing executes.
--   * otherwise the operation runs, and its result is written against the key.
--
-- The property that makes this airtight is that the key row and the effect
-- **commit in the same transaction**. There is no window where stock has moved
-- and the key has not been recorded, so nothing can ever be applied twice. And
-- when the operation RAISES — insufficient stock, because somebody sold the
-- last strip while the tablet was offline — the whole transaction rolls back
-- including the key, so the queue can legitimately try again later. Failure
-- stays retryable; success becomes permanent. Both from one property.
--
-- THE WHITELIST IS A SECURITY BOUNDARY, NOT TIDINESS.
--
-- Dispatch is a hand-written `case` over three operations rather than dynamic
-- SQL over a function name. A generic executor that takes a function name from
-- a client is a remote code path into the `app` schema, and the three
-- operations that actually need to survive a dropped connection are the three
-- that happen at a counter with a customer standing at it.
--
-- Error code added here:
--   CL024  that operation cannot be replayed

create table replay_log (
  -- Generated on the tablet, before the first attempt. That is what makes it
  -- the same key across a failure the tablet never saw the answer to.
  key            uuid primary key,
  fn             text not null,
  args           jsonb not null,
  result         jsonb,
  staff_id       uuid references staff (id),
  first_seen_at  timestamptz not null default now(),
  -- How many times the tablet asked again. Non-zero here is not a bug: it is a
  -- network that dropped between the write committing and the answer arriving,
  -- which is exactly the case this table exists for.
  replayed_count int not null default 0
);

create index replay_log_seen_idx on replay_log (first_seen_at desc);

alter table replay_log enable row level security;
grant select on replay_log to authenticated;
revoke insert, update, delete on replay_log from authenticated, anon;

create policy replay_log_read on replay_log
  for select to authenticated using (app.current_staff_id() is not null);

comment on table replay_log is
  'The key and the effect commit together, so nothing is applied twice; a failed operation rolls the key back with it, so it stays retryable (PLAN.md §16).';

create or replace function app.replay(
  p_key  uuid,
  p_fn   text,
  p_args jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_row      replay_log;
  v_result   jsonb;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_key is null then
    raise exception 'a replayable operation needs a key' using errcode = 'CL006';
  end if;

  -- Claim the key. Two tablets — or two tabs — replaying the same key at once
  -- serialise here rather than both executing.
  insert into replay_log (key, fn, args, staff_id)
  values (p_key, p_fn, coalesce(p_args, '{}'::jsonb), v_staff_id)
  on conflict (key) do nothing;

  select * into v_row from replay_log where key = p_key for update;

  if v_row.result is not null then
    -- Already done, exactly once. Hand back what it produced and touch nothing.
    update replay_log set replayed_count = replayed_count + 1 where key = p_key;
    return v_row.result;
  end if;

  case p_fn
    when 'dispense' then
      v_result := jsonb_build_object(
        'dispense_id',
        app.dispense(
          p_args -> 'lines',
          (p_args ->> 'prescription_id')::uuid,
          (p_args ->> 'patient_id')::uuid,
          coalesce((p_args ->> 'is_counter_sale')::boolean, false)
        )
      );

    when 'raise_bill' then
      v_result := to_jsonb(app.raise_bill(
        (p_args ->> 'patient_id')::uuid,
        (p_args ->> 'encounter_id')::uuid,
        coalesce(p_args -> 'dispense_ids', '[]'::jsonb),
        (p_args ->> 'consult_fee')::numeric,
        coalesce((p_args ->> 'discount')::numeric, 0),
        p_args ->> 'note'
      ));

    when 'take_payment' then
      v_result := to_jsonb(app.take_payment(
        (p_args ->> 'bill_id')::uuid,
        p_args ->> 'method',
        (p_args ->> 'amount')::numeric
      ));

    else
      raise exception
        '"%" is not a replayable operation — only the counter''s three are', p_fn
        using errcode = 'CL024';
  end case;

  update replay_log set result = v_result where key = p_key;

  return v_result;
end
$$;

revoke all on function app.replay(uuid, text, jsonb) from public;
grant execute on function app.replay(uuid, text, jsonb) to authenticated, service_role;

comment on function app.replay(uuid, text, jsonb) is
  'Applies a queued write at most once. Dispatch is a hand-written whitelist because a function name from a client is a remote code path.';

-- ---------------------------------------------------------------------------
-- The nightly reconcile, as one row somebody can look at.
--
-- HOSTING.md §5 and PLAN.md §16 both ask for a daily job that alerts on stock
-- drift. This is what it reads. Every number here is a thing that should be
-- zero, so an alert is "any column is non-zero" rather than a rule per metric —
-- and a human opening the screen sees the same figures the job does.
-- ---------------------------------------------------------------------------
create view clinic_health as
select
  -- Rule 3: the ledger is the truth and the cache must agree with it. This has
  -- to be zero, every day, forever.
  (select count(*) from stock_cache_drift)::int                         as stock_drift_batches,
  -- Medicine that left the counter with no bill against it. Some of this is
  -- normal for a few minutes and none of it is normal overnight.
  (select count(*) from dispenses where bill_id is null
     and at < now() - interval '12 hours')::int                         as unbilled_dispenses,
  -- Stock received against paperwork that never arrived (INVENTORY.md §3).
  (select count(*) from goods_receipts where awaiting_invoice)::int     as receipts_awaiting_invoice,
  -- A drawer nobody closed. It means tomorrow's count reconciles against two
  -- days of takings, which is the same as not counting.
  (select count(*) from till_sessions where status = 'open'
     and opened_at < now() - interval '18 hours')::int                  as tills_left_open,
  -- Money a supplier owes and nobody is chasing (INVENTORY.md §6).
  (select count(*) from open_supplier_credits where days_open > 60)::int as stale_supplier_credits,
  -- Stock that can still go back, with under three weeks to do it in.
  (select count(*) from expiring_soon
     where returnable and days_to_return_by <= 21)::int                 as returns_closing_soon,
  -- Expired stock still physically on the shelf.
  (select count(*) from expired_stock)::int                             as expired_on_shelf,
  -- The H1 register's legal gap (§15.2).
  (select count(*) from h1_register where address_missing)::int         as h1_rows_without_address,
  -- Queued writes that were handed over and never came back with a result.
  -- Should always be zero: a row without a result means a transaction that
  -- claimed a key and then failed, which cannot happen — it would have rolled
  -- the key back too.
  (select count(*) from replay_log where result is null)::int           as replays_without_result;

grant select on clinic_health to authenticated;

comment on view clinic_health is
  'Every column should be zero. That is the whole alerting rule (HOSTING.md §5, PLAN.md §16).';
