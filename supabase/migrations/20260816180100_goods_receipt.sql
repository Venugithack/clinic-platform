-- M3 — goods receipt. Stock arrives through the ledger or it does not arrive.
--
-- Until now the only stock in the system came from the seed, which wrote a
-- batch and a matching `receipt` row by hand. This is the transition that does
-- it properly, and it is the second of the twelve that BUILD.md §1.5's pattern
-- was built for.
--
-- The receiving screen is the heaviest data entry in the build (TABLET.md §7),
-- and it is also the one place where a typo is expensive for years: a mistyped
-- expiry year silently ages or rejuvenates a batch, and FEFO then hands out the
-- wrong box for the rest of that batch's life. Hence the two refusals from
-- INVENTORY.md §3 that exist purely to catch a mistyped year at the door.

create table goods_receipts (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid references suppliers (id),
  po_id         uuid,
  invoice_no    text,
  invoice_date  date,
  received_by   uuid not null references staff (id),
  received_at   timestamptz not null default now(),
  total         numeric(12, 2) not null default 0 check (total >= 0),
  -- INVENTORY.md §3, the sold-before-received case: stock is physically on the
  -- shelf but the paperwork is not entered, which happens daily in a real
  -- pharmacy. The tempting fix is to allow negative stock; the right one is to
  -- post a real receipt now and flag it for the invoice to be attached later.
  -- That leaves a work queue instead of a lie.
  awaiting_invoice boolean not null default false,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint invoiced_receipts_name_the_invoice check (
    awaiting_invoice or invoice_no is not null
  )
);

create index goods_receipts_awaiting_idx
  on goods_receipts (received_at desc)
  where awaiting_invoice;

create table grn_lines (
  id          uuid primary key default gen_random_uuid(),
  grn_id      uuid not null references goods_receipts (id),
  drug_id     uuid not null references drugs (id),
  batch_id    uuid not null references stock_batches (id),
  qty_base    int not null check (qty_base > 0),
  -- Free goods are stock the clinic did not pay for. They still enter the
  -- ledger, but they must not raise the average cost of what did cost money.
  free_qty_base int not null default 0 check (free_qty_base >= 0),
  cost_per_base_unit numeric(12, 4) not null check (cost_per_base_unit >= 0),
  mrp         numeric(12, 2) not null check (mrp >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index grn_lines_grn_idx on grn_lines (grn_id);

alter table stock_batches
  add constraint stock_batches_grn_fkey foreign key (grn_id) references goods_receipts (id);

create trigger goods_receipts_touch before update on goods_receipts
  for each row execute function app.touch_updated_at();
create trigger grn_lines_touch before update on grn_lines
  for each row execute function app.touch_updated_at();

alter table goods_receipts enable row level security;
alter table grn_lines      enable row level security;

grant select on goods_receipts, grn_lines to authenticated;
revoke insert, update, delete on goods_receipts, grn_lines from authenticated, anon;

create policy goods_receipts_read on goods_receipts
  for select to authenticated using (app.current_staff_id() is not null);
create policy grn_lines_read on grn_lines
  for select to authenticated using (app.current_staff_id() is not null);

-- ---------------------------------------------------------------------------
-- app.receive_goods
--
-- p_lines: [{ drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp,
--             mrp_basis, cost_per_base_unit, qty_packs, pack_basis, free_packs }]
--
-- Quantities arrive here in PACKS, because that is what the invoice says and
-- what the box in the pharmacist's hands is. They are converted to base units
-- once, at this boundary, and never travel any other way (INVENTORY.md §1).
-- ---------------------------------------------------------------------------
create or replace function app.receive_goods(
  p_lines            jsonb,
  p_supplier_id      uuid    default null,
  p_invoice_no       text    default null,
  p_invoice_date     date    default null,
  p_awaiting_invoice boolean default false,
  p_note             text    default null
) returns goods_receipts
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id      uuid;
  v_grn           goods_receipts;
  v_line          jsonb;
  v_drug          drugs%rowtype;
  v_batch         stock_batches%rowtype;
  v_expiry        date;
  v_units_per_strip int;
  v_strips_per_box  int;
  v_basis         mrp_basis;
  v_units_in_pack int;
  v_qty_base      int;
  v_free_base     int;
  v_cost          numeric(12, 4);
  v_mrp           numeric(12, 2);
  v_total         numeric(12, 2) := 0;
  v_earliest_dispensed date;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'PT005';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'a goods receipt needs at least one line' using errcode = 'PT006';
  end if;

  if not coalesce(p_awaiting_invoice, false) and p_invoice_no is null then
    raise exception 'a goods receipt needs an invoice number, or the awaiting-invoice flag'
      using errcode = 'PT006';
  end if;

  insert into goods_receipts
    (supplier_id, invoice_no, invoice_date, received_by, awaiting_invoice, note)
  values
    (p_supplier_id, p_invoice_no, p_invoice_date, v_staff_id,
     coalesce(p_awaiting_invoice, false), p_note)
  returning * into v_grn;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_drug from drugs where id = (v_line ->> 'drug_id')::uuid;
    if not found then
      raise exception 'unknown drug %', v_line ->> 'drug_id' using errcode = 'PT006';
    end if;

    -- The expiry is printed as a month. Stock is good through the end of it,
    -- so it is normalised once here and stored as the last usable date.
    v_expiry := app.month_end((v_line ->> 'expiry')::date);

    -- Catches a mistyped year at the door. A batch that is already expired
    -- cannot be received: either the date is wrong or the stock should not be
    -- on the shelf, and both need a human before anything is recorded.
    if v_expiry < current_date then
      raise exception 'batch "%" of "%" expires % — that is in the past',
        v_line ->> 'batch_no', v_drug.name, to_char(v_expiry, 'Mon YYYY')
        using errcode = 'PT011';
    end if;

    -- Catches the other mistyped year. If stock of this drug has already gone
    -- out from a LATER-expiring batch under FEFO, then a batch arriving now
    -- with an earlier expiry means FEFO was wrong then or the date is wrong
    -- now. Either way it is not something to record silently.
    select min(b.expiry) into v_earliest_dispensed
    from stock_batches b
    where b.drug_id = v_drug.id
      and exists (
        select 1 from stock_movements m
        where m.batch_id = b.id and m.qty_base < 0
      );

    if v_earliest_dispensed is not null and v_expiry < v_earliest_dispensed then
      raise exception
        'batch "%" expires % — earlier than a batch already dispensed against (%). Check the year',
        v_line ->> 'batch_no', to_char(v_expiry, 'Mon YYYY'),
        to_char(v_earliest_dispensed, 'Mon YYYY')
        using errcode = 'PT012';
    end if;

    v_units_per_strip := coalesce((v_line ->> 'units_per_strip')::int,
                                  v_drug.default_units_per_strip, 1);
    v_strips_per_box  := coalesce((v_line ->> 'strips_per_box')::int,
                                  v_drug.default_strips_per_box, 1);
    v_basis           := coalesce((v_line ->> 'mrp_basis')::mrp_basis,
                                  v_drug.default_mrp_basis);
    v_mrp             := (v_line ->> 'mrp')::numeric;

    -- Packs in, base units stored. The one conversion, at the one boundary.
    v_units_in_pack := app.units_in_pack(
      v_units_per_strip, v_strips_per_box,
      coalesce(v_line ->> 'pack_basis', v_basis::text)
    );
    v_qty_base  := coalesce((v_line ->> 'qty_packs')::int, 0) * v_units_in_pack;
    v_free_base := coalesce((v_line ->> 'free_packs')::int, 0) * v_units_in_pack;

    if v_qty_base + v_free_base <= 0 then
      raise exception 'a goods receipt line has to bring something in'
        using errcode = 'PT006';
    end if;

    v_cost := (v_line ->> 'cost_per_base_unit')::numeric;
    if v_cost is null then
      raise exception 'a goods receipt line needs a cost — valuation depends on it (INVENTORY.md §4)'
        using errcode = 'PT006';
    end if;

    -- Free goods dilute the cost across everything that arrived, which is what
    -- weighted average means and what the accountant expects to see.
    if v_free_base > 0 then
      v_cost := round(v_cost * v_qty_base / (v_qty_base + v_free_base), 4);
    end if;

    select * into v_batch
    from stock_batches
    where drug_id = v_drug.id and batch_no = (v_line ->> 'batch_no')
    for update;

    if found then
      -- The same batch arriving again: quantities add, and the cost becomes the
      -- weighted average of what is now on the shelf.
      update stock_batches
      set qty_base_received  = qty_base_received + v_qty_base + v_free_base,
          qty_base_on_hand   = qty_base_on_hand + v_qty_base + v_free_base,
          cost_per_base_unit = round(
            (cost_per_base_unit * qty_base_on_hand + v_cost * (v_qty_base + v_free_base))
            / nullif(qty_base_on_hand + v_qty_base + v_free_base, 0), 4),
          mrp                = v_mrp,
          grn_id             = v_grn.id
      where id = v_batch.id
      returning * into v_batch;
    else
      insert into stock_batches
        (drug_id, batch_no, expiry, units_per_strip, strips_per_box, mrp, mrp_basis,
         cost_per_base_unit, qty_base_received, qty_base_on_hand, supplier_id, grn_id)
      values
        (v_drug.id, v_line ->> 'batch_no', v_expiry, v_units_per_strip, v_strips_per_box,
         v_mrp, v_basis, v_cost, v_qty_base + v_free_base, v_qty_base + v_free_base,
         p_supplier_id, v_grn.id)
      returning * into v_batch;
    end if;

    insert into grn_lines
      (grn_id, drug_id, batch_id, qty_base, free_qty_base, cost_per_base_unit, mrp)
    values
      (v_grn.id, v_drug.id, v_batch.id, v_qty_base, v_free_base, v_cost, v_mrp);

    -- The ledger row. Rule 3: this is the truth, and the cache above was
    -- updated in the same transaction.
    insert into stock_movements
      (drug_id, batch_id, qty_base, type, ref_type, ref_id, staff_id, note)
    values
      (v_drug.id, v_batch.id, v_qty_base + v_free_base, 'receipt', 'goods_receipt',
       v_grn.id, v_staff_id, p_note);

    v_total := v_total + round(v_cost * (v_qty_base + v_free_base), 2);
  end loop;

  update goods_receipts set total = v_total where id = v_grn.id returning * into v_grn;

  perform app.write_audit(
    'receive_goods', 'goods_receipts', v_grn.id, null,
    jsonb_build_object('supplier_id', p_supplier_id, 'invoice_no', p_invoice_no,
                       'lines', jsonb_array_length(p_lines), 'total', v_total,
                       'awaiting_invoice', coalesce(p_awaiting_invoice, false))
  );

  return v_grn;
end
$$;

revoke all on function app.receive_goods(jsonb, uuid, text, date, boolean, text) from public;
grant execute on function app.receive_goods(jsonb, uuid, text, date, boolean, text)
  to authenticated, service_role;

comment on function app.receive_goods(jsonb, uuid, text, date, boolean, text) is
  'Packs in, base units stored. Refuses a past expiry and one earlier than a batch already dispensed against.';

-- ---------------------------------------------------------------------------
-- Stock valuation and margin. INVENTORY.md §4.
--
-- PLAN.md §12 tracked quantities but not what they cost, which means it could
-- not answer the two questions the doctor asks in month two: what is sitting on
-- my shelf worth, and what am I making on it. Because the ledger records which
-- batch each unit left from, cost of goods sold is exact rather than estimated.
-- ---------------------------------------------------------------------------
create view stock_valuation as
select
  b.drug_id,
  d.name          as drug_name,
  d.schedule,
  count(*)::int   as batches,
  sum(b.qty_base_on_hand)::int as qty_base_on_hand,
  round(sum(b.qty_base_on_hand * b.cost_per_base_unit), 2) as value_at_cost,
  min(b.expiry)   as earliest_expiry
from stock_batches b
join drugs d on d.id = b.drug_id
where b.qty_base_on_hand > 0
  and b.expiry >= current_date
group by b.drug_id, d.name, d.schedule;

comment on view stock_valuation is
  'Non-expired stock at weighted average cost. One query, and it reconciles (INVENTORY.md §4).';

create view dispense_margin as
select
  date_trunc('month', d.at)::date as month,
  dl.drug_id,
  dr.name                          as drug_name,
  sum(dl.qty_base)::int            as qty_base,
  round(sum(dl.amount), 2)         as sale_value,
  round(sum(dl.qty_base * dl.cost_at_dispense), 2) as cost_of_goods,
  round(sum(dl.amount) - sum(dl.qty_base * dl.cost_at_dispense), 2) as margin
from dispense_lines dl
join dispenses d on d.id = dl.dispense_id
join drugs dr on dr.id = dl.drug_id
group by 1, 2, 3;

comment on view dispense_margin is
  'Exact, not estimated: every line carries the cost of the units actually allocated.';

grant select on stock_valuation, dispense_margin to authenticated;
