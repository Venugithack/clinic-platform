-- Opening stock. PLAN.md §16 go-live step 1, INVENTORY.md §1 and §4.
--
--   "Load drug master, suppliers, opening stock (clinic closed, one day)."
--
-- M11a did the first two. This is the third, and it is the one that decides
-- whether every stock number in the system is right or quietly wrong from day
-- one: the shelf on go-live morning already holds four hundred batches nobody
-- entered, each with a batch number, an expiry, a cost and an MRP.
--
-- **It goes through `app.receive_goods`.** Not around it. Opening stock is a
-- delivery that happened before the system existed, and everything the goods
-- receipt does is exactly what opening stock needs: pack-to-base-unit
-- conversion at the one boundary, the past-expiry refusal, the ledger row that
-- makes `qty_base_on_hand` a cache rather than a claim (rule 3), and a GRN the
-- purchase register can show. A second path that wrote `stock_batches`
-- directly would be a second place for the ledger to drift, and drift in the
-- opening balance is drift nobody ever finds.
--
-- Three rules of its own.
--
-- 1. **The drug must already exist.** A stock row naming a drug the master has
--    never heard of is a typo or a missing master row, and inventing the drug
--    here would put a product on the shelf with no salt, no schedule and no
--    pack configuration — which is how a Schedule H1 medicine ends up sellable
--    over the counter. Load the master first; that is why it is step one.
--
-- 2. **A batch already on the shelf is refused, by name.** `receive_goods`
--    ADDS to an existing batch, which is right for a real delivery and
--    catastrophic here: run the opening file twice and the shelf doubles,
--    silently, and the first person to notice is doing a stock-take three
--    months later. Opening stock is by definition stock the system does not
--    have yet.
--
-- 3. **The file says what its numbers mean.** A quantity is in strips, boxes
--    or loose units, and so is a cost, and the two can differ — a distributor
--    quotes a rate per strip and counts in boxes. Getting that wrong is a 10×
--    or 150× error in either the shelf or its valuation, so it is declared per
--    row and defaults to `strip`, which is how an Indian pharmacy invoice
--    reads.
--
-- What the dry run shows is chosen for one purpose: **the total at cost.** A
-- doctor who knows his shelf is worth about four lakh will spot a misdeclared
-- cost basis instantly at forty lakh, and no per-row check catches that as
-- fast as one number he already knows.

-- ---------------------------------------------------------------------------
-- Expiries as they are actually written.
--
-- The date on a strip is a month, and the person typing it will write it four
-- different ways in the same file: 03/2027, 3-27, 2027-03, 2027-03-31. All
-- four mean the same thing and all four are accepted; anything else is
-- reported rather than guessed at, because guessing a date wrong puts expired
-- stock on the shelf or throws good stock away.
-- ---------------------------------------------------------------------------
create or replace function app.parse_expiry(p_text text) returns date
language plpgsql
immutable
as $$
declare
  v text := trim(coalesce(p_text, ''));
  v_month int;
  v_year  int;
begin
  if v = '' then return null; end if;

  if v ~ '^\d{4}-\d{2}-\d{2}$' then
    return v::date;
  end if;

  if v ~ '^\d{4}[-/]\d{1,2}$' then
    v_year  := split_part(replace(v, '/', '-'), '-', 1)::int;
    v_month := split_part(replace(v, '/', '-'), '-', 2)::int;
  elsif v ~ '^\d{1,2}[-/]\d{4}$' then
    v_month := split_part(replace(v, '/', '-'), '-', 1)::int;
    v_year  := split_part(replace(v, '/', '-'), '-', 2)::int;
  elsif v ~ '^\d{1,2}[-/]\d{2}$' then
    -- "03/27" — the commonest way it is written, and a strip printed in the
    -- 1900s is not a thing this clinic will ever receive.
    v_month := split_part(replace(v, '/', '-'), '-', 1)::int;
    v_year  := 2000 + split_part(replace(v, '/', '-'), '-', 2)::int;
  else
    return null;
  end if;

  if v_month < 1 or v_month > 12 then return null; end if;
  return make_date(v_year, v_month, 1);
exception when others then
  return null;
end
$$;

revoke all on function app.parse_expiry(text) from public;
grant execute on function app.parse_expiry(text) to authenticated, service_role;

comment on function app.parse_expiry(text) is
  'The four ways a person writes the month printed on a strip. Anything else returns null and is reported rather than guessed at.';

-- ---------------------------------------------------------------------------
-- app.import_opening_stock
-- ---------------------------------------------------------------------------
create or replace function app.import_opening_stock(
  p_rows    jsonb,
  p_dry_run boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id     uuid;
  v_row          jsonb;
  v_index        int := 0;
  v_errors       jsonb := '[]'::jsonb;
  v_prepared     jsonb := '[]'::jsonb;
  v_seen         text[] := '{}';
  v_drug         drugs%rowtype;
  v_supplier_id  uuid;
  v_name         text;
  v_strength     text;
  v_batch_no     text;
  v_expiry       date;
  v_qty          numeric;
  v_qty_basis    text;
  v_cost         numeric;
  v_cost_basis   text;
  v_mrp          numeric;
  v_mrp_basis    text;
  v_ups          int;
  v_spb          int;
  v_key          text;
  v_units        int;
  v_cost_base    numeric;
  v_total_units  bigint := 0;
  v_total_value  numeric := 0;
  v_group        jsonb;
  v_group_sup    text;
  v_group_inv    text;
  v_invoice_date date;
  v_batches      int := 0;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  -- Opening stock is the shelf's whole value. It is not a counter errand.
  if app.current_staff_role() not in ('doctor', 'admin') then
    raise exception 'opening stock is loaded by the doctor or an admin'
      using errcode = 'CL005';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'there is nothing in that file' using errcode = 'CL006';
  end if;

  -- ------------------------------------------------------------------------
  -- Pass one: read every row, complain about all of them, write nothing.
  -- ------------------------------------------------------------------------
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_index := v_index + 1;
    v_name     := nullif(trim(coalesce(v_row ->> 'name', '')), '');
    v_strength := nullif(trim(coalesce(v_row ->> 'strength', '')), '');
    v_batch_no := nullif(trim(coalesce(v_row ->> 'batch_no', '')), '');

    if v_name is null then
      v_errors := v_errors || jsonb_build_object('row', v_index, 'message', 'no drug name');
      continue;
    end if;

    -- Rule 1. The master is step one for a reason.
    if v_strength is null then
      select * into v_drug from drugs where lower(name) = lower(v_name);
    else
      select * into v_drug from drugs
      where lower(name) = lower(v_name) and lower(strength) = lower(v_strength);
    end if;

    if not found then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_name,
        'message', format('no drug called "%s%s" in the master — load the drug master first',
                          v_name, coalesce(' ' || v_strength, '')));
      continue;
    end if;

    if v_batch_no is null then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', 'no batch number — expiry, returns and any recall are all kept by batch');
      continue;
    end if;

    v_expiry := app.parse_expiry(v_row ->> 'expiry');
    if v_expiry is null then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('cannot read the expiry "%s" — write it as 03/2027',
                          coalesce(v_row ->> 'expiry', '')));
      continue;
    end if;

    if app.month_end(v_expiry) < current_date then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('batch %s expired %s — expired stock is written off, not loaded',
                          v_batch_no, to_char(v_expiry, 'Mon YYYY')));
      continue;
    end if;

    -- Rule 2. The one that stops the shelf doubling.
    v_key := v_drug.id::text || '|' || lower(v_batch_no);

    if exists (select 1 from stock_batches
               where drug_id = v_drug.id and lower(batch_no) = lower(v_batch_no)) then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('batch %s of %s is already on the shelf — opening stock is loaded once',
                          v_batch_no, v_drug.name));
      continue;
    end if;

    if v_key = any (v_seen) then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('batch %s of %s appears twice in this file',
                          v_batch_no, v_drug.name));
      continue;
    end if;

    -- Rule 3. What the numbers mean.
    v_qty_basis  := lower(coalesce(nullif(trim(coalesce(v_row ->> 'qty_basis', '')), ''), 'strip'));
    v_cost_basis := lower(coalesce(nullif(trim(coalesce(v_row ->> 'cost_basis', '')), ''), 'strip'));
    v_mrp_basis  := lower(coalesce(nullif(trim(coalesce(v_row ->> 'mrp_basis', '')), ''),
                                   v_drug.default_mrp_basis::text, 'strip'));

    if v_qty_basis not in ('unit', 'strip', 'box')
       or v_cost_basis not in ('unit', 'strip', 'box')
       or v_mrp_basis not in ('unit', 'strip', 'box') then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', 'quantity, cost and MRP are each counted in units, strips or boxes');
      continue;
    end if;

    v_ups := coalesce((v_row ->> 'units_per_strip')::int, v_drug.default_units_per_strip, 1);
    v_spb := coalesce((v_row ->> 'strips_per_box')::int, v_drug.default_strips_per_box, 1);

    if v_ups <= 0 or v_spb <= 0 then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name, 'message', 'pack sizes have to be positive');
      continue;
    end if;

    v_qty  := (v_row ->> 'qty')::numeric;
    v_cost := (v_row ->> 'cost')::numeric;
    v_mrp  := (v_row ->> 'mrp')::numeric;

    if v_qty is null or v_qty <= 0 then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('batch %s has no quantity', v_batch_no));
      continue;
    end if;

    if v_qty <> trunc(v_qty) then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('%s %ss of batch %s — count in whole packs, or say the quantity is in units',
                          v_qty, v_qty_basis, v_batch_no));
      continue;
    end if;

    -- Valuation depends on it (INVENTORY.md §4), and so does every margin
    -- number the reorder screen shows.
    if v_cost is null or v_cost <= 0 then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('batch %s has no cost — the shelf cannot be valued without it',
                          v_batch_no));
      continue;
    end if;

    -- A batch with no MRP cannot be sold: the counter has no price to charge.
    if v_mrp is null or v_mrp <= 0 then
      v_errors := v_errors || jsonb_build_object(
        'row', v_index, 'name', v_drug.name,
        'message', format('batch %s has no MRP — the counter would have no price to charge',
                          v_batch_no));
      continue;
    end if;

    -- Who it came from. Named in the file if the doctor knows, otherwise the
    -- drug's usual supplier — and it matters beyond bookkeeping: an expiry
    -- return goes back to whoever supplied the batch (INVENTORY.md §6), so a
    -- batch with no supplier is a batch that can only ever be written off.
    v_supplier_id := null;
    if nullif(trim(coalesce(v_row ->> 'supplier', '')), '') is not null then
      select id into v_supplier_id from suppliers
      where lower(name) = lower(trim(v_row ->> 'supplier'));

      if v_supplier_id is null then
        v_errors := v_errors || jsonb_build_object(
          'row', v_index, 'name', v_drug.name,
          'message', format('no supplier called "%s" — add them, or leave the column empty',
                            trim(v_row ->> 'supplier')));
        continue;
      end if;
    else
      v_supplier_id := v_drug.default_supplier_id;
    end if;

    v_seen := v_seen || v_key;

    -- Base units, once, here. `receive_goods` multiplies packs by the pack
    -- size, so a quantity given in loose units is passed as units with a pack
    -- basis of one.
    v_units := (v_qty * app.units_in_pack(v_ups, v_spb, v_qty_basis))::int;
    v_cost_base := round(v_cost / app.units_in_pack(v_ups, v_spb, v_cost_basis), 4);

    v_total_units := v_total_units + v_units;
    v_total_value := v_total_value + round(v_cost_base * v_units, 2);
    v_batches := v_batches + 1;

    v_prepared := v_prepared || jsonb_build_object(
      'drug_id',            v_drug.id,
      'batch_no',           v_batch_no,
      'expiry',             v_expiry,
      'units_per_strip',    v_ups,
      'strips_per_box',     v_spb,
      'mrp',                v_mrp,
      'mrp_basis',          v_mrp_basis,
      'pack_basis',         v_qty_basis,
      'qty_packs',          v_qty::int,
      'cost_per_base_unit', v_cost_base,
      '_supplier_id',       v_supplier_id,
      '_invoice_no',        nullif(trim(coalesce(v_row ->> 'invoice_no', '')), ''),
      '_invoice_date',      app.parse_expiry(v_row ->> 'invoice_date'));
  end loop;

  if jsonb_array_length(v_errors) > 0 then
    if p_dry_run then
      return jsonb_build_object(
        'dry_run', true, 'batches', 0, 'units', 0, 'value', 0,
        'errors', v_errors);
    end if;

    raise exception '% of % rows cannot be loaded — nothing was written',
      jsonb_array_length(v_errors), jsonb_array_length(p_rows)
      using errcode = 'CL025';
  end if;

  if p_dry_run then
    return jsonb_build_object(
      'dry_run', true, 'batches', v_batches, 'units', v_total_units,
      'value', v_total_value, 'errors', '[]'::jsonb);
  end if;

  -- ------------------------------------------------------------------------
  -- Pass two: one goods receipt per supplier, per invoice.
  --
  -- Per supplier because `stock_batches.supplier_id` comes from the receipt,
  -- and a batch that does not know who supplied it cannot be returned to them.
  -- Per invoice because that is what the purchase register is a register OF.
  -- Rows with no invoice number produce a receipt marked as awaiting one,
  -- which is the honest reading: the clinic has no invoice on file for stock
  -- that was already on the shelf when the system arrived.
  -- ------------------------------------------------------------------------
  for v_group_sup, v_group_inv in
    select distinct l ->> '_supplier_id', l ->> '_invoice_no'
    from jsonb_array_elements(v_prepared) l
  loop
    select jsonb_agg(l - '_supplier_id' - '_invoice_no' - '_invoice_date'),
           max((l ->> '_invoice_date')::date)
      into v_group, v_invoice_date
    from jsonb_array_elements(v_prepared) l
    where (l ->> '_supplier_id') is not distinct from v_group_sup
      and (l ->> '_invoice_no')  is not distinct from v_group_inv;

    perform app.receive_goods(
      v_group,
      v_group_sup::uuid,
      v_group_inv,
      v_invoice_date,
      v_group_inv is null,
      'Opening stock at go-live');
  end loop;

  perform app.write_audit('import_opening_stock', 'stock_batches', null, null,
    jsonb_build_object('batches', v_batches, 'units', v_total_units,
                       'value', v_total_value, 'rows', jsonb_array_length(p_rows)));

  return jsonb_build_object(
    'dry_run', false, 'batches', v_batches, 'units', v_total_units,
    'value', v_total_value, 'errors', '[]'::jsonb);
end
$$;

revoke all on function app.import_opening_stock(jsonb, boolean) from public;
grant execute on function app.import_opening_stock(jsonb, boolean)
  to authenticated, service_role;

comment on function app.import_opening_stock(jsonb, boolean) is
  'Opening stock through app.receive_goods, never around it. Refuses a batch already on the shelf, because receive_goods adds and a doubled opening balance is found three months later at a stock-take.';
