-- The drug master import. PLAN.md §16 go-live step 1, INVENTORY.md §9.
--
-- "Load drug master, suppliers, opening stock (clinic closed, one day)."
--
-- Until this migration that step was a developer with psql, which makes the
-- doctor's 1–2 weeks of work a document he sends somebody rather than a file he
-- loads. It is also the single biggest bottleneck in the whole schedule
-- (BUILD.md §3), so the thing that unblocks it is worth building carefully.
--
-- THREE RULES, and the second one is the important one.
--
-- 1. **Dry run first.** The screen always previews: how many rows are new, how
--    many update something that exists, and every row that cannot be read. A
--    drug master is five hundred rows typed by a busy person, and the first
--    attempt is never clean.
--
-- 2. **All or nothing.** If any row fails validation the whole import is
--    refused. A half-imported drug master is worse than no import: the missing
--    half looks exactly like a drug the clinic does not stock, and the way that
--    surfaces is a prescription that cannot be dispensed with the patient
--    standing there. Fix the file, run it again.
--
-- 3. **Idempotent.** Matching is on name + strength, so running the same file
--    twice updates rather than duplicates. He WILL run it twice — everybody
--    does, usually after fixing three rows — and a duplicated drug master is a
--    week of cleanup.
--
-- What it deliberately does NOT do: delete. A drug that disappears from the
-- file is left alone rather than removed, because a row missing from a
-- spreadsheet is far more often a mistake than a decision, and `active = false`
-- is a deliberate act somebody takes on a screen.
--
-- Error code added here:
--   CL025  the file has rows that cannot be imported

-- Matching key for the import. Brand plus strength, because "Dolo" alone is
-- three products and the master will contain all three.
create unique index drugs_name_strength_idx on drugs (lower(name), lower(strength));

create or replace function app.import_drugs(
  p_rows    jsonb,
  p_dry_run boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id      uuid;
  v_row           jsonb;
  v_index         int := 0;
  v_errors        jsonb := '[]'::jsonb;
  v_created       int := 0;
  v_updated       int := 0;
  v_new_suppliers int := 0;
  v_supplier_id   uuid;
  v_supplier_name text;
  v_existing      uuid;
  v_name          text;
  v_strength      text;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  -- The drug master decides what can be prescribed and what a strip is worth.
  if app.current_staff_role() not in ('doctor', 'admin') then
    raise exception 'the drug master is loaded by the doctor or an admin'
      using errcode = 'CL005';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'there is nothing in that file' using errcode = 'CL006';
  end if;

  -- ------------------------------------------------------------------------
  -- Pass one: read every row and collect every complaint.
  --
  -- Every row, not the first failure. Somebody fixing a five-hundred-row file
  -- one error per attempt gives up, and rightly.
  -- ------------------------------------------------------------------------
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_index := v_index + 1;
    v_name     := nullif(trim(coalesce(v_row ->> 'name', '')), '');
    v_strength := nullif(trim(coalesce(v_row ->> 'strength', '')), '');

    if v_name is null then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'message', 'no drug name');
      continue;
    end if;

    if v_strength is null then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_name,
        'message', 'no strength — "Dolo" alone is three different products');
      continue;
    end if;

    -- INVENTORY.md §7 and §9: salt, strength and form are what make
    -- substitution a lookup instead of a clinical judgement, so a master
    -- without them is a master that cannot do the job it was collected for.
    if nullif(trim(coalesce(v_row ->> 'salt_composition', '')), '') is null then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_name,
        'message', 'no salt composition — substitution needs it (INVENTORY.md §7)');
      continue;
    end if;

    if nullif(trim(coalesce(v_row ->> 'form', '')), '') is null then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_name, 'message', 'no dosage form');
      continue;
    end if;

    if coalesce(v_row ->> 'base_unit', 'tablet') not in ('tablet', 'ml', 'piece') then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_name,
        'message', format('base unit "%s" is not tablet, ml or piece',
                          v_row ->> 'base_unit'));
      continue;
    end if;

    if coalesce(v_row ->> 'schedule', 'OTC') not in ('OTC', 'H', 'H1', 'X') then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_name,
        'message', format('schedule "%s" is not OTC, H, H1 or X', v_row ->> 'schedule'));
      continue;
    end if;

    if coalesce((v_row ->> 'units_per_strip')::int, 1) <= 0
       or coalesce((v_row ->> 'strips_per_box')::int, 1) <= 0 then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_name, 'message', 'pack sizes have to be positive');
      continue;
    end if;

    select id into v_existing from drugs
    where lower(name) = lower(v_name) and lower(strength) = lower(v_strength);

    if v_existing is null then
      v_created := v_created + 1;
    else
      v_updated := v_updated + 1;
    end if;
  end loop;

  -- Rule 2. Nothing is written while the file has a bad row in it.
  if jsonb_array_length(v_errors) > 0 then
    if p_dry_run then
      return jsonb_build_object(
        'dry_run', true, 'created', 0, 'updated', 0,
        'suppliers_created', 0, 'errors', v_errors);
    end if;

    raise exception '% of % rows cannot be imported — nothing was written',
      jsonb_array_length(v_errors), jsonb_array_length(p_rows)
      using errcode = 'CL025';
  end if;

  if p_dry_run then
    return jsonb_build_object(
      'dry_run', true, 'created', v_created, 'updated', v_updated,
      'suppliers_created', 0, 'errors', '[]'::jsonb);
  end if;

  -- ------------------------------------------------------------------------
  -- Pass two: write. Everything below here has already been read once.
  -- ------------------------------------------------------------------------
  v_created := 0;
  v_updated := 0;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_name     := trim(v_row ->> 'name');
    v_strength := trim(v_row ->> 'strength');

    -- Suppliers arrive by name in the same file, because that is how the
    -- doctor's spreadsheet is shaped. A name nobody has seen becomes a
    -- supplier with nothing else filled in, which is honest: the WhatsApp
    -- number and the return window are decisions, not import data.
    v_supplier_id   := null;
    v_supplier_name := nullif(trim(coalesce(v_row ->> 'supplier', '')), '');

    if v_supplier_name is not null then
      select id into v_supplier_id from suppliers
      where lower(name) = lower(v_supplier_name);

      if v_supplier_id is null then
        insert into suppliers (name) values (v_supplier_name)
        returning id into v_supplier_id;
        v_new_suppliers := v_new_suppliers + 1;
      end if;
    end if;

    select id into v_existing from drugs
    where lower(name) = lower(v_name) and lower(strength) = lower(v_strength);

    if v_existing is null then
      insert into drugs (
        name, generic, salt_composition, strength, form, base_unit,
        default_units_per_strip, default_strips_per_box, schedule, hsn,
        default_supplier_id, reorder_level_base, reorder_qty_base)
      values (
        v_name,
        nullif(trim(coalesce(v_row ->> 'generic', '')), ''),
        trim(v_row ->> 'salt_composition'),
        v_strength,
        trim(v_row ->> 'form'),
        coalesce(v_row ->> 'base_unit', 'tablet')::base_unit,
        coalesce((v_row ->> 'units_per_strip')::int, 1),
        coalesce((v_row ->> 'strips_per_box')::int, 1),
        coalesce(v_row ->> 'schedule', 'OTC')::drug_schedule,
        nullif(trim(coalesce(v_row ->> 'hsn', '')), ''),
        v_supplier_id,
        (v_row ->> 'reorder_level_base')::int,
        (v_row ->> 'reorder_qty_base')::int);

      v_created := v_created + 1;
    else
      -- Update, but never blank a field the file left empty: the second run of
      -- a trimmed-down file must not wipe the reorder levels somebody set on a
      -- screen last week.
      update drugs set
        generic          = coalesce(nullif(trim(coalesce(v_row ->> 'generic', '')), ''), generic),
        salt_composition = trim(v_row ->> 'salt_composition'),
        form             = trim(v_row ->> 'form'),
        base_unit        = coalesce(v_row ->> 'base_unit', base_unit::text)::base_unit,
        default_units_per_strip = coalesce((v_row ->> 'units_per_strip')::int, default_units_per_strip),
        default_strips_per_box  = coalesce((v_row ->> 'strips_per_box')::int, default_strips_per_box),
        schedule         = coalesce(v_row ->> 'schedule', schedule::text)::drug_schedule,
        hsn              = coalesce(nullif(trim(coalesce(v_row ->> 'hsn', '')), ''), hsn),
        default_supplier_id = coalesce(v_supplier_id, default_supplier_id),
        reorder_level_base  = coalesce((v_row ->> 'reorder_level_base')::int, reorder_level_base),
        reorder_qty_base    = coalesce((v_row ->> 'reorder_qty_base')::int, reorder_qty_base)
      where id = v_existing;

      v_updated := v_updated + 1;
    end if;
  end loop;

  perform app.write_audit('import_drugs', 'drugs', null, null,
    jsonb_build_object('created', v_created, 'updated', v_updated,
                       'suppliers_created', v_new_suppliers,
                       'rows', jsonb_array_length(p_rows)));

  return jsonb_build_object(
    'dry_run', false, 'created', v_created, 'updated', v_updated,
    'suppliers_created', v_new_suppliers, 'errors', '[]'::jsonb);
end
$$;

revoke all on function app.import_drugs(jsonb, boolean) from public;
grant execute on function app.import_drugs(jsonb, boolean) to authenticated, service_role;

comment on function app.import_drugs(jsonb, boolean) is
  'All or nothing, idempotent on name+strength, and it never deletes. A half-imported drug master is worse than none (PLAN.md §16).';
