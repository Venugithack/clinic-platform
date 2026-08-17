-- Purchasing: the PO lifecycle and the supplier send. PLAN.md §8 M5, §10.4,
-- §12.5, WHATSAPP.md §0.
--
-- M3 built the intelligence and stopped deliberately at `draft`. This is the
-- rest of the ladder, and the shape of it was decided by WHATSAPP.md §0 rather
-- than by preference:
--
--     draft ──approve+send──► sent ──supplier replies──► acknowledged
--                               │                            │
--                               └──goods arrive──► partial ──► received
--
-- THE SEND IS A DEEP LINK, AND THAT DECIDES EVERYTHING ELSE.
--
-- Meta's rules key on who initiates a conversation, not on volume. A Cloud API
-- send — even one a day, even human-approved — is a business-initiated message
-- and drags in business verification, a dedicated number, display-name
-- approval, pre-approved templates, opt-in machinery and a privacy policy URL.
-- A `wa.me` link is a person typing to a contact, and needs none of it
-- (WHATSAPP.md §0). The automation the clinic is paying for — knowing what to
-- order and when, drafting it, tracking the reply — is entirely intact. Only
-- the send button moves, out of this app and into his WhatsApp.
--
-- TWO CONSEQUENCES WORTH BEING HONEST ABOUT.
--
-- 1. This app can never know the message was actually sent. It hands the text
--    to WhatsApp; what happens next happens on his phone. So `wa_messages` ends
--    at `handed_off`, not `sent` or `delivered` — claiming a delivery nobody
--    observed is exactly what PLAN.md §5.3 rule 6 forbids. The purchase order
--    moves to `sent` because the DOCTOR asserts it by tapping, which is a
--    different and honest claim.
--
-- 2. There is no inbound webhook, so the supplier's reply is captured by a
--    person: they read the WhatsApp message and record it. That is worse than
--    an API and much better than nothing, and it is what small clinics already
--    do (§10.4's escape hatch, promoted to the design).
--
-- Rule 5 — "every send is a row before a send" — is why the message row is
-- written inside the transition, before the client is given anything to open.
-- If the tablet dies between the two, the record over-states rather than
-- under-states, which is the correct direction to fail in.
--
-- Error code added here:
--   CL022  the supplier has no WhatsApp number to send to

-- ---------------------------------------------------------------------------
-- The message log.
--
-- PLAN.md §7 specifies wa_contacts / wa_messages / wa_inbound / wa_sessions.
-- Only the log is built here, because only the log has a job in M5: opt-in
-- machinery, the 24-hour window and the booking conversation are all patient
-- concerns and arrive with M7 and the Cloud API.
-- ---------------------------------------------------------------------------
create type wa_channel as enum ('deeplink', 'cloud_api');

create type wa_message_status as enum (
  -- The end of the road for a deep link: the text was composed, recorded, and
  -- handed to WhatsApp on somebody's phone.
  'handed_off',
  -- Cloud API only, from M7 onward.
  'queued', 'sent', 'delivered', 'read', 'failed'
);

create table wa_messages (
  id              uuid primary key default gen_random_uuid(),
  to_number       text not null,
  direction       text not null default 'out' check (direction in ('out', 'in')),
  channel         wa_channel not null default 'deeplink',
  template_code   text,
  body            text not null,
  params          jsonb not null default '{}'::jsonb,
  status          wa_message_status not null default 'handed_off',
  wa_message_id   text,
  error           text,
  ref_type        text,
  ref_id          uuid,
  -- Unique, so a double tap cannot produce two orders. It carries the attempt
  -- number because re-sending IS a real thing — "did you get my order?" — and
  -- must produce a second record rather than being swallowed as a duplicate.
  idempotency_key text not null unique,
  staff_id        uuid references staff (id),
  cost            numeric(12, 4),
  at              timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index wa_messages_ref_idx on wa_messages (ref_type, ref_id, at desc);

alter table wa_messages enable row level security;
grant select on wa_messages to authenticated;
revoke insert, update, delete on wa_messages from authenticated, anon;

create policy wa_messages_read on wa_messages
  for select to authenticated using (app.current_staff_id() is not null);

comment on column wa_messages.status is
  'A deep link ends at handed_off. The app never sees delivery, so it never claims it (PLAN.md §5.3 rule 6).';

-- ---------------------------------------------------------------------------
-- The purchase order gains a number, a reply, and a way to be cancelled.
--
-- The number is assigned AT SEND, not at draft. A draft is internal and often
-- abandoned; numbering it would burn references on orders that never existed.
-- Once it has gone to a supplier it is a document both sides talk about, and
-- from that moment it keeps its number for good.
-- ---------------------------------------------------------------------------
alter table purchase_orders
  add column po_no            text unique,
  add column sends            int not null default 0 check (sends >= 0),
  add column supplier_reply   text,
  add column expected_on      date,
  add column cancelled_by     uuid references staff (id),
  add column cancel_reason    text;

create table po_counters (
  financial_year text primary key,
  last_no        int not null default 0 check (last_no >= 0)
);

alter table po_counters enable row level security;
grant select on po_counters to authenticated;
revoke insert, update, delete on po_counters from authenticated, anon;
create policy po_counters_read on po_counters
  for select to authenticated using (app.current_staff_id() is not null);

-- ---------------------------------------------------------------------------
-- app.set_po_lines — editing a draft.
--
-- "Reorder quantity in strips vs boxes vs the supplier's minimum order is a
--  human judgement the first few months" (§10.4). So the quantities are
--  editable right up to the send, and only up to the send: a sent order is a
--  thing a supplier is holding, and changing it silently is how two people end
--  up with different orders.
-- ---------------------------------------------------------------------------
create or replace function app.set_po_lines(p_po_id uuid, p_lines jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_po       purchase_orders;
  v_line     jsonb;
  v_total    numeric(12, 2) := 0;
  v_count    int := 0;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  select * into v_po from purchase_orders where id = p_po_id for update;
  if not found then
    raise exception 'unknown purchase order %', p_po_id using errcode = 'CL006';
  end if;

  if v_po.status <> 'draft' then
    raise exception 'purchase order % has already been %, and cannot be edited',
      coalesce(v_po.po_no, p_po_id::text), v_po.status
      using errcode = 'CL007';
  end if;

  delete from po_lines where po_id = p_po_id;

  for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    if coalesce((v_line ->> 'qty_base')::int, 0) <= 0 then
      raise exception 'an order line has to order something' using errcode = 'CL006';
    end if;

    insert into po_lines (po_id, drug_id, qty_base, suggested_qty_base,
                          expected_cost_per_base_unit)
    values (p_po_id, (v_line ->> 'drug_id')::uuid, (v_line ->> 'qty_base')::int,
            (v_line ->> 'suggested_qty_base')::int,
            (v_line ->> 'expected_cost_per_base_unit')::numeric);

    v_total := v_total + round(coalesce((v_line ->> 'expected_cost_per_base_unit')::numeric, 0)
                               * (v_line ->> 'qty_base')::int, 2);
    v_count := v_count + 1;
  end loop;

  update purchase_orders set estimated_total = v_total where id = p_po_id;

  perform app.write_audit('set_po_lines', 'purchase_orders', p_po_id, null,
    jsonb_build_object('lines', v_count, 'estimated_total', v_total));

  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- app.send_purchase_order — the one tap.
--
-- Returns the composed message and the number to open it against. It does NOT
-- return a URL: percent-encoding is a transport detail and belongs at the edge,
-- while the text recorded here is the record of what was ordered.
-- ---------------------------------------------------------------------------
create or replace function app.send_purchase_order(p_po_id uuid)
-- The OUT columns are named to collide with nothing. `po_id`, `po_no`, `sends`
-- and `to_number` are all column names in tables this function reads, and an
-- OUT parameter that shadows a column makes every unqualified reference to it
-- ambiguous — which plpgsql reports at call time, not at creation.
returns table (
  order_id        uuid,
  order_no        text,
  send_to_number  text,
  message_body    text,
  message_id      uuid,
  send_count      int
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id  uuid;
  v_po        purchase_orders;
  v_supplier  suppliers%rowtype;
  v_clinic    clinic%rowtype;
  v_line      record;
  v_body      text;
  v_qty       text;
  v_n         int := 0;
  v_fy        text;
  v_no        int;
  v_po_no     text;
  v_message   uuid;
  v_sends     int;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  -- Rule 4, and §10.4's whole argument: an order is a financial commitment to a
  -- third party. One wrong reorder level and the clinic has paid for ten times
  -- the stock, so the person who owns that risk is the one who taps send.
  if app.current_staff_role() not in ('doctor', 'admin') then
    raise exception 'a purchase order is approved and sent by the doctor'
      using errcode = 'CL005';
  end if;

  select * into v_po from purchase_orders where id = p_po_id for update;
  if not found then
    raise exception 'unknown purchase order %', p_po_id using errcode = 'CL006';
  end if;

  -- Re-sending a sent order is legitimate — suppliers lose messages. Anything
  -- past that has moved on and should not be re-ordered by accident.
  if v_po.status not in ('draft', 'sent') then
    raise exception 'purchase order % is %, and is not waiting to be sent',
      coalesce(v_po.po_no, p_po_id::text), v_po.status
      using errcode = 'CL007';
  end if;

  if not exists (select 1 from po_lines l where l.po_id = p_po_id) then
    raise exception 'that purchase order has no lines' using errcode = 'CL006';
  end if;

  select * into v_supplier from suppliers where id = v_po.supplier_id;

  if v_supplier.whatsapp_number is null or length(trim(v_supplier.whatsapp_number)) = 0 then
    raise exception 'no WhatsApp number is recorded for % — add one before ordering',
      v_supplier.name
      using errcode = 'CL022';
  end if;

  select * into v_clinic from clinic limit 1;

  -- The number, assigned now and kept for good.
  v_po_no := v_po.po_no;
  if v_po_no is null then
    v_fy := app.financial_year(current_date);
    insert into po_counters (financial_year) values (v_fy) on conflict do nothing;
    update po_counters set last_no = last_no + 1
    where financial_year = v_fy
    returning last_no into v_no;
    v_po_no := 'PO ' || v_fy || '/' || lpad(v_no::text, 4, '0');
  end if;

  v_body := v_clinic.name || E'\n' || v_po_no || E'\n\n';

  for v_line in
    select l.qty_base, d.name, d.strength, d.base_unit,
           d.default_units_per_strip as ups, d.default_strips_per_box as spb
    from po_lines l
    join drugs d on d.id = l.drug_id
    where l.po_id = p_po_id
    order by d.name
  loop
    v_n := v_n + 1;

    -- Said in the units the supplier sells in, with the base units in brackets
    -- so there is no ambiguity about what was meant. The bracketed number is
    -- the authoritative one — everything in this database is base units.
    if v_line.ups is not null and v_line.ups > 0
       and v_line.spb is not null and v_line.spb > 0
       and v_line.qty_base % (v_line.ups * v_line.spb) = 0 then
      v_qty := (v_line.qty_base / (v_line.ups * v_line.spb))::text || ' box'
               || case when v_line.qty_base / (v_line.ups * v_line.spb) = 1 then '' else 'es' end;
    elsif v_line.ups is not null and v_line.ups > 0 and v_line.qty_base % v_line.ups = 0 then
      v_qty := (v_line.qty_base / v_line.ups)::text || ' strip'
               || case when v_line.qty_base / v_line.ups = 1 then '' else 's' end;
    else
      v_qty := v_line.qty_base::text || ' ' || v_line.base_unit::text;
    end if;

    v_body := v_body || v_n::text || '. ' || v_line.name || ' ' ||
              coalesce(v_line.strength, '') || ' — ' || v_qty ||
              ' (' || v_line.qty_base::text || ')' || E'\n';
  end loop;

  v_body := v_body || E'\nPlease confirm availability and expected delivery.';

  v_sends := v_po.sends + 1;

  -- The row before the send (rule 5).
  insert into wa_messages (to_number, channel, body, status, ref_type, ref_id,
                           idempotency_key, staff_id)
  values (v_supplier.whatsapp_number, 'deeplink', v_body, 'handed_off',
          'purchase_order', p_po_id,
          'po:' || p_po_id::text || ':send:' || v_sends::text, v_staff_id)
  returning id into v_message;

  update purchase_orders
  set status  = 'sent',
      po_no   = v_po_no,
      sends   = v_sends,
      -- The FIRST send only. supplier_lead_time measures sent → received, and a
      -- chase message three days later must not make the supplier look faster
      -- than they were.
      sent_at = coalesce(v_po.sent_at, now())
  where id = p_po_id;

  perform app.write_audit('send_purchase_order', 'purchase_orders', p_po_id,
    jsonb_build_object('status', v_po.status),
    jsonb_build_object('status', 'sent', 'po_no', v_po_no, 'sends', v_sends,
                       'message_id', v_message));

  return query select p_po_id, v_po_no, v_supplier.whatsapp_number, v_body,
                      v_message, v_sends;
end
$$;

-- ---------------------------------------------------------------------------
-- app.record_supplier_reply — the acknowledgement, typed in by a person.
--
-- With no inbound webhook this is the honest version: somebody read the reply
-- and wrote down what it said. The alternative is an order nobody is tracking.
-- ---------------------------------------------------------------------------
create or replace function app.record_supplier_reply(
  p_po_id       uuid,
  p_reply       text,
  p_expected_on date default null
) returns purchase_orders
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_po       purchase_orders;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_reply is null or length(trim(p_reply)) = 0 then
    raise exception 'record what the supplier actually said' using errcode = 'CL006';
  end if;

  select * into v_po from purchase_orders where id = p_po_id for update;
  if not found then
    raise exception 'unknown purchase order %', p_po_id using errcode = 'CL006';
  end if;

  if v_po.status not in ('sent', 'acknowledged') then
    raise exception 'purchase order % is %, so there is nothing to acknowledge',
      coalesce(v_po.po_no, p_po_id::text), v_po.status
      using errcode = 'CL007';
  end if;

  update purchase_orders
  set status          = 'acknowledged',
      acknowledged_at = coalesce(v_po.acknowledged_at, now()),
      supplier_reply  = p_reply,
      expected_on     = coalesce(p_expected_on, v_po.expected_on)
  where id = p_po_id
  returning * into v_po;

  perform app.write_audit('record_supplier_reply', 'purchase_orders', p_po_id,
    jsonb_build_object('status', 'sent'),
    jsonb_build_object('status', 'acknowledged', 'reply', p_reply,
                       'expected_on', p_expected_on));

  return v_po;
end
$$;

create or replace function app.cancel_purchase_order(p_po_id uuid, p_reason text)
returns purchase_orders
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_po       purchase_orders;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancelled order needs a reason' using errcode = 'CL006';
  end if;

  select * into v_po from purchase_orders where id = p_po_id for update;
  if not found then
    raise exception 'unknown purchase order %', p_po_id using errcode = 'CL006';
  end if;

  -- §12.5: cancellable from draft, sent and acknowledged. Once goods have
  -- started arriving the order is a fact on a shelf, and cancelling it would
  -- orphan the stock that came in against it.
  if v_po.status not in ('draft', 'sent', 'acknowledged') then
    raise exception 'purchase order % is % — goods have already arrived against it',
      coalesce(v_po.po_no, p_po_id::text), v_po.status
      using errcode = 'CL007';
  end if;

  update purchase_orders
  set status = 'cancelled', cancelled_by = v_staff_id, cancel_reason = p_reason,
      closed_at = now()
  where id = p_po_id
  returning * into v_po;

  perform app.write_audit('cancel_purchase_order', 'purchase_orders', p_po_id,
    jsonb_build_object('status', v_po.status),
    jsonb_build_object('status', 'cancelled', 'reason', p_reason));

  return v_po;
end
$$;

-- ---------------------------------------------------------------------------
-- app.receive_against_po
--
-- Composes app.receive_goods rather than duplicating it. That transition is
-- where packs become base units, where free goods dilute the weighted-average
-- cost and where an expiry in the past is refused; a second copy of it with one
-- extra parameter would be two places for those rules to live.
--
-- A GRN can still exist with no PO at all (§12.5), because that is how small
-- clinics buy half their stock, and app.receive_goods remains the way to do it.
-- ---------------------------------------------------------------------------
create or replace function app.receive_against_po(
  p_po_id            uuid,
  p_lines            jsonb,
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
  v_po        purchase_orders;
  v_grn       goods_receipts;
  v_complete  boolean;
begin
  select * into v_po from purchase_orders where id = p_po_id for update;
  if not found then
    raise exception 'unknown purchase order %', p_po_id using errcode = 'CL006';
  end if;

  if v_po.status not in ('sent', 'acknowledged', 'partial') then
    raise exception 'purchase order % is %, so goods cannot arrive against it',
      coalesce(v_po.po_no, p_po_id::text), v_po.status
      using errcode = 'CL007';
  end if;

  v_grn := app.receive_goods(p_lines, v_po.supplier_id, p_invoice_no,
                             p_invoice_date, p_awaiting_invoice, p_note);

  update goods_receipts set po_id = p_po_id where id = v_grn.id
  returning * into v_grn;

  -- Every ordered line met, counting everything ever received against this
  -- order — suppliers deliver in two vans and the second one is not a new
  -- order.
  select bool_and(coalesce(g.qty, 0) >= l.qty_base)
  into v_complete
  from po_lines l
  left join (
    select gl.drug_id, sum(gl.qty_base + gl.free_qty_base) as qty
    from grn_lines gl
    join goods_receipts g on g.id = gl.grn_id
    where g.po_id = p_po_id
    group by gl.drug_id
  ) g on g.drug_id = l.drug_id
  where l.po_id = p_po_id;

  update purchase_orders
  set status    = (case when coalesce(v_complete, false) then 'received'
                        else 'partial' end)::purchase_order_status,
      closed_at = case when coalesce(v_complete, false) then now() end
  where id = p_po_id;

  perform app.write_audit('receive_against_po', 'purchase_orders', p_po_id,
    jsonb_build_object('status', v_po.status),
    jsonb_build_object('status', case when coalesce(v_complete, false)
                                      then 'received' else 'partial' end,
                       'grn_id', v_grn.id));

  return v_grn;
end
$$;

revoke all on function app.set_po_lines(uuid, jsonb)                       from public;
revoke all on function app.send_purchase_order(uuid)                        from public;
revoke all on function app.record_supplier_reply(uuid, text, date)          from public;
revoke all on function app.cancel_purchase_order(uuid, text)                from public;
revoke all on function app.receive_against_po(uuid, jsonb, text, date, boolean, text) from public;

grant execute on function app.set_po_lines(uuid, jsonb)              to authenticated, service_role;
grant execute on function app.send_purchase_order(uuid)              to authenticated, service_role;
grant execute on function app.record_supplier_reply(uuid, text, date) to authenticated, service_role;
grant execute on function app.cancel_purchase_order(uuid, text)      to authenticated, service_role;
grant execute on function app.receive_against_po(uuid, jsonb, text, date, boolean, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What is on order, and what of it is still outstanding.
--
-- The outstanding column is what makes a part-delivery visible: without it, an
-- order half-arrived looks identical to one fully arrived on every screen that
-- shows a status.
-- ---------------------------------------------------------------------------
create view purchase_order_lines as
select
  l.id                    as po_line_id,
  l.po_id,
  p.status,
  l.drug_id,
  d.name                  as drug_name,
  d.strength,
  d.base_unit,
  d.default_units_per_strip,
  d.default_strips_per_box,
  l.qty_base              as ordered_qty_base,
  l.suggested_qty_base,
  l.expected_cost_per_base_unit,
  coalesce(g.qty, 0)::int as received_qty_base,
  greatest(l.qty_base - coalesce(g.qty, 0), 0)::int as outstanding_qty_base
from po_lines l
join purchase_orders p on p.id = l.po_id
join drugs d on d.id = l.drug_id
left join (
  select gl.drug_id, g.po_id, sum(gl.qty_base + gl.free_qty_base) as qty
  from grn_lines gl
  join goods_receipts g on g.id = gl.grn_id
  where g.po_id is not null
  group by gl.drug_id, g.po_id
) g on g.drug_id = l.drug_id and g.po_id = l.po_id;

create view purchase_orders_open as
select
  p.id            as po_id,
  p.po_no,
  p.status,
  p.supplier_id,
  s.name          as supplier_name,
  s.whatsapp_number,
  p.estimated_total,
  p.created_at,
  p.sent_at,
  p.acknowledged_at,
  p.expected_on,
  p.supplier_reply,
  p.sends,
  (select count(*) from po_lines l where l.po_id = p.id)::int as lines,
  (select coalesce(sum(v.outstanding_qty_base), 0)
   from purchase_order_lines v where v.po_id = p.id)::int      as outstanding_qty_base
from purchase_orders p
join suppliers s on s.id = p.supplier_id
where p.status in ('draft', 'sent', 'acknowledged', 'partial');

grant select on purchase_order_lines, purchase_orders_open to authenticated;

comment on view purchase_orders_open is
  'Everything not yet closed. A part-delivered order stays here with what is still outstanding on it.';
comment on function app.send_purchase_order(uuid) is
  'Records the message, then hands the text back. The app never claims it was delivered — it cannot know (WHATSAPP.md §0).';
comment on function app.receive_against_po(uuid, jsonb, text, date, boolean, text) is
  'Composes app.receive_goods. A GRN with no PO stays perfectly valid — it is how half the stock is actually bought.';
