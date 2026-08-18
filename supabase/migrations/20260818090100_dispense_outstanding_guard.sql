-- A prescription cannot be dispensed for more than it asks for.
--
-- Found by testing, not by review: the two-tablet double-dispense described in
-- the guard comment below. `app.dispense` validated the request against the
-- shelf and never against the prescription, so the same prescription could be
-- dispensed repeatedly, each time taking stock, each time reporting success.
--
-- Error code:
--   CL028  more than this prescription still has outstanding
--
-- Down-path (PLAN.md §16): re-run 20260816090600_transition_dispense.sql to put
-- the previous definition back. This migration replaces one function and adds
-- no schema, so reverting is that single \i and nothing else. Note what returns
-- with it — a prescription that can be dispensed twice.
--
-- Nothing is backfilled. Dispenses already recorded stay as they are; a
-- clinic that has over-dispensed needs a stock-take, which is a decision for a
-- person and not for a migration.

create or replace function app.dispense(
  p_lines           jsonb,
  p_prescription_id uuid    default null,
  p_patient_id      uuid    default null,
  p_is_counter_sale boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id      uuid;
  v_dispense_id   uuid;
  v_line          jsonb;
  v_drug          drugs%rowtype;
  v_batch         record;
  v_drug_id       uuid;
  v_qty_base      int;
  v_remaining     int;
  v_take          int;
  v_units_in_pack int;
  v_unit_price    numeric(12, 4);
  v_cap           numeric(12, 2);
  v_amount        numeric(12, 2);
  v_movement_type stock_movement_type;
  v_total         numeric(12, 2) := 0;
  v_line_count    int := 0;
  v_prescribed_id uuid;
  v_approved_by   uuid;
  v_fully_dispensed boolean;
  v_over            record;
begin
  -- Attribution first. Every write carries the staff id from the PIN, because
  -- the Schedule H1 register legally needs a person's name, not a tablet's.
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'dispense needs at least one line' using errcode = 'CL006';
  end if;

  if p_prescription_id is null and not p_is_counter_sale then
    raise exception 'a dispense must be against a prescription or flagged as a counter sale'
      using errcode = 'CL006';
  end if;

  v_movement_type := case when p_is_counter_sale then 'sale' else 'dispense' end;

  -- ---------------------------------------------------------------------------
  -- What this prescription still has outstanding.
  --
  -- Until this block existed, `dispense` checked only whether the SHELF could
  -- satisfy the request. It never asked whether the PRESCRIPTION could. Status
  -- was computed afterwards by summing every dispense_line ever recorded
  -- against it, which made "dispense the remainder" and "dispense the whole
  -- thing a second time" the same call.
  --
  -- Reachable with two taps and no privilege: the cabin tablet and the counter
  -- tablet both open one prescription while it is still pending, both verify,
  -- both press Dispense. Thirty tablets leave the shelf for a fifteen-tablet
  -- prescription, both screens report success, and the patient appears twice on
  -- the billing screen at the same amount and the same second. Nothing is
  -- flagged until a stock-take months later.
  --
  -- The FOR UPDATE is the half that fixes the race rather than merely the
  -- repeat. Two concurrent calls both read "15 outstanding" and both proceed
  -- unless one of them is made to wait here; the second then sees the first's
  -- dispense_lines and is refused.
  --
  -- Partial dispensing is why no guard was here in the first place, so the test
  -- is against the REMAINDER, never against "has this been dispensed at all":
  -- 4 of 10 then 6 of 10 still works, and the 11th unit does not.
  -- ---------------------------------------------------------------------------
  if p_prescription_id is not null then
    perform 1 from prescriptions where id = p_prescription_id for update;
    if not found then
      raise exception 'unknown prescription %', p_prescription_id using errcode = 'CL006';
    end if;

    for v_over in
      with requested as (
        select coalesce((l ->> 'prescribed_drug_id')::uuid, (l ->> 'drug_id')::uuid) as drug_id,
               sum((l ->> 'qty_base')::int) as qty
        from jsonb_array_elements(p_lines) l
        group by 1
      ),
      -- A substitute counts against the drug it replaced, exactly as the status
      -- calculation below already counts it. Keying these two differently is
      -- how a guard like this ends up refusing every approved substitution.
      prescribed as (
        select (i ->> 'drug_id')::uuid as drug_id, sum((i ->> 'qty_base')::int) as qty
        from prescriptions p, jsonb_array_elements(p.items) i
        where p.id = p_prescription_id
        group by 1
      ),
      already as (
        select coalesce(dl.prescribed_drug_id, dl.drug_id) as drug_id, sum(dl.qty_base) as qty
        from dispense_lines dl
        join dispenses d on d.id = dl.dispense_id
        where d.prescription_id = p_prescription_id
        group by 1
      )
      select r.drug_id,
             r.qty                                             as want,
             coalesce(pr.qty, 0)                               as prescribed_qty,
             coalesce(pr.qty, 0) - coalesce(a.qty, 0)          as outstanding
      from requested r
      left join prescribed pr on pr.drug_id = r.drug_id
      left join already    a  on a.drug_id  = r.drug_id
      where r.qty > coalesce(pr.qty, 0) - coalesce(a.qty, 0)
    loop
      select * into v_drug from drugs where id = v_over.drug_id;

      if v_over.prescribed_qty = 0 then
        raise exception '"%" is not on this prescription', coalesce(v_drug.name, v_over.drug_id::text)
          using errcode = 'CL028';
      end if;

      if v_over.outstanding <= 0 then
        raise exception '"%" has already been dispensed in full against this prescription',
          v_drug.name
          using errcode = 'CL028';
      end if;

      raise exception
        'only % base units of "%" are still outstanding on this prescription, not %',
        v_over.outstanding, v_drug.name, v_over.want
        using errcode = 'CL028';
    end loop;
  end if;

  insert into dispenses (prescription_id, patient_id, staff_id, is_counter_sale)
  values (p_prescription_id, p_patient_id, v_staff_id, p_is_counter_sale)
  returning id into v_dispense_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_drug_id       := (v_line ->> 'drug_id')::uuid;
    v_qty_base      := (v_line ->> 'qty_base')::int;
    v_prescribed_id := (v_line ->> 'prescribed_drug_id')::uuid;
    v_approved_by   := (v_line ->> 'substitution_approved_by')::uuid;

    if v_drug_id is null or v_qty_base is null or v_qty_base <= 0 then
      raise exception 'each line needs a drug_id and a positive qty_base'
        using errcode = 'CL006';
    end if;

    select * into v_drug from drugs where id = v_drug_id;
    if not found then
      raise exception 'unknown drug %', v_drug_id using errcode = 'CL006';
    end if;

    -- Legal, not a preference: a Schedule H1 drug cannot leave the counter
    -- without a prescription (PLAN.md §15.2, INVENTORY.md §3).
    if p_is_counter_sale and v_drug.schedule = 'H1' then
      raise exception 'Schedule H1 drug "%" cannot be sold without a prescription', v_drug.name
        using errcode = 'CL003';
    end if;

    v_remaining := v_qty_base;

    -- FEFO: first expiry, first out. Expired batches are not in this cursor at
    -- all — they are excluded from on-hand, not merely flagged, which is the
    -- INVENTORY.md §3 rule that stops the prototype's expired-stock bug.
    -- Allocation splits across batches and records each, for recall traceability.
    for v_batch in
      select b.id, b.qty_base_on_hand, b.mrp, b.mrp_basis,
             b.units_per_strip, b.strips_per_box, b.cost_per_base_unit
      from stock_batches b
      where b.drug_id = v_drug_id
        and b.qty_base_on_hand > 0
        and b.expiry >= current_date
      order by b.expiry asc, b.received_at asc
      for update
    loop
      exit when v_remaining = 0;

      v_take := least(v_remaining, v_batch.qty_base_on_hand);

      v_units_in_pack := app.units_in_pack(
        v_batch.units_per_strip, v_batch.strips_per_box, v_batch.mrp_basis::text
      );
      v_unit_price := round(v_batch.mrp / v_units_in_pack, 4);

      -- The MRP ceiling. Selling above the printed MRP is illegal, so rounding
      -- a loose-tablet price up past it is a legal problem, not a rounding
      -- problem: the paise-rounded figure is clamped to the exact pro-rata cap.
      v_cap    := trunc(v_batch.mrp * v_take::numeric / v_units_in_pack, 2);
      v_amount := least(round(v_take * v_unit_price, 2), v_cap);

      if v_amount > v_cap then
        raise exception 'line total % exceeds MRP ceiling % for batch %',
          v_amount, v_cap, v_batch.id
          using errcode = 'CL004';
      end if;

      insert into dispense_lines (
        dispense_id, drug_id, batch_id, qty_base, unit_price, amount,
        cost_at_dispense, prescribed_drug_id, substitution_approved_by
      )
      values (
        v_dispense_id, v_drug_id, v_batch.id, v_take, v_unit_price, v_amount,
        v_batch.cost_per_base_unit, v_prescribed_id, v_approved_by
      );

      -- The ledger row and the cache update, in the same transaction. Rule 3.
      insert into stock_movements (drug_id, batch_id, qty_base, type, ref_type, ref_id, staff_id)
      values (v_drug_id, v_batch.id, -v_take, v_movement_type, 'dispense', v_dispense_id, v_staff_id);

      update stock_batches
      set qty_base_on_hand = qty_base_on_hand - v_take
      where id = v_batch.id;

      v_remaining  := v_remaining - v_take;
      v_total      := v_total + v_amount;
      v_line_count := v_line_count + 1;
    end loop;

    -- Stock can never go negative: no override, no staff role, no "allow" flag.
    -- A short dispense fails the whole transaction rather than inventing stock.
    -- The counter's route out of "it is on the shelf but not in the system" is
    -- the inline quick-GRN (INVENTORY.md §3), not a negative number.
    if v_remaining > 0 then
      if v_remaining = v_qty_base then
        raise exception
          'no unexpired stock of "%" — % base units required', v_drug.name, v_qty_base
          using errcode = 'CL002';
      end if;
      raise exception
        'insufficient stock of "%" — short by % of % base units',
        v_drug.name, v_remaining, v_qty_base
        using errcode = 'CL001';
    end if;
  end loop;

  -- Prescription status follows from what has actually been dispensed against
  -- it, across every dispense, counting a substitute against what it replaced.
  if p_prescription_id is not null then
    select bool_and(coalesce(g.qty, 0) >= w.qty)
    into v_fully_dispensed
    from (
      select (i ->> 'drug_id')::uuid as drug_id, sum((i ->> 'qty_base')::int) as qty
      from prescriptions p, jsonb_array_elements(p.items) i
      where p.id = p_prescription_id
      group by 1
    ) w
    left join (
      select coalesce(dl.prescribed_drug_id, dl.drug_id) as drug_id, sum(dl.qty_base) as qty
      from dispense_lines dl
      join dispenses d on d.id = dl.dispense_id
      where d.prescription_id = p_prescription_id
      group by 1
    ) g on g.drug_id = w.drug_id;

    update prescriptions
    set status = (case
                   when coalesce(v_fully_dispensed, false) then 'dispensed'
                   else 'partial'
                 end)::prescription_status
    where id = p_prescription_id;
  end if;

  -- The audit row, written here rather than by a caller who remembers to, and
  -- carrying changed fields only rather than a row snapshot (HOSTING.md §4).
  perform app.write_audit(
    'dispense',
    'dispenses',
    v_dispense_id,
    null,
    jsonb_build_object(
      'prescription_id', p_prescription_id,
      'patient_id',      p_patient_id,
      'is_counter_sale', p_is_counter_sale,
      'lines',           v_line_count,
      'total',           v_total
    )
  );

  return v_dispense_id;
end
$$;

revoke all on function app.dispense(jsonb, uuid, uuid, boolean) from public;
grant execute on function app.dispense(jsonb, uuid, uuid, boolean) to authenticated, service_role;

comment on function app.dispense(jsonb, uuid, uuid, boolean) is
  'FEFO dispense. The M0 reference transition (BUILD.md §1.5) — the pattern the other eleven copy.';
