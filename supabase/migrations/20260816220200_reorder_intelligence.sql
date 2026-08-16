-- Reordering that learns, and still never acts alone. INVENTORY.md §8.
--
-- PLAN.md §12.4 offers `avg daily use × supplier lead time × 1.5` after sixty
-- days. This extends it with the four signals §8 asks for — consumption
-- velocity, MEASURED supplier lead time, its variance, and stockout history —
-- and puts the last five purchase prices on the line so the doctor sees he is
-- being charged more than last month at the moment he can do something about it.
--
-- PLAN.md §5.3 rule 4 is the constraint that shapes all of it: money and stock
-- never move unattended. Nothing here writes a purchase order. Every number
-- below is a proposal rendered next to an editable quantity, and the only
-- function in this file creates orders in `draft` — there is no path from any
-- of this to a supplier's phone. Sending is M5's job and needs a human's tap.
--
-- On the two words that matter:
--
--   MEASURED lead time is days from a purchase order being sent to the goods
--   arriving. Not what the supplier says on the phone. Until there are enough
--   real measurements the view says so — `source` is 'measured', 'claimed' or
--   'assumed', and a claim is never quietly presented as a measurement.

-- ---------------------------------------------------------------------------
-- Purchase orders.
--
-- Scoped deliberately: this migration creates the table, the draft state, and
-- the `sent_at` column that makes lead time measurable at all. The lifecycle
-- past `draft` — approval, the WhatsApp send, the supplier's acknowledgement,
-- receiving against a PO — is M5 (PLAN.md §8, §12.5) and is not implemented
-- here. The enum carries the full set of states so that milestone adds
-- transitions rather than a migration that rewrites this one.
-- ---------------------------------------------------------------------------
create type purchase_order_status as enum
  ('draft', 'sent', 'acknowledged', 'partial', 'received', 'cancelled');

create table purchase_orders (
  id              uuid primary key default gen_random_uuid(),
  supplier_id     uuid not null references suppliers (id),
  status          purchase_order_status not null default 'draft',
  created_by      uuid not null references staff (id),
  -- The measurement point. Lead time is sent → received, and nothing else.
  sent_at         timestamptz,
  acknowledged_at timestamptz,
  closed_at       timestamptz,
  note            text,
  estimated_total numeric(12, 2) not null default 0 check (estimated_total >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint sent_orders_have_a_sent_time check (
    status = 'draft' or status = 'cancelled' or sent_at is not null
  )
);

create index purchase_orders_open_idx on purchase_orders (supplier_id, status);

create table po_lines (
  id                uuid primary key default gen_random_uuid(),
  po_id             uuid not null references purchase_orders (id),
  drug_id           uuid not null references drugs (id),
  qty_base          int not null check (qty_base > 0),
  -- What the system proposed, kept beside what the human actually ordered.
  -- Without both numbers there is no way to find out, in six months, whether
  -- the suggestion was any good — and a suggestion nobody can audit is just a
  -- number with confidence.
  suggested_qty_base int,
  expected_cost_per_base_unit numeric(12, 4),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index po_lines_po_idx on po_lines (po_id);

-- goods_receipts.po_id has existed since the GRN migration as a bare uuid,
-- because the table it points at did not exist yet. It does now.
alter table goods_receipts
  add constraint goods_receipts_po_fkey foreign key (po_id) references purchase_orders (id);

create trigger purchase_orders_touch before update on purchase_orders
  for each row execute function app.touch_updated_at();
create trigger po_lines_touch before update on po_lines
  for each row execute function app.touch_updated_at();

alter table purchase_orders enable row level security;
alter table po_lines        enable row level security;

grant select on purchase_orders, po_lines to authenticated;
revoke insert, update, delete on purchase_orders, po_lines from authenticated, anon;

create policy purchase_orders_read on purchase_orders
  for select to authenticated using (app.current_staff_id() is not null);
create policy po_lines_read on po_lines
  for select to authenticated using (app.current_staff_id() is not null);

-- ---------------------------------------------------------------------------
-- Signal 1 — consumption velocity, from the ledger.
--
-- Only `dispense` and `sale` count. A return to a supplier and an expiry
-- write-off both reduce stock and neither is demand: counting them would order
-- more of exactly the drug that just proved nobody wants it.
-- ---------------------------------------------------------------------------
create view consumption_velocity as
select
  d.id   as drug_id,
  d.name as drug_name,
  round(coalesce(sum(-m.qty_base) filter (where m.at >= now() - interval '30 days'), 0)::numeric / 30, 3) as per_day_30,
  round(coalesce(sum(-m.qty_base) filter (where m.at >= now() - interval '60 days'), 0)::numeric / 60, 3) as per_day_60,
  round(coalesce(sum(-m.qty_base) filter (where m.at >= now() - interval '90 days'), 0)::numeric / 90, 3) as per_day_90,
  coalesce(sum(-m.qty_base) filter (where m.at >= now() - interval '90 days'), 0)::int as base_units_90
from drugs d
left join stock_movements m
  on m.drug_id = d.id
 and m.type in ('dispense', 'sale')
 and m.at >= now() - interval '90 days'
group by d.id, d.name;

comment on view consumption_velocity is
  'Demand only — returns and write-offs are stock leaving, not stock wanted (INVENTORY.md §8).';

-- ---------------------------------------------------------------------------
-- Signal 2 and 3 — measured lead time, and how unreliable it is.
--
-- Three receipts is the point at which an average stops being an anecdote.
-- Below that the view reports the supplier's claim and says that is what it is.
-- ---------------------------------------------------------------------------
create view supplier_lead_time as
with measured as (
  select
    p.supplier_id,
    count(*)::int as receipts_measured,
    avg(extract(epoch from (g.received_at - p.sent_at)) / 86400)          as avg_days,
    coalesce(stddev_samp(extract(epoch from (g.received_at - p.sent_at)) / 86400), 0) as sd_days
  from goods_receipts g
  join purchase_orders p on p.id = g.po_id
  where p.sent_at is not null
    and g.received_at >= p.sent_at
  group by p.supplier_id
)
select
  s.id                              as supplier_id,
  s.name                            as supplier_name,
  s.lead_time_days                  as claimed_days,
  coalesce(m.receipts_measured, 0)  as receipts_measured,
  round(m.avg_days::numeric, 1)     as measured_days,
  round(m.sd_days::numeric, 1)      as measured_variance_days,
  case
    when coalesce(m.receipts_measured, 0) >= 3 then round(m.avg_days::numeric, 1)
    when s.lead_time_days is not null          then s.lead_time_days::numeric
    else 7::numeric
  end as days_used,
  case
    when coalesce(m.receipts_measured, 0) >= 3 then 'measured'
    when s.lead_time_days is not null          then 'claimed'
    else 'assumed'
  end as source,
  -- The buffer. Measured suppliers get one sized to their own unreliability —
  -- the one who is always four days gets almost nothing, the one who swings
  -- between two days and three weeks gets a fortnight. Until there are
  -- measurements there is nothing to size it from, so it falls back to
  -- PLAN.md §12.4's flat half, which is a guess and is labelled as one.
  case
    when coalesce(m.receipts_measured, 0) >= 3 then ceil(m.sd_days)::int
    when s.lead_time_days is not null          then ceil(s.lead_time_days * 0.5)::int
    else 4
  end as buffer_days
from suppliers s
left join measured m on m.supplier_id = s.id;

comment on view supplier_lead_time is
  'Measured from PO sent to goods received. `source` never lets a supplier''s claim pass as a measurement.';

-- ---------------------------------------------------------------------------
-- Signal 4 — stockout history. The drugs that need a bigger cushion are the
-- ones that have actually run out, not the ones somebody worries about.
-- ---------------------------------------------------------------------------
create view stockout_history as
with ledger as (
  select
    m.drug_id,
    m.at,
    m.id as movement_id,
    sum(m.qty_base) over (
      partition by m.drug_id order by m.at, m.id
      rows between unbounded preceding and current row
    ) as on_hand
  from stock_movements m
),
crossings as (
  select
    drug_id,
    at,
    on_hand,
    lag(on_hand) over (partition by drug_id order by at, movement_id) as previous
  from ledger
)
select
  drug_id,
  -- Transitions to zero, not days spent at zero: sitting empty for a week is
  -- one failure to reorder, not seven.
  count(*) filter (where on_hand <= 0 and coalesce(previous, 1) > 0)::int as times_at_zero,
  max(at)  filter (where on_hand <= 0) as last_at_zero
from crossings
where at >= now() - interval '180 days'
group by drug_id;

comment on view stockout_history is
  'Counts the times on-hand crossed to zero in 180 days, from the ledger (INVENTORY.md §8).';

-- ---------------------------------------------------------------------------
-- Signal 5 — supplier price history. "₹42 last time from Kumar, ₹45 from
-- Reddy", on the PO line, at the moment he can do something about it.
-- ---------------------------------------------------------------------------
create view supplier_price_history as
select drug_id, supplier_id, supplier_name, cost_per_base_unit, mrp,
       received_at, invoice_no, purchase_no
from (
  select
    l.drug_id,
    g.supplier_id,
    s.name         as supplier_name,
    l.cost_per_base_unit,
    l.mrp,
    g.received_at,
    g.invoice_no,
    row_number() over (
      partition by l.drug_id, g.supplier_id order by g.received_at desc
    ) as purchase_no
  from grn_lines l
  join goods_receipts g on g.id = l.grn_id
  left join suppliers s on s.id = g.supplier_id
) ranked
where purchase_no <= 5;

comment on view supplier_price_history is
  'The last five purchase prices per drug per supplier. Small to build, and visible exactly when it is useful.';

-- ---------------------------------------------------------------------------
-- The suggestion.
--
-- Every number that goes into it is above, and every one of them is visible on
-- the screen beside the result — because a proposed quantity nobody can argue
-- with is one the doctor either rubber-stamps or ignores, and both are worse
-- than a number he can correct.
-- ---------------------------------------------------------------------------
create view reorder_suggestions as
with on_hand as (
  select drug_id, sum(qty_base_on_hand)::int as qty_base_available
  from available_stock
  group by drug_id
),
basis as (
  select
    d.id                                as drug_id,
    d.name                              as drug_name,
    d.schedule,
    d.base_unit,
    d.default_units_per_strip,
    d.default_strips_per_box,
    d.default_supplier_id,
    coalesce(o.qty_base_available, 0)   as qty_base_available,
    d.reorder_level_base,
    d.reorder_qty_base,
    -- The freshest window that has actually seen movement. A drug prescribed
    -- twice in March and not since should not be ordered on its March rate.
    coalesce(
      case
        when v.per_day_30 > 0 then v.per_day_30
        when v.per_day_60 > 0 then v.per_day_60
        else v.per_day_90
      end, 0)                           as per_day,
    coalesce(v.base_units_90, 0)        as base_units_90,
    -- A drug with no default supplier still gets a suggestion; it just gets one
    -- built on assumptions, and says so.
    coalesce(lt.days_used, 7)           as lead_days,
    coalesce(lt.buffer_days, 4)         as buffer_days,
    coalesce(lt.source, 'assumed')      as lead_time_source,
    lt.supplier_name,
    coalesce(sh.times_at_zero, 0)       as times_at_zero
  from drugs d
  left join on_hand o              on o.drug_id = d.id
  left join consumption_velocity v on v.drug_id = d.id
  left join stockout_history sh    on sh.drug_id = d.id
  left join supplier_lead_time lt  on lt.supplier_id = d.default_supplier_id
  where d.active
),
sized as (
  select
    b.*,
    -- A drug that has run out before gets a week of extra cover. Once.
    (b.lead_days + b.buffer_days + case when b.times_at_zero > 0 then 7 else 0 end)
      as days_to_cover,
    -- One month's supply is the ordering rhythm of a clinic this size.
    30 as cover_days
  from basis b
)
select
  s.drug_id,
  s.drug_name,
  s.schedule,
  s.base_unit,
  s.default_units_per_strip,
  s.default_strips_per_box,
  s.default_supplier_id,
  s.supplier_name,
  s.qty_base_available,
  s.reorder_level_base,
  s.reorder_qty_base,
  s.per_day,
  s.base_units_90,
  s.lead_days,
  s.buffer_days,
  s.lead_time_source,
  s.times_at_zero,
  s.days_to_cover,
  case when s.per_day > 0
       then floor(s.qty_base_available / s.per_day)::int end as days_of_cover_left,
  ceil(s.per_day * (s.days_to_cover + s.cover_days))::int    as target_base,
  case
    -- With movement to go on, order the gap between what will be needed and
    -- what is there.
    when s.per_day > 0
      then greatest(0, ceil(s.per_day * (s.days_to_cover + s.cover_days))::int
                       - s.qty_base_available)
    -- Without it, fall back to the manual figure. Reorder levels are manual at
    -- go-live (PLAN.md §12.4) and this is the whole of the intelligence until
    -- the ledger has something to say.
    else coalesce(s.reorder_qty_base, 0)
  end as suggested_qty_base,
  case
    when s.per_day > 0 and s.lead_time_source = 'measured'
      then 'uses ' || s.lead_days || ' days measured lead time'
    when s.per_day > 0
      then 'uses ' || s.lead_days || ' days lead time, ' || s.lead_time_source
    else 'no movement recorded yet — this is the manual reorder quantity'
  end as basis
from sized s
where (
    s.qty_base_available <= coalesce(s.reorder_level_base, 0)
    or (s.per_day > 0 and s.qty_base_available < s.per_day * s.days_to_cover)
  )
  and case
        when s.per_day > 0
          then greatest(0, ceil(s.per_day * (s.days_to_cover + s.cover_days))::int
                           - s.qty_base_available) > 0
        else coalesce(s.reorder_qty_base, 0) > 0
      end;

comment on view reorder_suggestions is
  'A proposal, never an order. PLAN.md §5.3 rule 4 — nothing in this schema turns a row of this view into a sent PO.';

grant select on consumption_velocity, supplier_lead_time, stockout_history,
                supplier_price_history, reorder_suggestions to authenticated;

-- ---------------------------------------------------------------------------
-- app.draft_purchase_orders
--
-- p_lines: [{ drug_id, supplier_id, qty_base, suggested_qty_base?,
--             expected_cost_per_base_unit? }]
--
-- One draft order per supplier, from quantities a human has already looked at.
-- It creates nothing but drafts: `sent` is reachable only through a transition
-- that does not exist yet, and that is the shape rule 4 asks for.
-- ---------------------------------------------------------------------------
create or replace function app.draft_purchase_orders(p_lines jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id    uuid;
  v_line        jsonb;
  v_supplier_id uuid;
  v_po_id       uuid;
  v_qty         int;
  v_cost        numeric(12, 4);
  v_orders      int := 0;
  v_by_supplier jsonb := '{}'::jsonb;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'an order needs at least one line' using errcode = 'CL006';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_supplier_id := (v_line ->> 'supplier_id')::uuid;
    v_qty         := (v_line ->> 'qty_base')::int;
    v_cost        := (v_line ->> 'expected_cost_per_base_unit')::numeric;

    if v_supplier_id is null then
      raise exception 'every order line needs a supplier' using errcode = 'CL006';
    end if;

    if v_qty is null or v_qty <= 0 then
      raise exception 'an order line has to order something' using errcode = 'CL006';
    end if;

    if not exists (select 1 from drugs where id = (v_line ->> 'drug_id')::uuid) then
      raise exception 'unknown drug %', v_line ->> 'drug_id' using errcode = 'CL006';
    end if;

    -- One order per supplier, whatever order the lines arrive in.
    if v_by_supplier ? v_supplier_id::text then
      v_po_id := (v_by_supplier ->> v_supplier_id::text)::uuid;
    else
      insert into purchase_orders (supplier_id, created_by)
      values (v_supplier_id, v_staff_id)
      returning id into v_po_id;

      v_by_supplier := v_by_supplier || jsonb_build_object(v_supplier_id::text, v_po_id);
      v_orders := v_orders + 1;

      perform app.write_audit(
        'draft_purchase_order', 'purchase_orders', v_po_id, null,
        jsonb_build_object('supplier_id', v_supplier_id, 'status', 'draft')
      );
    end if;

    insert into po_lines
      (po_id, drug_id, qty_base, suggested_qty_base, expected_cost_per_base_unit)
    values
      (v_po_id, (v_line ->> 'drug_id')::uuid, v_qty,
       (v_line ->> 'suggested_qty_base')::int, v_cost);

    update purchase_orders
    set estimated_total = estimated_total + round(coalesce(v_cost, 0) * v_qty, 2)
    where id = v_po_id;
  end loop;

  return v_orders;
end
$$;

revoke all on function app.draft_purchase_orders(jsonb) from public;
grant execute on function app.draft_purchase_orders(jsonb) to authenticated, service_role;

comment on function app.draft_purchase_orders(jsonb) is
  'Creates drafts and only drafts. Sending is M5 and needs a human (PLAN.md §5.3 rule 4).';
