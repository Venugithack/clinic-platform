-- Medicine administration for the clinic.
--
-- The original schema allowed any authenticated staff member to INSERT/UPDATE
-- drugs and suppliers directly. That was acceptable while master-data screens
-- did not exist, but it bypasses the admin-only supplier transitions added in
-- M12 and would make an admin-only medicine editor cosmetic rather than real.
-- From here on both masters are transition-owned.

revoke insert, update, delete on suppliers from authenticated;
revoke insert, update, delete on drugs from authenticated;

-- Old all-staff write policies no longer grant anything once the table grants
-- above are removed, but drop them so nobody reads a dead policy as proof that
-- direct writes are intended.
drop policy if exists suppliers_staff on suppliers;
drop policy if exists drugs_staff on drugs;

create policy suppliers_staff_read on suppliers
  for select to authenticated
  using (app.current_staff_id() is not null);

create policy drugs_staff_read on drugs
  for select to authenticated
  using (app.current_staff_id() is not null);

-- ---------------------------------------------------------------------------
-- Add a medicine.
--
-- Clinical identity is explicit at creation: salt + strength + form is also
-- the substitution key. Base unit is immutable by design because historical
-- stock quantities are recorded in that unit.
-- ---------------------------------------------------------------------------
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
  if app.current_staff_role() is distinct from 'admin' then
    raise exception 'medicines are managed by an administrator' using errcode = 'CL005';
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

-- ---------------------------------------------------------------------------
-- Update operational medicine settings.
--
-- Strength, salt, form and base_unit are intentionally absent. Those values
-- define what the medicine IS and how every historical stock number is counted.
-- If the clinic discovers that identity was wrong, create the correct medicine
-- and deactivate the old row rather than silently rewriting history.
-- ---------------------------------------------------------------------------
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
  if app.current_staff_role() is distinct from 'admin' then
    raise exception 'medicines are managed by an administrator' using errcode = 'CL005';
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

revoke all on function app.add_drug(text, text, text, text, base_unit, text, int, int, mrp_basis, drug_schedule, text, int, int) from public;
revoke all on function app.update_drug(uuid, text, text, int, int, mrp_basis, drug_schedule, text, int, int, boolean) from public;

grant execute on function app.add_drug(text, text, text, text, base_unit, text, int, int, mrp_basis, drug_schedule, text, int, int)
  to authenticated, service_role;
grant execute on function app.update_drug(uuid, text, text, int, int, mrp_basis, drug_schedule, text, int, int, boolean)
  to authenticated, service_role;

comment on function app.update_drug(uuid, text, text, int, int, mrp_basis, drug_schedule, text, int, int, boolean) is
  'Admin-only operational medicine editor. Clinical identity/base unit are immutable here so historical stock and substitution semantics are not rewritten.';
