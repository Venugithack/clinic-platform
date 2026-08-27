-- Supplier administration for this clinic.
--
-- The purchasing system already knows how to draft purchase orders, send them
-- through a one-click WhatsApp hand-off and measure supplier lead time. What it
-- did not have was a clinic-facing way to maintain the supplier master or say
-- that the same medicine may be bought from more than one supplier.
--
-- Keep drugs.default_supplier_id: reorder_suggestions and the existing PO flow
-- already use it. `drug_suppliers` adds the alternatives around that field and
-- the transitions below keep the preferred mapping and default_supplier_id in
-- sync, so none of the established purchasing logic has to be rewritten.

create table drug_suppliers (
  drug_id             uuid not null references drugs (id),
  supplier_id         uuid not null references suppliers (id),
  supplier_drug_name  text,
  supplier_sku        text,
  is_preferred        boolean not null default false,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (drug_id, supplier_id)
);

-- One preferred supplier at a time. Alternative suppliers remain linked and
-- can be promoted with one action in the admin screen.
create unique index drug_suppliers_one_preferred
  on drug_suppliers (drug_id)
  where is_preferred and active;

create index drug_suppliers_supplier_idx
  on drug_suppliers (supplier_id, active, drug_id);

create trigger drug_suppliers_touch
  before update on drug_suppliers
  for each row execute function app.touch_updated_at();

-- Existing installations already have a default supplier on many medicines.
-- Preserve that configuration as the initial preferred mapping.
insert into drug_suppliers (drug_id, supplier_id, is_preferred)
select id, default_supplier_id, true
from drugs
where default_supplier_id is not null
on conflict (drug_id, supplier_id) do update
set is_preferred = true, active = true;

alter table drug_suppliers enable row level security;

create policy drug_suppliers_staff_read on drug_suppliers
  for select to authenticated
  using (app.current_staff_id() is not null);

grant select on drug_suppliers to authenticated, service_role;
revoke insert, update, delete on drug_suppliers from authenticated;

-- ---------------------------------------------------------------------------
-- Supplier master. Nothing is deleted: purchase orders, GRNs and old batches
-- continue to name the supplier after the clinic stops buying from them.
-- ---------------------------------------------------------------------------
create or replace function app.add_supplier(
  p_name               text,
  p_contact_name       text default null,
  p_whatsapp_number    text default null,
  p_phone              text default null,
  p_email              text default null,
  p_gstin              text default null,
  p_lead_time_days     int default null,
  p_return_window_days int default null,
  p_payment_terms      text default null
) returns suppliers
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_supplier suppliers;
begin
  if app.current_staff_role() is distinct from 'admin' then
    raise exception 'suppliers are managed by an administrator' using errcode = 'CL005';
  end if;

  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'a supplier needs a name' using errcode = 'CL006';
  end if;
  if p_lead_time_days is not null and p_lead_time_days < 0 then
    raise exception 'lead time cannot be negative' using errcode = 'CL006';
  end if;
  if p_return_window_days is not null and p_return_window_days < 0 then
    raise exception 'return window cannot be negative' using errcode = 'CL006';
  end if;

  insert into suppliers (
    name, contact_name, whatsapp_number, phone, email, gstin,
    lead_time_days, return_window_days, payment_terms)
  values (
    trim(p_name),
    nullif(trim(coalesce(p_contact_name, '')), ''),
    nullif(trim(coalesce(p_whatsapp_number, '')), ''),
    nullif(trim(coalesce(p_phone, '')), ''),
    nullif(trim(coalesce(p_email, '')), ''),
    nullif(trim(coalesce(p_gstin, '')), ''),
    p_lead_time_days,
    p_return_window_days,
    nullif(trim(coalesce(p_payment_terms, '')), ''))
  returning * into v_supplier;

  perform app.write_audit('add_supplier', 'supplier', v_supplier.id, null,
    to_jsonb(v_supplier));

  return v_supplier;
end
$$;

create or replace function app.update_supplier(
  p_supplier_id        uuid,
  p_name               text default null,
  p_contact_name       text default null,
  p_whatsapp_number    text default null,
  p_phone              text default null,
  p_email              text default null,
  p_gstin              text default null,
  p_lead_time_days     int default null,
  p_return_window_days int default null,
  p_payment_terms      text default null,
  p_active             boolean default null
) returns suppliers
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_before   suppliers;
  v_supplier suppliers;
begin
  if app.current_staff_role() is distinct from 'admin' then
    raise exception 'suppliers are managed by an administrator' using errcode = 'CL005';
  end if;

  select * into v_before from suppliers where id = p_supplier_id;
  if not found then
    raise exception 'no such supplier' using errcode = 'CL006';
  end if;

  if p_name is not null and nullif(trim(p_name), '') is null then
    raise exception 'a supplier needs a name' using errcode = 'CL006';
  end if;
  if p_lead_time_days is not null and p_lead_time_days < 0 then
    raise exception 'lead time cannot be negative' using errcode = 'CL006';
  end if;
  if p_return_window_days is not null and p_return_window_days < 0 then
    raise exception 'return window cannot be negative' using errcode = 'CL006';
  end if;

  update suppliers set
    name = case when p_name is null then name else trim(p_name) end,
    contact_name = case when p_contact_name is null then contact_name else nullif(trim(p_contact_name), '') end,
    whatsapp_number = case when p_whatsapp_number is null then whatsapp_number else nullif(trim(p_whatsapp_number), '') end,
    phone = case when p_phone is null then phone else nullif(trim(p_phone), '') end,
    email = case when p_email is null then email else nullif(trim(p_email), '') end,
    gstin = case when p_gstin is null then gstin else nullif(trim(p_gstin), '') end,
    lead_time_days = coalesce(p_lead_time_days, lead_time_days),
    return_window_days = coalesce(p_return_window_days, return_window_days),
    payment_terms = case when p_payment_terms is null then payment_terms else nullif(trim(p_payment_terms), '') end,
    active = coalesce(p_active, active)
  where id = p_supplier_id
  returning * into v_supplier;

  -- Deactivation is the clinic saying "do not order from here". Existing POs,
  -- GRNs and stock keep the supplier for history, but future reorder proposals
  -- must not keep pointing at it.
  if v_before.active and not v_supplier.active then
    update drug_suppliers
      set active = false, is_preferred = false
    where supplier_id = p_supplier_id and active;

    update drugs
      set default_supplier_id = null
    where default_supplier_id = p_supplier_id;
  end if;

  perform app.write_audit('update_supplier', 'supplier', p_supplier_id,
    to_jsonb(v_before), to_jsonb(v_supplier));

  return v_supplier;
end
$$;

-- ---------------------------------------------------------------------------
-- Link a medicine to a supplier. Calling this again edits the relationship.
-- Setting preferred atomically demotes the old one and updates the legacy
-- default_supplier_id that reorder_suggestions already consumes.
-- ---------------------------------------------------------------------------
create or replace function app.set_drug_supplier(
  p_drug_id            uuid,
  p_supplier_id        uuid,
  p_is_preferred       boolean default false,
  p_supplier_drug_name text default null,
  p_supplier_sku       text default null,
  p_active             boolean default true
) returns drug_suppliers
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_link drug_suppliers;
  v_supplier_active boolean;
begin
  if app.current_staff_role() is distinct from 'admin' then
    raise exception 'medicine suppliers are managed by an administrator' using errcode = 'CL005';
  end if;

  if not exists (select 1 from drugs where id = p_drug_id) then
    raise exception 'no such medicine' using errcode = 'CL006';
  end if;

  select active into v_supplier_active from suppliers where id = p_supplier_id;
  if not found then
    raise exception 'no such supplier' using errcode = 'CL006';
  end if;
  if coalesce(p_active, true) and not v_supplier_active then
    raise exception 'that supplier is inactive — reactivate it before linking medicines'
      using errcode = 'CL006';
  end if;

  if coalesce(p_is_preferred, false) and coalesce(p_active, true) then
    update drug_suppliers
      set is_preferred = false
    where drug_id = p_drug_id and supplier_id <> p_supplier_id and is_preferred;
  end if;

  insert into drug_suppliers (
    drug_id, supplier_id, supplier_drug_name, supplier_sku, is_preferred, active)
  values (
    p_drug_id,
    p_supplier_id,
    nullif(trim(coalesce(p_supplier_drug_name, '')), ''),
    nullif(trim(coalesce(p_supplier_sku, '')), ''),
    coalesce(p_is_preferred, false) and coalesce(p_active, true),
    coalesce(p_active, true))
  on conflict (drug_id, supplier_id) do update set
    supplier_drug_name = case
      when p_supplier_drug_name is null then drug_suppliers.supplier_drug_name
      else nullif(trim(p_supplier_drug_name), '') end,
    supplier_sku = case
      when p_supplier_sku is null then drug_suppliers.supplier_sku
      else nullif(trim(p_supplier_sku), '') end,
    is_preferred = coalesce(p_is_preferred, false) and coalesce(p_active, true),
    active = coalesce(p_active, true)
  returning * into v_link;

  if v_link.is_preferred and v_link.active then
    update drugs set default_supplier_id = p_supplier_id where id = p_drug_id;
  elsif not v_link.active
        and exists (
          select 1 from drugs
          where id = p_drug_id and default_supplier_id = p_supplier_id) then
    update drugs set default_supplier_id = null where id = p_drug_id;
  end if;

  perform app.write_audit('set_drug_supplier', 'drug_supplier', p_drug_id,
    null, to_jsonb(v_link));

  return v_link;
end
$$;

revoke all on function app.add_supplier(text, text, text, text, text, text, int, int, text) from public;
revoke all on function app.update_supplier(uuid, text, text, text, text, text, text, int, int, text, boolean) from public;
revoke all on function app.set_drug_supplier(uuid, uuid, boolean, text, text, boolean) from public;

grant execute on function app.add_supplier(text, text, text, text, text, text, int, int, text)
  to authenticated, service_role;
grant execute on function app.update_supplier(uuid, text, text, text, text, text, text, int, int, text, boolean)
  to authenticated, service_role;
grant execute on function app.set_drug_supplier(uuid, uuid, boolean, text, text, boolean)
  to authenticated, service_role;

comment on table drug_suppliers is
  'Which suppliers can supply each medicine. Exactly one active link may be preferred; that preferred link is mirrored to drugs.default_supplier_id for the existing reorder/PO flow.';
