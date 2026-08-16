-- The transition harness, proved with `dispense`.
--
-- BUILD.md §1.5: build ONE transition end to end as the pattern the other
-- eleven copy. `dispense` is the one chosen because it carries every real
-- invariant at once — FEFO, expiry, Schedule H1, stock never negative, the MRP
-- ceiling — so a pattern that survives it survives the rest.
--
-- The pattern, in four parts:
--   1. a plpgsql function, SECURITY DEFINER, doing its state change and writing
--      its audit_log row in the same transaction;
--   2. direct INSERT/UPDATE grants revoked on the tables it owns;
--   3. a thin typed wrapper in lib/transitions/;
--   4. a pgTAP test proving the audit row exists, and a second proving a direct
--      write is REFUSED.
--
-- Part 2 is the point of the whole exercise. It is what converts PLAN.md §5.3
-- rules 2 and 3 from a convention everyone agrees to follow into something
-- Postgres enforces against code that has not been written yet.
--
-- Error codes, so the TypeScript wrapper can map failures to messages a
-- pharmacist can act on.
--
-- The `CL` prefix is not decoration and must not be "tidied" to something
-- shorter. PostgREST — which is what Supabase puts in front of Postgres —
-- reserves SQLSTATEs beginning `PT` and reads the remaining three characters as
-- the HTTP status to return. An earlier version of this file used PT001…PT015,
-- so a Schedule H1 refusal (PT003) asked PostgREST for HTTP status 3. The
-- result was not an error the client could show: the response never framed
-- properly, the browser's fetch neither resolved nor rejected, and the counter
-- screen sat on "Selling…" forever while the pharmacist was told nothing at
-- all. Every transition refusal in the build was affected, and only the success
-- paths worked — which is exactly why it hid for so long.
--
-- Any class Postgres and PostgREST both leave alone will do. `CL` is free:
--   CL001  insufficient stock
--   CL002  no usable (unexpired) batch
--   CL003  Schedule H1 cannot leave on a counter sale
--   CL004  line total would exceed MRP
--   CL005  no staff attribution
--   CL006  malformed input

-- ---------------------------------------------------------------------------
-- Part 2, stated explicitly. These tables are transition-owned: the grants were
-- never issued in 0500, and these REVOKEs are here so that a future migration
-- adding a convenience grant has to argue with this comment first.
-- ---------------------------------------------------------------------------
revoke insert, update, delete on stock_batches   from authenticated, anon;
revoke insert, update, delete on stock_movements from authenticated, anon;
revoke insert, update, delete on dispenses       from authenticated, anon;
revoke insert, update, delete on dispense_lines  from authenticated, anon;
revoke insert, update, delete on audit_log       from authenticated, anon;

-- ---------------------------------------------------------------------------
-- app.dispense
--
-- p_lines: [{ drug_id, qty_base, prescribed_drug_id?, substitution_approved_by? }]
-- Quantities are base units. Always. The UI converts strips and boxes at the
-- edge (lib/units); nothing below this line knows what a strip is.
-- ---------------------------------------------------------------------------
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
