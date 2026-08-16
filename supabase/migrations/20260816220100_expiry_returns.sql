-- Expiry, worked all the way through. INVENTORY.md §6.
--
-- PLAN.md §12.3 defines `expiring_soon`. It does not say what anybody does about
-- it, and "use it or lose it" is not a workflow. This migration is the workflow:
--
--   the list ──┬──► return to supplier ──► return note ──► credit expected
--              │                            (stock out)      │
--              ├──► dispense first (FEFO already does this)   ▼
--              └──► write off at cost      reconciled against the next invoice
--
-- The number that decides which branch is available is NOT the expiry date.
-- Most suppliers require stock back some months BEFORE it expires so the claim
-- can be processed while the drug is still good — three to six months, and it
-- differs per supplier. So the deadline is
--
--     return_by = expiry - suppliers.return_window_days
--
-- and a list built on "90 days from expiry" is already too late for a supplier
-- with a 180-day window. That is exactly why INVENTORY.md §6 says the list is
-- grouped by whose return window is closing first, *not merely by expiry date*.
-- Missing that date is pure loss: the stock stops being returnable and becomes
-- a write-off, and nobody finds out until it is money.
--
-- Error codes added here:
--   CL016  the return window has closed (or the supplier has none)
--   CL017  that batch has not expired — it cannot be written off as expiry
--   CL018  a credit cannot be settled for more than it is worth

-- ---------------------------------------------------------------------------
-- The list. Two of them, because expired stock is not "expiring soon" and the
-- two need different screens: one is a decision, the other is a loss to record.
-- ---------------------------------------------------------------------------
create view expiring_soon as
select
  b.id                            as batch_id,
  b.drug_id,
  d.name                          as drug_name,
  d.schedule,
  b.batch_no,
  b.expiry,
  (b.expiry - current_date)::int  as days_to_expiry,
  b.qty_base_on_hand,
  b.units_per_strip,
  b.strips_per_box,
  round(b.qty_base_on_hand * b.cost_per_base_unit, 2) as value_at_cost,
  b.supplier_id,
  s.name                          as supplier_name,
  s.return_window_days,
  case when s.return_window_days is not null
       then b.expiry - s.return_window_days end as return_by,
  case when s.return_window_days is not null
       then (b.expiry - s.return_window_days - current_date)::int end as days_to_return_by,
  -- The whole point of the section. Returnable is a supplier-specific date, and
  -- it passes long before the expiry does.
  coalesce(
    s.return_window_days is not null
      and current_date <= b.expiry - s.return_window_days,
    false
  ) as returnable
from stock_batches b
join drugs d on d.id = b.drug_id
left join suppliers s on s.id = b.supplier_id
where b.qty_base_on_hand > 0
  and b.expiry >= current_date
  and (
    -- Either the stock itself is close, PLAN.md §12.3's ninety days …
    b.expiry <= current_date + 90
    -- … or the door to the supplier is about to shut, which happens first and
    -- is the reason this view exists at all. Note the lower bound: a window
    -- that closed long ago on stock that is still a year from expiring is not
    -- news, it is noise. Those batches arrive here later, through the clause
    -- above, at the point where they are about to become a write-off.
    or (s.return_window_days is not null
        and b.expiry - s.return_window_days
            between current_date and current_date + 90)
  );

comment on view expiring_soon is
  'Driven by the supplier return deadline, not by the expiry date — that is what makes it actionable (INVENTORY.md §6).';

-- Expired stock is excluded from available_stock entirely (INVENTORY.md §3), so
-- without this view it is invisible: on the shelf, on the books, and on no
-- screen. This is the one place that reads stock_batches directly for quantity,
-- and it does so precisely because the batches it wants are the ones
-- available_stock is designed to hide.
create view expired_stock as
select
  b.id                            as batch_id,
  b.drug_id,
  d.name                          as drug_name,
  b.batch_no,
  b.expiry,
  (current_date - b.expiry)::int  as days_expired,
  b.qty_base_on_hand,
  round(b.qty_base_on_hand * b.cost_per_base_unit, 2) as value_at_cost,
  b.supplier_id,
  s.name                          as supplier_name
from stock_batches b
join drugs d on d.id = b.drug_id
left join suppliers s on s.id = b.supplier_id
where b.qty_base_on_hand > 0
  and b.expiry < current_date;

comment on view expired_stock is
  'The write-off queue. Expired stock is hidden from availability by design, which is exactly why it needs a list of its own.';

-- ---------------------------------------------------------------------------
-- Return notes and the credits they open.
-- ---------------------------------------------------------------------------
create table supplier_returns (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid not null references suppliers (id),
  returned_by   uuid not null references staff (id),
  returned_at   timestamptz not null default now(),
  note          text,
  total_at_cost numeric(12, 2) not null default 0 check (total_at_cost >= 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table supplier_return_lines (
  id                 uuid primary key default gen_random_uuid(),
  return_id          uuid not null references supplier_returns (id),
  batch_id           uuid not null references stock_batches (id),
  drug_id            uuid not null references drugs (id),
  qty_base           int not null check (qty_base > 0),
  cost_per_base_unit numeric(12, 4) not null check (cost_per_base_unit >= 0),
  amount             numeric(12, 2) not null check (amount >= 0),
  -- The date this line had to be back by. Recorded rather than recomputed: the
  -- supplier can change their window next year, and what mattered is what the
  -- window was on the day the stock went back.
  return_by          date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index supplier_return_lines_return_idx on supplier_return_lines (return_id);

create type supplier_credit_status as enum ('open', 'settled', 'written_off');

-- A credit is a promise the supplier has made and not yet kept. The reason it
-- is a table rather than a number on the return note is that it has to still be
-- visible in three months, when it is being netted off an invoice by somebody
-- who was not there — "so unreturned credits are visible instead of forgotten".
create table supplier_credits (
  id              uuid primary key default gen_random_uuid(),
  supplier_id     uuid not null references suppliers (id),
  return_id       uuid references supplier_returns (id),
  amount_expected numeric(12, 2) not null check (amount_expected >= 0),
  amount_settled  numeric(12, 2) not null default 0 check (amount_settled >= 0),
  status          supplier_credit_status not null default 'open',
  opened_at       timestamptz not null default now(),
  settled_at      timestamptz,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint credit_cannot_oversettle check (amount_settled <= amount_expected)
);

create index supplier_credits_open_idx on supplier_credits (supplier_id)
  where status = 'open';

-- Reconciliation, one row per time a credit is netted off an invoice. Partial
-- settlement is the normal case: a ₹4,000 credit comes off three invoices.
create table supplier_credit_settlements (
  id          uuid primary key default gen_random_uuid(),
  credit_id   uuid not null references supplier_credits (id),
  grn_id      uuid not null references goods_receipts (id),
  amount      numeric(12, 2) not null check (amount > 0),
  settled_by  uuid not null references staff (id),
  at          timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index supplier_credit_settlements_credit_idx
  on supplier_credit_settlements (credit_id);

create trigger supplier_returns_touch before update on supplier_returns
  for each row execute function app.touch_updated_at();
create trigger supplier_return_lines_touch before update on supplier_return_lines
  for each row execute function app.touch_updated_at();
create trigger supplier_credits_touch before update on supplier_credits
  for each row execute function app.touch_updated_at();

alter table supplier_returns             enable row level security;
alter table supplier_return_lines        enable row level security;
alter table supplier_credits             enable row level security;
alter table supplier_credit_settlements  enable row level security;

grant select on supplier_returns, supplier_return_lines, supplier_credits,
                supplier_credit_settlements to authenticated;
revoke insert, update, delete on supplier_returns, supplier_return_lines,
                                 supplier_credits, supplier_credit_settlements
  from authenticated, anon;

create policy supplier_returns_read on supplier_returns
  for select to authenticated using (app.current_staff_id() is not null);
create policy supplier_return_lines_read on supplier_return_lines
  for select to authenticated using (app.current_staff_id() is not null);
create policy supplier_credits_read on supplier_credits
  for select to authenticated using (app.current_staff_id() is not null);
create policy supplier_credit_settlements_read on supplier_credit_settlements
  for select to authenticated using (app.current_staff_id() is not null);

create view open_supplier_credits as
select
  c.id            as credit_id,
  c.supplier_id,
  s.name          as supplier_name,
  c.return_id,
  c.amount_expected,
  c.amount_settled,
  c.amount_expected - c.amount_settled as outstanding,
  c.opened_at,
  (current_date - c.opened_at::date)::int as days_open
from supplier_credits c
join suppliers s on s.id = c.supplier_id
where c.status = 'open';

comment on view open_supplier_credits is
  'Money the supplier owes the clinic. Ageing included, because a credit nobody chases is a discount to the supplier.';

grant select on expiring_soon, expired_stock, open_supplier_credits to authenticated;

-- ---------------------------------------------------------------------------
-- app.return_to_supplier
--
-- p_lines: [{ batch_id, qty_base }]
--
-- Stock leaves through the ledger, exactly as it does at the counter. The
-- credit is opened in the same transaction, because a return note without a
-- credit is how the clinic forgets it is owed money.
-- ---------------------------------------------------------------------------
create or replace function app.return_to_supplier(
  p_lines       jsonb,
  p_supplier_id uuid,
  p_note        text default null
) returns supplier_returns
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id  uuid;
  v_supplier  suppliers%rowtype;
  v_return    supplier_returns;
  v_line      jsonb;
  v_batch     stock_batches%rowtype;
  v_drug_name text;
  v_qty       int;
  v_return_by date;
  v_amount    numeric(12, 2);
  v_total     numeric(12, 2) := 0;
  v_credit_id uuid;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a return needs at least one line' using errcode = 'CL006';
  end if;

  select * into v_supplier from suppliers where id = p_supplier_id;
  if not found then
    raise exception 'unknown supplier %', p_supplier_id using errcode = 'CL006';
  end if;

  -- No window recorded is not "no limit" — it is not knowing, and shipping
  -- stock back on a guess is how a clinic ends up with neither the stock nor
  -- the credit.
  if v_supplier.return_window_days is null then
    raise exception
      'no return window is recorded for %, so nothing can be sent back until somebody asks them',
      v_supplier.name
      using errcode = 'CL016';
  end if;

  insert into supplier_returns (supplier_id, returned_by, note)
  values (p_supplier_id, v_staff_id, p_note)
  returning * into v_return;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_batch from stock_batches
    where id = (v_line ->> 'batch_id')::uuid
    for update;

    if not found then
      raise exception 'unknown batch %', v_line ->> 'batch_id' using errcode = 'CL006';
    end if;

    select name into v_drug_name from drugs where id = v_batch.drug_id;

    if v_batch.supplier_id is not null and v_batch.supplier_id <> p_supplier_id then
      raise exception 'batch "%" of "%" did not come from % — it cannot be returned to them',
        v_batch.batch_no, v_drug_name, v_supplier.name
        using errcode = 'CL006';
    end if;

    v_qty := coalesce((v_line ->> 'qty_base')::int, v_batch.qty_base_on_hand);
    if v_qty <= 0 then
      raise exception 'a return line has to send something back' using errcode = 'CL006';
    end if;

    if v_qty > v_batch.qty_base_on_hand then
      raise exception
        'only % of "%" batch "%" is on the shelf — % cannot be returned',
        v_batch.qty_base_on_hand, v_drug_name, v_batch.batch_no, v_qty
        using errcode = 'CL001';
    end if;

    -- The refusal this whole section exists for.
    v_return_by := v_batch.expiry - v_supplier.return_window_days;
    if current_date > v_return_by then
      raise exception
        '%''s return window for batch "%" of "%" closed on % — it expires % and can only be dispensed or written off now',
        v_supplier.name, v_batch.batch_no, v_drug_name,
        to_char(v_return_by, 'DD Mon YYYY'), to_char(v_batch.expiry, 'Mon YYYY')
        using errcode = 'CL016';
    end if;

    v_amount := round(v_qty * v_batch.cost_per_base_unit, 2);

    insert into supplier_return_lines
      (return_id, batch_id, drug_id, qty_base, cost_per_base_unit, amount, return_by)
    values
      (v_return.id, v_batch.id, v_batch.drug_id, v_qty,
       v_batch.cost_per_base_unit, v_amount, v_return_by);

    insert into stock_movements
      (drug_id, batch_id, qty_base, type, ref_type, ref_id, staff_id, reason)
    values
      (v_batch.drug_id, v_batch.id, -v_qty, 'return_out', 'supplier_return',
       v_return.id, v_staff_id, 'returned to ' || v_supplier.name);

    update stock_batches
    set qty_base_on_hand = qty_base_on_hand - v_qty
    where id = v_batch.id;

    v_total := v_total + v_amount;
  end loop;

  update supplier_returns set total_at_cost = v_total
  where id = v_return.id
  returning * into v_return;

  -- The credit, opened here rather than by a person who remembers to.
  insert into supplier_credits (supplier_id, return_id, amount_expected)
  values (p_supplier_id, v_return.id, v_total)
  returning id into v_credit_id;

  perform app.write_audit(
    'return_to_supplier', 'supplier_returns', v_return.id, null,
    jsonb_build_object('supplier_id', p_supplier_id,
                       'lines', jsonb_array_length(p_lines),
                       'total_at_cost', v_total,
                       'credit_id', v_credit_id)
  );

  return v_return;
end
$$;

-- ---------------------------------------------------------------------------
-- app.write_off_expired
--
-- p_lines: [{ batch_id, qty_base? }] — qty defaults to the whole batch, which
-- is the ordinary case: it is expired, all of it goes.
--
-- Returns the value written off, at cost. That number is the point of the
-- exercise (INVENTORY.md §4, "expiry loss reported monthly") — a write-off that
-- does not tell the doctor what it cost him teaches nobody anything.
-- ---------------------------------------------------------------------------
create or replace function app.write_off_expired(
  p_lines  jsonb,
  p_reason text default null
) returns numeric
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id  uuid;
  v_line      jsonb;
  v_batch     stock_batches%rowtype;
  v_drug_name text;
  v_qty       int;
  v_total     numeric(12, 2) := 0;
  v_batches   int := 0;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a write-off needs at least one line' using errcode = 'CL006';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_batch from stock_batches
    where id = (v_line ->> 'batch_id')::uuid
    for update;

    if not found then
      raise exception 'unknown batch %', v_line ->> 'batch_id' using errcode = 'CL006';
    end if;

    select name into v_drug_name from drugs where id = v_batch.drug_id;

    -- This transition writes off expiry and nothing else. Stock that is still
    -- good has two better outcomes — sell it, or send it back while the window
    -- is open — and destroying it because a screen offered the button is the
    -- expensive mistake this refusal exists to prevent. Damage and breakage are
    -- a different reason code and a different day's work.
    if v_batch.expiry >= current_date then
      raise exception
        'batch "%" of "%" expires % and has not expired yet — dispense it, or send it back while the supplier''s window is open',
        v_batch.batch_no, v_drug_name, to_char(v_batch.expiry, 'Mon YYYY')
        using errcode = 'CL017';
    end if;

    v_qty := coalesce((v_line ->> 'qty_base')::int, v_batch.qty_base_on_hand);

    if v_qty <= 0 then
      raise exception 'a write-off line has to write something off' using errcode = 'CL006';
    end if;

    if v_qty > v_batch.qty_base_on_hand then
      raise exception
        'only % of "%" batch "%" is on the shelf — % cannot be written off',
        v_batch.qty_base_on_hand, v_drug_name, v_batch.batch_no, v_qty
        using errcode = 'CL001';
    end if;

    insert into stock_movements
      (drug_id, batch_id, qty_base, type, ref_type, ref_id, staff_id, reason)
    values
      (v_batch.drug_id, v_batch.id, -v_qty, 'writeoff_expiry', 'stock_batch',
       v_batch.id, v_staff_id, coalesce(p_reason, 'expired ' || to_char(v_batch.expiry, 'Mon YYYY')));

    update stock_batches
    set qty_base_on_hand = qty_base_on_hand - v_qty
    where id = v_batch.id;

    -- One audit row per batch rather than one per call: the question anybody
    -- asks later is "what happened to this batch", and audit_log is indexed to
    -- answer exactly that.
    perform app.write_audit(
      'write_off_expired', 'stock_batches', v_batch.id, null,
      jsonb_build_object('qty_base', v_qty,
                         'value_at_cost', round(v_qty * v_batch.cost_per_base_unit, 2),
                         'expiry', v_batch.expiry,
                         'reason', p_reason)
    );

    v_total   := v_total + round(v_qty * v_batch.cost_per_base_unit, 2);
    v_batches := v_batches + 1;
  end loop;

  return v_total;
end
$$;

-- ---------------------------------------------------------------------------
-- app.settle_credit — the last step of INVENTORY.md §6's diagram.
--
-- "Credits are reconciled against subsequent supplier invoices, so unreturned
--  credits are visible instead of forgotten."
-- ---------------------------------------------------------------------------
create or replace function app.settle_credit(
  p_credit_id uuid,
  p_grn_id    uuid,
  p_amount    numeric
) returns supplier_credits
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id    uuid;
  v_credit      supplier_credits;
  v_grn         goods_receipts;
  v_outstanding numeric(12, 2);
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  select * into v_credit from supplier_credits where id = p_credit_id for update;
  if not found then
    raise exception 'unknown credit %', p_credit_id using errcode = 'CL006';
  end if;

  select * into v_grn from goods_receipts where id = p_grn_id;
  if not found then
    raise exception 'unknown goods receipt %', p_grn_id using errcode = 'CL006';
  end if;

  if v_grn.supplier_id is distinct from v_credit.supplier_id then
    raise exception 'that credit belongs to a different supplier than that invoice'
      using errcode = 'CL006';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'a settlement has to be for something' using errcode = 'CL006';
  end if;

  v_outstanding := v_credit.amount_expected - v_credit.amount_settled;

  -- A credit settled for more than it is worth is either a typo or the wrong
  -- credit, and both are cheaper to catch here than in a ledger reconciliation
  -- three months later.
  if p_amount > v_outstanding then
    raise exception 'only % is outstanding on that credit — % cannot be settled against it',
      to_char(v_outstanding, 'FM999999990.00'), to_char(p_amount, 'FM999999990.00')
      using errcode = 'CL018';
  end if;

  insert into supplier_credit_settlements (credit_id, grn_id, amount, settled_by)
  values (p_credit_id, p_grn_id, p_amount, v_staff_id);

  update supplier_credits
  set amount_settled = amount_settled + p_amount,
      status         = case when amount_settled + p_amount >= amount_expected
                            then 'settled' else 'open' end::supplier_credit_status,
      settled_at     = case when amount_settled + p_amount >= amount_expected
                            then now() else null end
  where id = p_credit_id
  returning * into v_credit;

  perform app.write_audit(
    'settle_credit', 'supplier_credits', p_credit_id,
    jsonb_build_object('amount_settled', v_credit.amount_settled - p_amount),
    jsonb_build_object('amount_settled', v_credit.amount_settled,
                       'grn_id', p_grn_id, 'status', v_credit.status)
  );

  return v_credit;
end
$$;

revoke all on function app.return_to_supplier(jsonb, uuid, text) from public;
revoke all on function app.write_off_expired(jsonb, text)         from public;
revoke all on function app.settle_credit(uuid, uuid, numeric)     from public;

grant execute on function app.return_to_supplier(jsonb, uuid, text)
  to authenticated, service_role;
grant execute on function app.write_off_expired(jsonb, text)
  to authenticated, service_role;
grant execute on function app.settle_credit(uuid, uuid, numeric)
  to authenticated, service_role;

comment on function app.return_to_supplier(jsonb, uuid, text) is
  'Stock out through the ledger, credit opened in the same transaction. Refuses a window that has closed (INVENTORY.md §6).';
comment on function app.write_off_expired(jsonb, text) is
  'Expiry only. Stock that has not expired has two better outcomes and this refuses to destroy it.';
comment on function app.settle_credit(uuid, uuid, numeric) is
  'Nets a supplier credit off a later invoice, partially where that is what happened.';
