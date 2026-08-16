-- Barcodes. INVENTORY.md §2.
--
-- Both screens are tablets, tablets have cameras, and every Indian pharmacy
-- strip carries a barcode. This is free accuracy — no scanner hardware, no
-- drivers, no cost — and it is the single highest-value addition after the
-- base-unit model.
--
-- Where it earns its place:
--
--   goods receipt   removes typing drug names off an invoice, the slowest and
--                   most error-prone screen in the build
--   dispense        catches the wrong-drug-off-the-shelf error before the
--                   patient is holding it. This is the safety feature worth
--                   naming to the doctor
--   counter sale    scan-scan-scan-total, which is what a customer expects a
--                   shop to look like
--   stock-take      scan and count instead of hunting a printed list
--
-- Codes map many-to-one onto drugs: several pack sizes of the same brand carry
-- different codes, and the same code never means two different drugs. The first
-- scan of an unknown code asks "which drug is this?" once, and remembers.

create table drug_barcodes (
  id            uuid primary key default gen_random_uuid(),
  code          text not null,
  drug_id       uuid not null references drugs (id),
  -- Set only when the code is specific to one batch. Most are not.
  batch_id      uuid references stock_batches (id),
  learned_by    uuid not null references staff (id),
  learned_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One meaning per code. A code that resolves to two drugs is worse than no
  -- code at all, because the scan looks like it worked.
  unique (code)
);

create index drug_barcodes_drug_idx on drug_barcodes (drug_id);

create trigger drug_barcodes_touch before update on drug_barcodes
  for each row execute function app.touch_updated_at();

alter table drug_barcodes enable row level security;

grant select on drug_barcodes to authenticated;
revoke insert, update, delete on drug_barcodes from authenticated, anon;

create policy drug_barcodes_read on drug_barcodes
  for select to authenticated using (app.current_staff_id() is not null);

-- ---------------------------------------------------------------------------
-- app.learn_barcode — "which drug is this?", answered once.
-- ---------------------------------------------------------------------------
create or replace function app.learn_barcode(
  p_code    text,
  p_drug_id uuid,
  p_batch_id uuid default null
) returns drug_barcodes
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_staff_id uuid;
  v_existing drug_barcodes;
  v_row      drug_barcodes;
  v_drug     drugs%rowtype;
begin
  v_staff_id := app.current_staff_id();
  if v_staff_id is null then
    raise exception 'no active staff member is signed in on this device'
      using errcode = 'CL005';
  end if;

  if p_code is null or length(trim(p_code)) < 6 then
    raise exception 'that does not look like a barcode' using errcode = 'CL006';
  end if;

  select * into v_drug from drugs where id = p_drug_id;
  if not found then
    raise exception 'unknown drug %', p_drug_id using errcode = 'CL006';
  end if;

  select * into v_existing from drug_barcodes where code = trim(p_code);

  if found then
    -- Re-teaching a code is how one strip's code silently becomes another
    -- drug's, and the scan that follows looks like it worked. Refused; an
    -- admin can correct the row deliberately.
    if v_existing.drug_id <> p_drug_id then
      raise exception 'that barcode is already registered to "%"',
        (select name from drugs where id = v_existing.drug_id)
        using errcode = 'CL013';
    end if;
    return v_existing;
  end if;

  insert into drug_barcodes (code, drug_id, batch_id, learned_by)
  values (trim(p_code), p_drug_id, p_batch_id, v_staff_id)
  returning * into v_row;

  perform app.write_audit(
    'learn_barcode', 'drug_barcodes', v_row.id, null,
    jsonb_build_object('code', trim(p_code), 'drug_id', p_drug_id)
  );

  return v_row;
end
$$;

revoke all on function app.learn_barcode(text, uuid, uuid) from public;
grant execute on function app.learn_barcode(text, uuid, uuid) to authenticated, service_role;

comment on table drug_barcodes is
  'One meaning per code. Scan-to-verify at dispense is what this exists for (INVENTORY.md §2).';
