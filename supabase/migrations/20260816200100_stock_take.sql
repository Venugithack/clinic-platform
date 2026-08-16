-- Stock-take that finds errors instead of confirming them. INVENTORY.md §5.
--
-- "A stock-take that shows the expected number next to the count field does not
--  find discrepancies. The counter sees 47, counts 'about 47', types 47. This
--  is well-documented human behaviour and it makes the whole exercise theatre."
--
-- So the count is blind, and blind is enforced rather than requested. The
-- expected quantity is not merely hidden by the screen — the counting role has
-- no SELECT privilege on the column at all, and the variance view refuses to
-- return anything until counting is closed. A screen that decided to look
-- would get an error, which is the only version of "blind" worth having.
--
-- The six steps, and nothing posts to the ledger until step five:
--
--   1. scope      full, or by drug — partial counts are what actually happen
--   2. count      blind. Scan the strip, enter what is there
--   3. variance   expected vs counted, sorted by VALUE of the discrepancy
--   4. recount    anything over a threshold goes back before it can post
--   5. approve    the doctor approves
--   6. post       one `adjust` movement per batch, with the take id as reason

create type stock_take_status as enum ('counting', 'review', 'approved', 'cancelled');

create table stock_takes (
  id            uuid primary key default gen_random_uuid(),
  status        stock_take_status not null default 'counting',
  scope_note    text,
  counted_by    uuid not null references staff (id),
  started_at    timestamptz not null default now(),
  submitted_at  timestamptz,
  -- The doctor approves. Only then do adjustment rows post.
  approved_by   uuid references staff (id),
  approved_at   timestamptz,
  -- Sorted by rupee value because this report is also the theft-and-drift
  -- detector, and 3 missing insulin pens matter more than 300 missing tablets.
  recount_threshold_value numeric(12, 2) not null default 500
    check (recount_threshold_value >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index stock_takes_open_idx on stock_takes (started_at desc)
  where status in ('counting', 'review');

create table stock_take_lines (
  id            uuid primary key default gen_random_uuid(),
  take_id       uuid not null references stock_takes (id),
  batch_id      uuid not null references stock_batches (id),
  drug_id       uuid not null references drugs (id),
  counted_qty_base int not null check (counted_qty_base >= 0),
  -- Captured at the moment of counting, not at approval: sales continue during
  -- a stock-take, and the variance has to be against the shelf as it was when
  -- the person was standing in front of it.
  system_qty_base  int not null,
  counted_at    timestamptz not null default now(),
  -- Second count, when the first one moved enough money to be worth checking.
  recount_qty_base int,
  recounted_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (take_id, batch_id)
);

create index stock_take_lines_take_idx on stock_take_lines (take_id);

create trigger stock_takes_touch before update on stock_takes
  for each row execute function app.touch_updated_at();
create trigger stock_take_lines_touch before update on stock_take_lines
  for each row execute function app.touch_updated_at();

alter table stock_takes      enable row level security;
alter table stock_take_lines enable row level security;

grant select on stock_takes to authenticated;

-- THE BLIND ENFORCEMENT.
--
-- Column-level grants, because a column-level REVOKE against a table-level
-- grant is silently a no-op (learned the hard way on staff.pin_hash). The
-- counting role can read what it counted and never what the system expected.
grant select (id, take_id, batch_id, drug_id, counted_qty_base, counted_at,
              recount_qty_base, recounted_at)
  on stock_take_lines to authenticated;

revoke insert, update, delete on stock_takes, stock_take_lines from authenticated, anon;

create policy stock_takes_read on stock_takes
  for select to authenticated using (app.current_staff_id() is not null);
create policy stock_take_lines_read on stock_take_lines
  for select to authenticated using (app.current_staff_id() is not null);

-- ---------------------------------------------------------------------------
-- The variance report. Available only once counting is closed.
--
-- Sorted by the value of the discrepancy rather than its size: that is what
-- makes this the theft-and-drift detector rather than a list of rounding.
-- ---------------------------------------------------------------------------
-- Deliberately NOT security_invoker. The column grant above denies the
-- counting role any access to system_qty_base, and a view running as the
-- caller would be denied it too — enforcing blindness so hard that the
-- variance report could never be produced. So the two mechanisms split the
-- job: the column grant stops anyone reading the expected quantity directly,
-- and the WHERE clause below decides when it becomes available at all.
create view stock_take_variance as
select
  l.take_id,
  t.status,
  l.batch_id,
  l.drug_id,
  d.name              as drug_name,
  b.batch_no,
  b.expiry,
  l.system_qty_base,
  coalesce(l.recount_qty_base, l.counted_qty_base) as counted_qty_base,
  coalesce(l.recount_qty_base, l.counted_qty_base) - l.system_qty_base as variance_base,
  round(
    (coalesce(l.recount_qty_base, l.counted_qty_base) - l.system_qty_base)
    * b.cost_per_base_unit, 2) as variance_value,
  l.recount_qty_base is null
    and abs(l.counted_qty_base - l.system_qty_base) * b.cost_per_base_unit
        > t.recount_threshold_value as needs_recount
from stock_take_lines l
join stock_takes t on t.id = l.take_id
join stock_batches b on b.id = l.batch_id
join drugs d on d.id = l.drug_id
-- Nothing is visible while the counting is still happening. This is the
-- difference between a blind count and a count with the answers in the margin.
where t.status <> 'counting';

comment on view stock_take_variance is
  'Empty while counting. Order by abs(variance_value) desc — it is the theft-and-drift detector (INVENTORY.md §5).';

grant select on stock_take_variance to authenticated;

-- ---------------------------------------------------------------------------
-- app.start_stock_take
-- ---------------------------------------------------------------------------
create or replace function app.start_stock_take(
  p_scope_note text default null,
  p_recount_threshold_value numeric default 500
) returns stock_takes
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_row      stock_takes;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  -- A second concurrent count of the same shelf produces two answers and no
  -- way to choose between them.
  if exists (select 1 from stock_takes where status = 'counting') then
    raise exception 'a stock-take is already in progress' using errcode = 'CL014';
  end if;

  insert into stock_takes (counted_by, scope_note, recount_threshold_value)
  values (v_staff_id, p_scope_note, coalesce(p_recount_threshold_value, 500))
  returning * into v_row;

  perform app.write_audit('start_stock_take', 'stock_takes', v_row.id, null,
    jsonb_build_object('scope_note', p_scope_note));

  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- app.count_batch — step 2, and the only step the counter performs.
--
-- Note what it does NOT return: the system quantity. The caller learns nothing
-- about whether they were right, which is the entire point.
-- ---------------------------------------------------------------------------
create or replace function app.count_batch(
  p_take_id  uuid,
  p_batch_id uuid,
  p_counted_qty_base int
) returns void
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_take     stock_takes;
  v_batch    stock_batches;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  select * into v_take from stock_takes where id = p_take_id;
  if not found then
    raise exception 'unknown stock-take %', p_take_id using errcode = 'CL006';
  end if;

  if p_counted_qty_base < 0 then
    raise exception 'a count cannot be negative' using errcode = 'CL006';
  end if;

  select * into v_batch from stock_batches where id = p_batch_id;
  if not found then
    raise exception 'unknown batch %', p_batch_id using errcode = 'CL006';
  end if;

  if v_take.status = 'counting' then
    insert into stock_take_lines
      (take_id, batch_id, drug_id, counted_qty_base, system_qty_base)
    values
      (p_take_id, p_batch_id, v_batch.drug_id, p_counted_qty_base, v_batch.qty_base_on_hand)
    on conflict (take_id, batch_id) do update
      set counted_qty_base = excluded.counted_qty_base,
          system_qty_base  = excluded.system_qty_base,
          counted_at       = now();

  elsif v_take.status = 'review' then
    -- Step 4: the second count, for lines the variance flagged.
    update stock_take_lines
    set recount_qty_base = p_counted_qty_base, recounted_at = now()
    where take_id = p_take_id and batch_id = p_batch_id;

    if not found then
      raise exception 'that batch was not part of this count' using errcode = 'CL006';
    end if;

  else
    raise exception 'this stock-take is % and cannot be counted into', v_take.status
      using errcode = 'CL007';
  end if;
end
$$;

create or replace function app.submit_stock_take(p_take_id uuid)
returns stock_takes
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_row      stock_takes;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  update stock_takes
  set status = 'review', submitted_at = now()
  where id = p_take_id and status = 'counting'
  returning * into v_row;

  if not found then
    raise exception 'that stock-take is not being counted' using errcode = 'CL007';
  end if;

  perform app.write_audit('submit_stock_take', 'stock_takes', p_take_id,
    jsonb_build_object('status', 'counting'), jsonb_build_object('status', 'review'));

  return v_row;
end
$$;

-- ---------------------------------------------------------------------------
-- app.approve_stock_take — steps 5 and 6, in one transaction.
--
-- This is the only thing in the build that writes an `adjust` movement, and it
-- is deliberately the narrowest possible door: the doctor, after a variance
-- report, with every over-threshold line recounted.
-- ---------------------------------------------------------------------------
create or replace function app.approve_stock_take(p_take_id uuid)
returns int
language plpgsql security definer set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_take     stock_takes;
  v_line     record;
  v_posted   int := 0;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if app.current_staff_role() not in ('doctor', 'admin') then
    raise exception 'a stock-take is approved by the doctor' using errcode = 'CL005';
  end if;

  select * into v_take from stock_takes where id = p_take_id for update;
  if not found then
    raise exception 'unknown stock-take %', p_take_id using errcode = 'CL006';
  end if;

  if v_take.status <> 'review' then
    raise exception 'this stock-take is %, not awaiting approval', v_take.status
      using errcode = 'CL007';
  end if;

  -- Step 4 is a gate, not a suggestion. A discrepancy worth real money is
  -- counted twice before anybody writes it into the ledger.
  if exists (select 1 from stock_take_variance where take_id = p_take_id and needs_recount) then
    raise exception 'some lines are over the recount threshold and have not been counted again'
      using errcode = 'CL015';
  end if;

  for v_line in
    select * from stock_take_variance where take_id = p_take_id and variance_base <> 0
  loop
    -- One adjust movement per batch, with the stock-take id as the reason.
    insert into stock_movements
      (drug_id, batch_id, qty_base, type, ref_type, ref_id, staff_id, reason)
    values
      (v_line.drug_id, v_line.batch_id, v_line.variance_base, 'adjust',
       'stock_take', p_take_id, v_staff_id,
       'stock-take ' || p_take_id::text);

    update stock_batches
    set qty_base_on_hand = qty_base_on_hand + v_line.variance_base
    where id = v_line.batch_id;

    v_posted := v_posted + 1;
  end loop;

  update stock_takes
  set status = 'approved', approved_by = v_staff_id, approved_at = now()
  where id = p_take_id;

  perform app.write_audit('approve_stock_take', 'stock_takes', p_take_id,
    jsonb_build_object('status', 'review'),
    jsonb_build_object('status', 'approved', 'batches_adjusted', v_posted));

  return v_posted;
end
$$;

revoke all on function app.start_stock_take(text, numeric) from public;
revoke all on function app.count_batch(uuid, uuid, int) from public;
revoke all on function app.submit_stock_take(uuid) from public;
revoke all on function app.approve_stock_take(uuid) from public;

grant execute on function app.start_stock_take(text, numeric) to authenticated, service_role;
grant execute on function app.count_batch(uuid, uuid, int) to authenticated, service_role;
grant execute on function app.submit_stock_take(uuid) to authenticated, service_role;
grant execute on function app.approve_stock_take(uuid) to authenticated, service_role;

comment on function app.count_batch(uuid, uuid, int) is
  'Returns nothing. The counter learns nothing about whether they were right — that is what blind means.';
