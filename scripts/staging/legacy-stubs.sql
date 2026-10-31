-- Staging only. The retired application, reduced to the objects the current
-- migrations name.
--
-- ── WHY THIS FILE HAS TO EXIST ─────────────────────────────────────────────
--
-- The clinic's database is shared with the application this one replaced. That
-- application's 74 tables and 33 views live in `public`, its helper functions
-- live in `app`, and the last migration in supabase/migrations/ reaches out and
-- touches them: it flips security_invoker on every one of those views and
-- revokes anon's execute on five app functions, including two `unlock_pin`
-- overloads that were a public PIN-verification surface.
--
-- That migration is correct against production and cannot run against anything
-- else. On an empty database it dies on its first statement — `relation
-- "public.available_stock" does not exist` — which means the migration set as
-- committed CANNOT BUILD A FRESH CLINIC. Everything up to it applies; the
-- hardening does not. A staging database built by skipping it would be a
-- staging database with no RLS, no revoked grants and none of the foreign-key
-- indexes, which is a worse lie than having no staging at all.
--
-- So staging gets stubs. They are empty views over `select` constants and
-- functions that return nothing, which is enough for `alter view` and `revoke`
-- to have something to act on. They exist for one reason: so the REAL hardening
-- migration runs here exactly as it ran in production, and staging ends up with
-- the same posture the clinic has.
--
-- This file is never applied to production. Production already has the real
-- ones, and they have data in them.

create schema if not exists app;

-- The three Supabase roles the hardening migration revokes from. A plain
-- Postgres container has none of them.
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
end
$$;

-- The retired application's views, by the exact names the hardening migration
-- iterates over. Shape is irrelevant — `alter view ... set (security_invoker)`
-- does not care what the view selects.
do $$
declare
  view_name text;
begin
  foreach view_name in array array[
    'available_stock', 'batch_trace', 'clinic_health', 'clinic_now',
    'clinic_screens', 'clinic_setup_state', 'consumption_velocity', 'day_book',
    'dispense_margin', 'drug_availability', 'drugs_frequently_prescribed',
    'email_access_state', 'expired_stock', 'expiring_soon',
    'expiry_writeoff_register', 'h1_register', 'lock_screen_staff',
    'open_counter_queries', 'open_supplier_credits', 'pharmacy_queue',
    'presence_detail', 'purchase_order_lines', 'purchase_orders_open',
    'purchase_register', 'queue_today', 'reorder_suggestions', 'sales_register',
    'stock_cache_drift', 'stock_take_variance', 'stock_valuation',
    'stockout_history', 'supplier_lead_time', 'supplier_price_history',
    'till_reconciliation'
  ]
  loop
    execute format(
      'create or replace view public.%I as select null::text as retired_stub where false',
      view_name
    );
  end loop;
end
$$;

-- The five `app` functions the hardening migration revokes anon's execute on,
-- with the exact signatures it names. `revoke` matches on the argument types,
-- so these have to agree or the revoke fails to find them.
create or replace function app.clinic_is_open(at timestamp with time zone)
  returns boolean language sql immutable as $$ select false $$;

create or replace function app.current_staff_id()
  returns uuid language sql stable as $$ select null::uuid $$;

create or replace function app.current_staff_role()
  returns text language sql stable as $$ select null::text $$;

create or replace function app.unlock_pin(staff uuid, pin text)
  returns boolean language sql volatile as $$ select false $$;

create or replace function app.unlock_pin(staff uuid, pin text, device text)
  returns boolean language sql volatile as $$ select false $$;

-- The migration revokes from anon; anon has to have been granted something for
-- that to be a meaningful rehearsal rather than a no-op.
grant execute on function app.clinic_is_open(timestamp with time zone) to anon;
grant execute on function app.current_staff_id() to anon;
grant execute on function app.current_staff_role() to anon;
grant execute on function app.unlock_pin(uuid, text) to anon;
grant execute on function app.unlock_pin(uuid, text, text) to anon;
