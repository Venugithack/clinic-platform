-- Billing. PLAN.md §8 M4, §18 Q3 and Q4.
--
-- `bills` has existed since 0500 with the columns a bill needs. What it has
-- never had is a number, lines, or any way to be raised — which is the point of
-- this migration and of the three things below that are not obvious.
--
-- 1. THE NUMBER IS GAPLESS, AND PER FINANCIAL YEAR.
--
--    A tax invoice series has to be sequential and unbroken (and it restarts
--    each Indian financial year, 1 April). A sequence is the wrong tool: a
--    rolled-back transaction consumes a sequence value and leaves a hole that
--    cannot be explained to an inspector. So the counter is a row, taken with
--    `for update` inside the same transaction as the bill — a rollback gives
--    the number back. It serialises billing, which at sixty bills a day is a
--    non-issue and at any volume this clinic will ever see remains one.
--
--    Q4 deferred GST *billing*. It did not defer being able to switch it on:
--    the number series, HSN and the per-line tax field are all captured now, so
--    the day he registers is a rate table and a layout change (INVENTORY.md §4).
--
-- 2. A CANCELLED BILL IS A STATUS, NEVER A DELETE.
--
--    Deleting one puts a hole in the series, which is the one thing the series
--    exists to prevent. Voiding is recorded with who and why, and a paid bill
--    can only be voided by the doctor, because that is a refund and the cash
--    has to come back out of the till.
--
-- 3. ROUNDING GOES DOWN.
--
--    Bills round to the rupee. Rounding UP can push a line past the MRP printed
--    on the strip, and selling above MRP is illegal — so the paise are dropped,
--    never added. It costs the clinic under fifty paise a bill and removes a
--    class of problem entirely. `clinic.round_to_rupee` can turn it off; it
--    cannot make it round up.
--
-- Error codes added here:
--   CL019  a till is already open
--   CL020  no till is open, and this is cash
--   CL021  the payment does not settle the bill

-- ---------------------------------------------------------------------------
-- Settings. The doctor configures these once (PLAN.md §18 Q10 established that
-- clinic policy is settings rather than constants).
-- ---------------------------------------------------------------------------
alter table clinic
  add column consult_fee          numeric(12, 2) not null default 0
    check (consult_fee >= 0),
  -- Off by default and deliberately so: "a follow-up within a week is free" is
  -- a very common policy and it is HIS to set, not one to assume. Null means
  -- every visit is charged.
  add column follow_up_free_days  int check (follow_up_free_days >= 0),
  add column round_to_rupee       boolean not null default true;

comment on column clinic.follow_up_free_days is
  'Null = every consult is charged. Set it and a repeat visit inside the window defaults to no charge, overridable per bill.';

create or replace function app.financial_year(p_date date)
returns text
language sql
immutable
as $$
  -- 1 April to 31 March. 12 Aug 2026 is "2026-27"; 12 Feb 2027 is also "2026-27".
  select case
    when extract(month from p_date) >= 4
      then to_char(p_date, 'YYYY') || '-' || to_char(p_date + interval '1 year', 'YY')
    else to_char(p_date - interval '1 year', 'YYYY') || '-' || to_char(p_date, 'YY')
  end
$$;

create table bill_counters (
  financial_year text primary key,
  last_no        int not null default 0 check (last_no >= 0)
);

comment on table bill_counters is
  'One row per financial year, taken FOR UPDATE inside app.raise_bill. A sequence would leave gaps on rollback, and a gap in an invoice series is the thing the series exists to rule out.';

alter table bills
  add column bill_no            text unique,
  add column financial_year     text,
  add column raised_by          uuid references staff (id),
  -- Negative or zero. See note 3 above.
  add column round_off          numeric(12, 2) not null default 0
    check (round_off <= 0),
  add column consult_fee_basis  text not null default 'standard'
    check (consult_fee_basis in ('standard', 'follow_up_free', 'manual')),
  add column note               text,
  add column voided_by          uuid references staff (id),
  add column voided_at          timestamptz,
  add column void_reason        text;

create index bills_day_idx on bills (created_at);

-- What is printed, and what survives a later correction upstream. A bill line
-- is a copy on purpose: the price on a printed bill must not change because
-- somebody fixed a cost or a pack size next month.
create table bill_lines (
  id               uuid primary key default gen_random_uuid(),
  bill_id          uuid not null references bills (id),
  kind             text not null check (kind in ('consult', 'medicine', 'other')),
  description      text not null,
  drug_id          uuid references drugs (id),
  dispense_line_id uuid references dispense_lines (id),
  batch_no         text,
  expiry           date,
  qty_base         int,
  unit_price       numeric(12, 4),
  amount           numeric(12, 2) not null check (amount >= 0),
  hsn              text,
  -- Captured, empty, and ready (Q4). Switching GST on writes rates in here.
  tax              jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index bill_lines_bill_idx on bill_lines (bill_id);

create trigger bill_lines_touch before update on bill_lines
  for each row execute function app.touch_updated_at();

alter table bill_lines enable row level security;
grant select on bill_lines to authenticated;
revoke insert, update, delete on bill_lines, bill_counters from authenticated, anon;
grant select on bill_counters to authenticated;

create policy bill_lines_read on bill_lines
  for select to authenticated using (app.current_staff_id() is not null);

alter table bill_counters enable row level security;
create policy bill_counters_read on bill_counters
  for select to authenticated using (app.current_staff_id() is not null);

-- ---------------------------------------------------------------------------
-- The till. INVENTORY.md is silent on cash; PLAN.md §18 Q3 added it with the
-- counter sale, and the reason is simple — a pharmacy counter that takes cash
-- and never counts it has no way to tell a mistake from a theft.
-- ---------------------------------------------------------------------------
create type till_status as enum ('open', 'closed');

create table till_sessions (
  id             uuid primary key default gen_random_uuid(),
  status         till_status not null default 'open',
  opened_by      uuid not null references staff (id),
  opened_at      timestamptz not null default now(),
  opening_float  numeric(12, 2) not null default 0 check (opening_float >= 0),
  closed_by      uuid references staff (id),
  closed_at      timestamptz,
  -- What was physically counted at close, and what the system said there should
  -- be. Both are kept: the variance is the number worth looking at, and it is
  -- meaningless without the two it came from.
  counted_cash   numeric(12, 2) check (counted_cash >= 0),
  expected_cash  numeric(12, 2),
  variance       numeric(12, 2),
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index till_only_one_open on till_sessions (status)
  where status = 'open';

create table cash_movements (
  id         uuid primary key default gen_random_uuid(),
  till_id    uuid not null references till_sessions (id),
  kind       text not null check (kind in ('sale', 'refund', 'payin', 'payout')),
  -- Signed, like the stock ledger: money in is positive, money out is negative.
  amount     numeric(12, 2) not null check (amount <> 0),
  bill_id    uuid references bills (id),
  staff_id   uuid not null references staff (id),
  reason     text,
  at         timestamptz not null default now()
);

create index cash_movements_till_idx on cash_movements (till_id, at);

-- Append-only, for the same reason the stock ledger is: a cash record that can
-- be edited after the count reconciles to whatever the person editing wants.
create trigger cash_movements_is_append_only
  before update or delete on cash_movements
  for each row execute function app.refuse_mutation();

create trigger till_sessions_touch before update on till_sessions
  for each row execute function app.touch_updated_at();

alter table till_sessions   enable row level security;
alter table cash_movements  enable row level security;

grant select on till_sessions, cash_movements to authenticated;
revoke insert, update, delete on till_sessions, cash_movements from authenticated, anon;

create policy till_sessions_read on till_sessions
  for select to authenticated using (app.current_staff_id() is not null);
create policy cash_movements_read on cash_movements
  for select to authenticated using (app.current_staff_id() is not null);

-- ---------------------------------------------------------------------------
-- app.raise_bill
--
-- p_dispense_ids: [uuid, …] — the medicines already dispensed against this
-- visit. Nothing is priced here that the dispense did not already price: the
-- bill copies dispense_lines, which were computed under the MRP ceiling inside
-- app.dispense. Two places computing a price is two places to disagree.
-- ---------------------------------------------------------------------------
create or replace function app.raise_bill(
  p_patient_id   uuid default null,
  p_encounter_id uuid default null,
  p_dispense_ids jsonb default '[]'::jsonb,
  p_consult_fee  numeric default null,
  p_discount     numeric default 0,
  p_note         text default null
) returns bills
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id   uuid;
  v_clinic     clinic%rowtype;
  v_bill       bills;
  v_line       record;
  v_fee        numeric(12, 2);
  v_basis      text;
  v_medicines  numeric(12, 2) := 0;
  v_discount   numeric(12, 2) := coalesce(p_discount, 0);
  v_subtotal   numeric(12, 2);
  v_total      numeric(12, 2);
  v_round      numeric(12, 2) := 0;
  v_fy         text;
  v_no         int;
  v_patient_id uuid := p_patient_id;
  v_ids        uuid[];
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  select * into v_clinic from clinic limit 1;

  select coalesce(array_agg((value #>> '{}')::uuid), '{}')
  into v_ids
  from jsonb_array_elements(coalesce(p_dispense_ids, '[]'::jsonb));

  -- A bill for nothing is not a bill.
  if coalesce(array_length(v_ids, 1), 0) = 0 and coalesce(p_consult_fee, v_clinic.consult_fee) = 0 then
    raise exception 'a bill needs a consult fee or at least one dispense'
      using errcode = 'CL006';
  end if;

  if v_discount < 0 then
    raise exception 'a discount cannot be negative' using errcode = 'CL006';
  end if;

  -- The consult fee: what was passed, or clinic policy applied.
  if p_consult_fee is not null then
    v_fee   := p_consult_fee;
    v_basis := 'manual';
  elsif p_encounter_id is null then
    v_fee   := 0;
    v_basis := 'standard';
  elsif v_clinic.follow_up_free_days is not null
        and exists (
          select 1
          from bills b
          join encounters e on e.id = b.encounter_id
          where e.patient_id = (select patient_id from encounters where id = p_encounter_id)
            and b.status = 'paid'
            and b.consult_fee > 0
            and b.created_at >= now() - (v_clinic.follow_up_free_days || ' days')::interval
        )
  then
    -- Policy, not inference: he set a window, and a repeat visit inside it is
    -- not charged. It is still overridable by passing a fee.
    v_fee   := 0;
    v_basis := 'follow_up_free';
  else
    v_fee   := v_clinic.consult_fee;
    v_basis := 'standard';
  end if;

  if p_encounter_id is not null and v_patient_id is null then
    select patient_id into v_patient_id from encounters where id = p_encounter_id;
  end if;

  v_fy := app.financial_year(current_date);

  insert into bill_counters (financial_year) values (v_fy)
  on conflict (financial_year) do nothing;

  -- FOR UPDATE, so a rollback hands the number back instead of burning it.
  update bill_counters
  set last_no = last_no + 1
  where financial_year = v_fy
  returning last_no into v_no;

  insert into bills (patient_id, encounter_id, consult_fee, medicines_total,
                     discount, total, status, bill_no, financial_year,
                     raised_by, consult_fee_basis, note)
  values (v_patient_id, p_encounter_id, v_fee, 0, v_discount, 0, 'unpaid',
          v_fy || '/' || lpad(v_no::text, 5, '0'), v_fy, v_staff_id, v_basis, p_note)
  returning * into v_bill;

  if v_fee > 0 then
    insert into bill_lines (bill_id, kind, description, amount)
    values (v_bill.id, 'consult', 'Consultation', v_fee);
  elsif v_basis = 'follow_up_free' then
    -- Printed at zero rather than omitted: the patient should be able to see
    -- that the follow-up was free and not wonder whether it was forgotten.
    insert into bill_lines (bill_id, kind, description, amount)
    values (v_bill.id, 'consult', 'Consultation (follow-up, no charge)', 0);
  end if;

  for v_line in
    select dl.id, dl.drug_id, dl.qty_base, dl.unit_price, dl.amount,
           d.name as drug_name, d.strength, d.hsn,
           b.batch_no, b.expiry
    from dispense_lines dl
    join dispenses  dp on dp.id = dl.dispense_id
    join drugs      d  on d.id  = dl.drug_id
    join stock_batches b on b.id = dl.batch_id
    where dp.id = any (v_ids)
    order by d.name
  loop
    insert into bill_lines (bill_id, kind, description, drug_id, dispense_line_id,
                            batch_no, expiry, qty_base, unit_price, amount, hsn)
    values (v_bill.id, 'medicine',
            v_line.drug_name || ' ' || coalesce(v_line.strength, ''),
            v_line.drug_id, v_line.id, v_line.batch_no, v_line.expiry,
            v_line.qty_base, v_line.unit_price, v_line.amount, v_line.hsn);

    v_medicines := v_medicines + v_line.amount;
  end loop;

  -- Every dispense named here is now on this bill and cannot be on another.
  update dispenses set bill_id = v_bill.id
  where id = any (v_ids) and bill_id is null;

  if exists (select 1 from dispenses where id = any (v_ids) and bill_id <> v_bill.id) then
    raise exception 'one of those dispenses is already on another bill'
      using errcode = 'CL007';
  end if;

  v_subtotal := v_fee + v_medicines;

  if v_discount > v_subtotal then
    raise exception 'a discount of % is more than the bill of %',
      to_char(v_discount, 'FM999999990.00'), to_char(v_subtotal, 'FM999999990.00')
      using errcode = 'CL006';
  end if;

  v_total := v_subtotal - v_discount;

  if v_clinic.round_to_rupee then
    -- Down, never up. See note 3 at the top of this file.
    v_round := floor(v_total) - v_total;
    v_total := floor(v_total);
  end if;

  update bills
  set medicines_total = v_medicines,
      round_off       = v_round,
      total           = v_total
  where id = v_bill.id
  returning * into v_bill;

  perform app.write_audit(
    'raise_bill', 'bills', v_bill.id, null,
    jsonb_build_object('bill_no', v_bill.bill_no, 'consult_fee', v_fee,
                       'medicines_total', v_medicines, 'discount', v_discount,
                       'total', v_total, 'basis', v_basis)
  );

  return v_bill;
end
$$;

-- ---------------------------------------------------------------------------
-- app.take_payment
--
-- The amount must settle the bill. Part-payment is deliberately not supported
-- in v1: it turns every unpaid bill into a debtor ledger, and the clinic does
-- not have one. Cash tendered and change given are a screen concern — what is
-- recorded is what the bill was settled for.
-- ---------------------------------------------------------------------------
create or replace function app.take_payment(
  p_bill_id uuid,
  p_method  text,
  p_amount  numeric
) returns bills
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_bill     bills;
  v_till     till_sessions;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'unknown bill %', p_bill_id using errcode = 'CL006';
  end if;

  if v_bill.status <> 'unpaid' then
    raise exception 'bill % is already %', v_bill.bill_no, v_bill.status
      using errcode = 'CL007';
  end if;

  if p_method not in ('cash', 'upi', 'card') then
    raise exception 'unknown payment method %', p_method using errcode = 'CL006';
  end if;

  if p_amount is distinct from v_bill.total then
    raise exception 'bill % is for %, not %',
      v_bill.bill_no,
      to_char(v_bill.total, 'FM999999990.00'),
      to_char(coalesce(p_amount, 0), 'FM999999990.00')
      using errcode = 'CL021';
  end if;

  if p_method = 'cash' then
    select * into v_till from till_sessions where status = 'open' for update;
    if not found then
      -- Cash with no till open means the day's cash cannot be reconciled
      -- against anything, which is the entire point of having a till.
      raise exception 'no till is open — open the till before taking cash'
        using errcode = 'CL020';
    end if;

    insert into cash_movements (till_id, kind, amount, bill_id, staff_id)
    values (v_till.id, 'sale', v_bill.total, v_bill.id, v_staff_id);
  end if;

  update bills
  set status = 'paid', paid_at = now(), method = p_method
  where id = p_bill_id
  returning * into v_bill;

  perform app.write_audit(
    'take_payment', 'bills', p_bill_id,
    jsonb_build_object('status', 'unpaid'),
    jsonb_build_object('status', 'paid', 'method', p_method, 'amount', p_amount)
  );

  return v_bill;
end
$$;

-- ---------------------------------------------------------------------------
-- app.void_bill — a status and a reason, never a delete.
-- ---------------------------------------------------------------------------
create or replace function app.void_bill(p_bill_id uuid, p_reason text)
returns bills
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_bill     bills;
  v_till     till_sessions;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancelled bill needs a reason' using errcode = 'CL006';
  end if;

  select * into v_bill from bills where id = p_bill_id for update;
  if not found then
    raise exception 'unknown bill %', p_bill_id using errcode = 'CL006';
  end if;

  if v_bill.status = 'cancelled' then
    raise exception 'bill % is already cancelled', v_bill.bill_no
      using errcode = 'CL007';
  end if;

  -- Voiding a paid bill is a refund: money leaves the drawer. That is the
  -- doctor's call, not a way out of a mistake at the counter.
  if v_bill.status = 'paid' and app.current_staff_role() not in ('doctor', 'admin') then
    raise exception 'bill % has been paid — only the doctor can cancel it, because that is a refund',
      v_bill.bill_no
      using errcode = 'CL005';
  end if;

  if v_bill.status = 'paid' and v_bill.method = 'cash' then
    select * into v_till from till_sessions where status = 'open' for update;
    if not found then
      raise exception 'no till is open — a cash refund has to come out of a drawer somebody is counting'
        using errcode = 'CL020';
    end if;

    insert into cash_movements (till_id, kind, amount, bill_id, staff_id, reason)
    values (v_till.id, 'refund', -v_bill.total, v_bill.id, v_staff_id, p_reason);
  end if;

  update bills
  set status = 'cancelled', voided_by = v_staff_id, voided_at = now(),
      void_reason = p_reason
  where id = p_bill_id
  returning * into v_bill;

  -- The dispenses are released, but the stock is NOT put back: cancelling a
  -- bill is a paperwork correction, and medicine that left the counter comes
  -- back through the ledger or not at all.
  update dispenses set bill_id = null where bill_id = p_bill_id;

  perform app.write_audit(
    'void_bill', 'bills', p_bill_id,
    jsonb_build_object('status', v_bill.status),
    jsonb_build_object('status', 'cancelled', 'reason', p_reason)
  );

  return v_bill;
end
$$;

revoke all on function app.raise_bill(uuid, uuid, jsonb, numeric, numeric, text) from public;
revoke all on function app.take_payment(uuid, text, numeric) from public;
revoke all on function app.void_bill(uuid, text) from public;

grant execute on function app.raise_bill(uuid, uuid, jsonb, numeric, numeric, text)
  to authenticated, service_role;
grant execute on function app.take_payment(uuid, text, numeric) to authenticated, service_role;
grant execute on function app.void_bill(uuid, text) to authenticated, service_role;

comment on function app.raise_bill(uuid, uuid, jsonb, numeric, numeric, text) is
  'Prices nothing: bill lines are copied from dispense_lines, which app.dispense already computed under the MRP ceiling.';
comment on function app.void_bill(uuid, text) is
  'Cancels with a reason. Never deletes — a hole in the invoice series is what the series exists to rule out.';
