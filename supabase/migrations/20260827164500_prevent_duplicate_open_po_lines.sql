-- Prevent the same medicine being ordered twice while an earlier purchase order
-- still has quantity outstanding.
--
-- The reorder screen hides rows already covered by an open PO, but that is only
-- a convenience. Two tablets can act on the same stale screen, so the invariant
-- belongs in the transition as well. The advisory lock serialises draft attempts
-- per medicine; the outstanding check then makes the second transaction see the
-- first one's draft and refuse it.

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
  v_drug_id     uuid;
  v_po_id       uuid;
  v_qty         int;
  v_cost        numeric(12, 4);
  v_orders      int := 0;
  v_by_supplier jsonb := '{}'::jsonb;
  v_open        record;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'an order needs at least one line' using errcode = 'CL006';
  end if;

  -- A payload cannot legitimately order the same medicine twice. Refusing this
  -- before any write also keeps one call all-or-nothing.
  if exists (
    select 1
    from jsonb_array_elements(p_lines) as item
    group by item ->> 'drug_id'
    having count(*) > 1
  ) then
    raise exception 'a medicine can appear only once in a draft order request'
      using errcode = 'CL006';
  end if;

  -- Lock all medicines in a deterministic order before checking outstanding
  -- quantities. Without this, two concurrent calls can both observe "nothing on
  -- order" and then both insert a draft. A hash collision only serialises two
  -- unrelated medicines; it cannot make an unsafe order possible.
  for v_drug_id in
    select distinct (item ->> 'drug_id')::uuid
    from jsonb_array_elements(p_lines) as item
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_drug_id::text, 0));
  end loop;

  -- Preflight every line before creating a single PO.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_drug_id     := (v_line ->> 'drug_id')::uuid;
    v_supplier_id := (v_line ->> 'supplier_id')::uuid;
    v_qty         := (v_line ->> 'qty_base')::int;

    if v_supplier_id is null then
      raise exception 'every order line needs a supplier' using errcode = 'CL006';
    end if;

    if v_qty is null or v_qty <= 0 then
      raise exception 'an order line has to order something' using errcode = 'CL006';
    end if;

    if not exists (select 1 from drugs where id = v_drug_id) then
      raise exception 'unknown drug %', v_line ->> 'drug_id' using errcode = 'CL006';
    end if;

    select pol.po_id,
           po.po_no,
           po.status,
           pol.outstanding_qty_base,
           d.name as drug_name
      into v_open
    from purchase_order_lines pol
    join purchase_orders po on po.id = pol.po_id
    join drugs d on d.id = pol.drug_id
    where pol.drug_id = v_drug_id
      and po.status in ('draft', 'sent', 'acknowledged', 'partial')
      and pol.outstanding_qty_base > 0
    order by po.created_at
    limit 1;

    if found then
      raise exception '% already has % % outstanding on % — finish or cancel that order before drafting another',
        v_open.drug_name,
        v_open.outstanding_qty_base,
        (select base_unit::text from drugs where id = v_drug_id),
        coalesce(v_open.po_no, 'an existing draft')
        using errcode = 'CL007';
    end if;
  end loop;

  -- The request is safe to write. Keep the existing one-draft-per-supplier
  -- behaviour within this tap.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_drug_id     := (v_line ->> 'drug_id')::uuid;
    v_supplier_id := (v_line ->> 'supplier_id')::uuid;
    v_qty         := (v_line ->> 'qty_base')::int;
    v_cost        := (v_line ->> 'expected_cost_per_base_unit')::numeric;

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
      (v_po_id, v_drug_id, v_qty,
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
  'Creates drafts only. Refuses a medicine that already has outstanding quantity on an open PO and serialises concurrent draft attempts for that medicine.';
