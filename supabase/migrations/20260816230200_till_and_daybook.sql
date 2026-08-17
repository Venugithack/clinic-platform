-- The till, and the day-book. PLAN.md §8 M4, §18 Q3.
--
-- The gate for this milestone is two equalities, and they are different in kind:
--
--   the day's total matches the sum of its bills   — arithmetic, and it cannot
--                                                    be wrong, because the
--                                                    day-book is derived
--   the till reconciles against counted cash       — physical, and it CAN be
--                                                    wrong, which is the point
--
-- The second is the one worth building carefully. A drawer that is never
-- counted cannot tell a mistake from a theft, and a system that quietly adjusts
-- the count to match its own expectation destroys the only signal there is. So
-- the count and the expectation are both stored, the variance is the difference,
-- and nothing in this file ever "corrects" either of them.

create or replace function app.clinic_day(p_at timestamptz)
returns date
language sql
stable
as $$
  -- A clinic day is a local day. The counter closes at 21:00 IST, which is
  -- 15:30 UTC — grouping bills by UTC date would split every evening in half.
  select (p_at at time zone coalesce(
            (select timezone from clinic limit 1), 'Asia/Kolkata'))::date
$$;

-- ---------------------------------------------------------------------------
-- app.open_till
-- ---------------------------------------------------------------------------
create or replace function app.open_till(p_opening_float numeric default 0)
returns till_sessions
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_till     till_sessions;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if coalesce(p_opening_float, 0) < 0 then
    raise exception 'an opening float cannot be negative' using errcode = 'CL006';
  end if;

  -- Two open tills means every cash sale lands in one of them arbitrarily and
  -- neither reconciles. The partial unique index refuses it as well; this is
  -- the version that says why.
  if exists (select 1 from till_sessions where status = 'open') then
    raise exception 'a till is already open — close it before opening another'
      using errcode = 'CL019';
  end if;

  insert into till_sessions (opened_by, opening_float)
  values (v_staff_id, coalesce(p_opening_float, 0))
  returning * into v_till;

  perform app.write_audit('open_till', 'till_sessions', v_till.id, null,
    jsonb_build_object('opening_float', v_till.opening_float));

  return v_till;
end
$$;

-- ---------------------------------------------------------------------------
-- app.record_cash — money in or out of the drawer that is not a bill.
--
-- Petty cash happens: the courier is paid out of the till, change is topped up
-- from the doctor's pocket. Left unrecorded, it looks exactly like a shortfall
-- at closing time and the variance stops meaning anything.
-- ---------------------------------------------------------------------------
create or replace function app.record_cash(
  p_kind   text,
  p_amount numeric,
  p_reason text
) returns cash_movements
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_till     till_sessions;
  v_row      cash_movements;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_kind not in ('payin', 'payout') then
    raise exception 'cash against a bill is recorded by taking the payment, not by hand'
      using errcode = 'CL006';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'a cash movement has to move something' using errcode = 'CL006';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'cash in or out of the drawer needs a reason' using errcode = 'CL006';
  end if;

  select * into v_till from till_sessions where status = 'open' for update;
  if not found then
    raise exception 'no till is open' using errcode = 'CL020';
  end if;

  insert into cash_movements (till_id, kind, amount, staff_id, reason)
  values (v_till.id, p_kind,
          case when p_kind = 'payout' then -p_amount else p_amount end,
          v_staff_id, p_reason)
  returning * into v_row;

  perform app.write_audit('record_cash', 'cash_movements', v_row.id, null,
    jsonb_build_object('kind', p_kind, 'amount', v_row.amount, 'reason', p_reason));

  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- app.close_till — the count, and the difference.
-- ---------------------------------------------------------------------------
create or replace function app.close_till(
  p_till_id      uuid,
  p_counted_cash numeric,
  p_note         text default null
) returns till_sessions
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_till     till_sessions;
  v_expected numeric(12, 2);
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_counted_cash is null or p_counted_cash < 0 then
    raise exception 'closing a till means counting it' using errcode = 'CL006';
  end if;

  select * into v_till from till_sessions where id = p_till_id for update;
  if not found then
    raise exception 'unknown till %', p_till_id using errcode = 'CL006';
  end if;

  if v_till.status <> 'open' then
    raise exception 'that till was closed at %', v_till.closed_at
      using errcode = 'CL007';
  end if;

  select v_till.opening_float + coalesce(sum(amount), 0)
  into v_expected
  from cash_movements where till_id = p_till_id;

  update till_sessions
  set status        = 'closed',
      closed_by     = v_staff_id,
      closed_at     = now(),
      counted_cash  = p_counted_cash,
      expected_cash = v_expected,
      -- Recorded, never reconciled away. A short drawer is information.
      variance      = p_counted_cash - v_expected,
      note          = p_note
  where id = p_till_id
  returning * into v_till;

  perform app.write_audit('close_till', 'till_sessions', p_till_id,
    jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'closed', 'counted_cash', p_counted_cash,
                       'expected_cash', v_expected,
                       'variance', v_till.variance));

  return v_till;
end
$$;

revoke all on function app.open_till(numeric)                 from public;
revoke all on function app.record_cash(text, numeric, text)   from public;
revoke all on function app.close_till(uuid, numeric, text)    from public;

grant execute on function app.open_till(numeric)               to authenticated, service_role;
grant execute on function app.record_cash(text, numeric, text) to authenticated, service_role;
grant execute on function app.close_till(uuid, numeric, text)  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The day-book.
--
-- One row per clinic day. Cancelled bills are excluded from every total and
-- counted separately, because "how much did we take today" and "how many did we
-- get wrong today" are both questions and neither answers the other.
-- ---------------------------------------------------------------------------
create view day_book as
select
  app.clinic_day(b.created_at)                                          as day,
  count(*) filter (where b.status <> 'cancelled')::int                  as bills,
  coalesce(sum(b.consult_fee)     filter (where b.status <> 'cancelled'), 0) as consult_total,
  coalesce(sum(b.medicines_total) filter (where b.status <> 'cancelled'), 0) as medicines_total,
  coalesce(sum(b.discount)        filter (where b.status <> 'cancelled'), 0) as discount,
  coalesce(sum(b.round_off)       filter (where b.status <> 'cancelled'), 0) as round_off,
  coalesce(sum(b.total)           filter (where b.status <> 'cancelled'), 0) as net_total,
  coalesce(sum(b.total) filter (where b.status = 'paid' and b.method = 'cash'), 0) as cash,
  coalesce(sum(b.total) filter (where b.status = 'paid' and b.method = 'upi'),  0) as upi,
  coalesce(sum(b.total) filter (where b.status = 'paid' and b.method = 'card'), 0) as card,
  coalesce(sum(b.total) filter (where b.status = 'unpaid'), 0)          as unpaid,
  count(*) filter (where b.status = 'cancelled')::int                   as cancelled
from bills b
group by 1;

comment on view day_book is
  'Derived from bills, so the day cannot disagree with the bills it is made of. The till is the number that can (PLAN.md §8 M4).';

create view till_reconciliation as
select
  t.id            as till_id,
  t.status,
  t.opened_at,
  t.opened_by,
  s.name          as opened_by_name,
  t.opening_float,
  coalesce(sum(m.amount) filter (where m.kind = 'sale'),   0) as cash_sales,
  coalesce(sum(m.amount) filter (where m.kind = 'refund'), 0) as refunds,
  coalesce(sum(m.amount) filter (where m.kind = 'payin'),  0) as pay_ins,
  coalesce(sum(m.amount) filter (where m.kind = 'payout'), 0) as pay_outs,
  t.opening_float + coalesce(sum(m.amount), 0)                as expected_cash,
  t.counted_cash,
  t.variance,
  t.closed_at
from till_sessions t
left join cash_movements m on m.till_id = t.id
left join staff s on s.id = t.opened_by
group by t.id, s.name;

comment on view till_reconciliation is
  'expected_cash is computed live from the drawer''s own movements; till_sessions.expected_cash freezes it at close. They must agree.';

grant select on day_book, till_reconciliation to authenticated;

comment on function app.close_till(uuid, numeric, text) is
  'Stores the count AND the expectation. Never adjusts one to match the other — the difference is the only signal a till gives.';
