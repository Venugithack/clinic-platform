-- Change notification, in standard Postgres.
--
-- The doctor↔counter link is a subscription, not a poll (PLAN.md §5.1). In
-- production that subscription is Supabase Realtime, which reads logical
-- replication and needs no triggers at all — the publication membership at the
-- bottom of this file is the whole setup.
--
-- These NOTIFY triggers exist for the other half of HOSTING.md §7: "Realtime
-- behind one adapter — swap for a WS server without touching a screen." That
-- promise is worth exactly as much as the fallback that has been built, so the
-- fallback is built: LISTEN/NOTIFY is plain Postgres, works on any host, and is
-- what lib/realtime's websocket adapter consumes. It is also what makes the
-- link testable locally without running the whole Supabase stack.
--
-- The payload is deliberately just the table, the operation and the id.
-- pg_notify caps at 8000 bytes, but the real reason is RLS: a payload carrying
-- row data would hand the client fields its policies might not allow. The
-- client is told THAT something changed and re-reads it through lib/db, which
-- is the only path with policies on it.

create or replace function app.notify_change() returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_id uuid;
begin
  v_id := case tg_op when 'DELETE' then old.id else new.id end;

  perform pg_notify(
    'clinic_changes',
    json_build_object('table', tg_table_name, 'op', tg_op, 'id', v_id)::text
  );

  return null;
end
$$;

create trigger prescriptions_notify
  after insert or update or delete on prescriptions
  for each row execute function app.notify_change();

create trigger counter_queries_notify
  after insert or update or delete on counter_queries
  for each row execute function app.notify_change();

create trigger appointments_notify
  after insert or update or delete on appointments
  for each row execute function app.notify_change();

-- ---------------------------------------------------------------------------
-- Supabase Realtime membership.
--
-- The publication exists only on a Supabase project, so this is a no-op on a
-- bare Postgres — which is the same shape as the auth shim in the first
-- migration, and for the same reason: one set of migrations, both targets.
--
-- REPLICA IDENTITY FULL is what lets a subscriber filter on columns other than
-- the primary key. It costs WAL volume, so it goes only on the three tables the
-- screens actually subscribe to.
-- ---------------------------------------------------------------------------
alter table prescriptions   replica identity full;
alter table counter_queries replica identity full;
alter table appointments    replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table prescriptions';
    execute 'alter publication supabase_realtime add table counter_queries';
    execute 'alter publication supabase_realtime add table appointments';
  end if;
exception
  when duplicate_object then null;
end $$;

comment on function app.notify_change() is
  'Announces table/op/id only. The client re-reads through lib/db so RLS still shapes what it sees.';
