-- Extensions, roles, and the `app` helper schema.
--
-- Everything here is standard Postgres (HOSTING.md §7): no Supabase-proprietary
-- SQL, so a pg_dump restores onto a plain Postgres 16 anywhere. The Supabase
-- objects we depend on (the `auth` schema, the anon/authenticated/service_role
-- roles) are created only when absent, so this migration is a no-op against a
-- real Supabase project and a full setup against a bare cluster.

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- Roles. Supabase ships these; a bare cluster does not.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- auth.uid() shim. Supabase provides it; locally we read the same JWT claim
-- setting that PostgREST sets, so RLS policies are identical in both places.
-- ---------------------------------------------------------------------------
create schema if not exists auth;

do $$
begin
  if to_regprocedure('auth.uid()') is null then
    execute $fn$
      create function auth.uid() returns uuid
      language sql
      stable
      as $body$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $body$
    $fn$;
  end if;
end $$;

grant usage on schema auth to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The `app` schema: helpers and, from 0600 onward, the state transitions.
-- ---------------------------------------------------------------------------
create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

-- Nothing is creatable in public by ordinary roles.
revoke create on schema public from public;
grant usage on schema public to anon, authenticated, service_role;

-- updated_at maintenance, attached to every table that has the column.
create or replace function app.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Refuses UPDATE and DELETE. Attached to the append-only tables: the stock
-- ledger and the audit log. PLAN.md §5.3 rule 3, INVENTORY.md §3 —
-- "an edit is a story nobody can reconstruct". Corrections are compensating
-- rows, never edits.
create or replace function app.refuse_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception
    '% is append-only: use a compensating row, not an %',
    tg_table_name, tg_op
    using errcode = 'restrict_violation';
end
$$;

-- The changed fields between two row snapshots, and nothing else.
--
-- HOSTING.md §4: audit rows store the changed fields only, never a full row
-- snapshot. Snapshotting every write triples the audit_log size estimate and
-- puts the 500 MB free-tier ceiling inside 18 months. This function is how that
-- rule is kept — audit callers pass whole rows and get back only the delta.
create or replace function app.changed_fields(p_before jsonb, p_after jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(
    jsonb_object_agg(key, value),
    '{}'::jsonb
  )
  from jsonb_each(coalesce(p_after, '{}'::jsonb))
  where value is distinct from coalesce(p_before, '{}'::jsonb) -> key
$$;

-- Base units contained in one sellable pack, given a batch's pack config.
-- INVENTORY.md §1: pack configuration lives on the batch, never on the drug.
create or replace function app.units_in_pack(
  p_units_per_strip int,
  p_strips_per_box int,
  p_basis text
) returns int
language sql
immutable
as $$
  select case p_basis
    when 'unit'  then 1
    when 'strip' then p_units_per_strip
    when 'box'   then p_units_per_strip * p_strips_per_box
  end
$$;

-- The last day of the month a strip is printed with. Expiries are printed as
-- "Mar 2027" and the stock is usable through the end of that month.
create or replace function app.month_end(p_date date)
returns date
language sql
immutable
as $$
  select (date_trunc('month', p_date) + interval '1 month - 1 day')::date
$$;
