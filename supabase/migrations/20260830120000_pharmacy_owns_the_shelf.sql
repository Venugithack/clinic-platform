-- The shelf belongs to the pharmacy.
--
-- ── THE DEAD END THIS REMOVES ───────────────────────────────────────────────
--
-- 20260827110100_medicine_admin and 20260827100100_supplier_admin made both
-- masters transition-owned and administrator-only. The reasoning was sound as
-- far as it went — "an admin-only medicine editor should be real rather than
-- cosmetic" — but it was reasoning about who OWNS a table, and the question
-- that matters is who is standing there when the row is needed.
--
-- What it produced in the room:
--
--   A delivery arrives. It contains a strip the clinic has not stocked before.
--   The pharmacist opens Add stock, searches, and it is not there. They cannot
--   add it: app.add_drug raises CL005 at them. The boxes are on the counter,
--   a patient is waiting, and the only way forward is to telephone the owner
--   and read the strip out to somebody who is not holding it.
--
-- The person holding the box is the person who can read the name, the salt, the
-- strength and the pack size off it correctly. Routing that through an
-- administrator does not make the data better, it makes it later and worse.
--
-- ── WHAT IS AND IS NOT LOOSENED ─────────────────────────────────────────────
--
-- `counter` joins `admin` on the five master-data transitions below. Nothing
-- else changes, and in particular:
--
--   · Direct INSERT/UPDATE/DELETE on drugs and suppliers stays revoked from
--     authenticated. Every write still goes through a transition that validates
--     and writes an audit row — that was the valuable half of the earlier
--     migrations and it is untouched.
--   · Clinical identity stays immutable. app.update_drug still has no
--     salt/strength/form/base_unit parameters, so no role can rewrite what a
--     medicine IS or what unit its stock history is counted in.
--   · `doctor` and `nurse` are still refused. This is the pharmacy's shelf,
--     not everybody's.
--
-- ── WHY THE GUARD IS TWO `is distinct from` AND NOT `not in (...)` ─────────
--
-- app.current_staff_role() returns NULL for anybody the database does not
-- recognise as staff, and `NULL not in ('admin','counter')` evaluates to NULL,
-- which PL/pgSQL's IF treats as false. Written the short way the guard does not
-- fire on a null role — it waves through exactly the caller it exists to stop.
-- `is distinct from` is null-safe and yields true, so an unknown caller is
-- refused. This was caught by the nurse case in C1/C2, which is why those two
-- tests assert a refusal and not only a permission.
--
-- The bodies below are the existing definitions with one line changed in each.
-- They are reproduced in full because that is what `create or replace function`
-- requires; diff them against the two migrations named above and the guard is
-- the only difference.

create or replace function app.add_drug(
  p_name                    text,
  p_salt_composition        text,
  p_strength                text,
  p_form                    text,
  p_base_unit                base_unit,
  p_generic                 text default null,
  p_default_units_per_strip int default 1,
  p_default_strips_per_box  int default 1,
  p_default_mrp_basis       mrp_basis default 'strip',
  p_schedule                drug_schedule default 'OTC',
  p_hsn                     text default null,
  p_reorder_level_base      int default null,
  p_reorder_qty_base        int default null
) returns drugs
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_drug drugs;
begin
  if app.current_staff_role() is distinct from 'admin'
     and app.current_staff_role() is distinct from 'counter' then
    raise exception 'medicines are managed by the pharmacy or an administrator' using errcode = 'CL005';
  end if;

  if nullif(trim(coalesce(p_name, '')), '') is null
     or nullif(trim(coalesce(p_salt_composition, '')), '') is null
     or nullif(trim(coalesce(p_strength, '')), '') is null
     or nullif(trim(coalesce(p_form, '')), '') is null then
    raise exception 'name, salt composition, strength and form are required'
      using errcode = 'CL006';
  end if;

  if coalesce(p_default_units_per_strip, 0) <= 0
     or coalesce(p_default_strips_per_box, 0) <= 0 then
    raise exception 'default pack sizes have to be positive' using errcode = 'CL006';
  end if;

  if p_reorder_level_base is not null and p_reorder_level_base < 0 then
    raise exception 'reorder level cannot be negative' using errcode = 'CL006';
  end if;
  if p_reorder_qty_base is not null and p_reorder_qty_base < 0 then
    raise exception 'reorder quantity cannot be negative' using errcode = 'CL006';
  end if;

  insert into drugs (
    name, generic, salt_composition, strength, form, base_unit,
    default_units_per_strip, default_strips_per_box, default_mrp_basis,
    schedule, hsn, reorder_level_base, reorder_qty_base)
  values (
    trim(p_name),
    nullif(trim(coalesce(p_generic, '')), ''),
    trim(p_salt_composition),
    trim(p_strength),
    trim(p_form),
    p_base_unit,
    p_default_units_per_strip,
    p_default_strips_per_box,
    p_default_mrp_basis,
    p_schedule,
    nullif(trim(coalesce(p_hsn, '')), ''),
    p_reorder_level_base,
    p_reorder_qty_base)
  returning * into v_drug;

  perform app.write_audit('add_drug', 'drug', v_drug.id, null, to_jsonb(v_drug));
  return v_drug;
end
$$;

create or replace function app.update_drug(
  p_drug_id                 uuid,
  p_name                    text default null,
  p_generic                 text default null,
  p_default_units_per_strip int default null,
  p_default_strips_per_box  int default null,
  p_default_mrp_basis       mrp_basis default null,
  p_schedule                drug_schedule default null,
  p_hsn                     text default null,
  p_reorder_level_base      int default null,
  p_reorder_qty_base        int default null,
  p_active                  boolean default null
) returns drugs
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_before drugs;
  v_drug   drugs;
begin
  if app.current_staff_role() is distinct from 'admin'
     and app.current_staff_role() is distinct from 'counter' then
    raise exception 'medicines are managed by the pharmacy or an administrator' using errcode = 'CL005';
  end if;

  select * into v_before from drugs where id = p_drug_id;
  if not found then
    raise exception 'no such medicine' using errcode = 'CL006';
  end if;

  if p_name is not null and nullif(trim(p_name), '') is null then
    raise exception 'a medicine needs a name' using errcode = 'CL006';
  end if;
  if p_default_units_per_strip is not null and p_default_units_per_strip <= 0 then
    raise exception 'units per strip has to be positive' using errcode = 'CL006';
  end if;
  if p_default_strips_per_box is not null and p_default_strips_per_box <= 0 then
    raise exception 'strips per box has to be positive' using errcode = 'CL006';
  end if;
  if p_reorder_level_base is not null and p_reorder_level_base < 0 then
    raise exception 'reorder level cannot be negative' using errcode = 'CL006';
  end if;
  if p_reorder_qty_base is not null and p_reorder_qty_base < 0 then
    raise exception 'reorder quantity cannot be negative' using errcode = 'CL006';
  end if;

  update drugs set
    name = case when p_name is null then name else trim(p_name) end,
    generic = case when p_generic is null then generic else nullif(trim(p_generic), '') end,
    default_units_per_strip = coalesce(p_default_units_per_strip, default_units_per_strip),
    default_strips_per_box = coalesce(p_default_strips_per_box, default_strips_per_box),
    default_mrp_basis = coalesce(p_default_mrp_basis, default_mrp_basis),
    schedule = coalesce(p_schedule, schedule),
    hsn = case when p_hsn is null then hsn else nullif(trim(p_hsn), '') end,
    reorder_level_base = coalesce(p_reorder_level_base, reorder_level_base),
    reorder_qty_base = coalesce(p_reorder_qty_base, reorder_qty_base),
    active = coalesce(p_active, active)
  where id = p_drug_id
  returning * into v_drug;

  perform app.write_audit('update_drug', 'drug', p_drug_id,
    to_jsonb(v_before), to_jsonb(v_drug));
  return v_drug;
end
$$;

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
  if app.current_staff_role() is distinct from 'admin'
     and app.current_staff_role() is distinct from 'counter' then
    raise exception 'suppliers are managed by the pharmacy or an administrator' using errcode = 'CL005';
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
  if app.current_staff_role() is distinct from 'admin'
     and app.current_staff_role() is distinct from 'counter' then
    raise exception 'suppliers are managed by the pharmacy or an administrator' using errcode = 'CL005';
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
  if app.current_staff_role() is distinct from 'admin'
     and app.current_staff_role() is distinct from 'counter' then
    raise exception 'medicine suppliers are managed by the pharmacy or an administrator' using errcode = 'CL005';
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

