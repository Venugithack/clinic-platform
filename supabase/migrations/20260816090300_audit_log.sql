-- The audit log.
--
-- PLAN.md §5.3 rule 2: every state change writes its audit row inside the same
-- transaction as the change. That is only true because the row is written
-- inside the plpgsql transition, not by a caller who remembers to.
--
-- HOSTING.md §4: audit rows store the changed fields only, never a full row
-- snapshot. audit_log is the table that decides whether the 500 MB free tier
-- holds for two years — 240,000 rows at ~96 MB with this rule, roughly triple
-- that without it.

create table audit_log (
  id              uuid primary key default gen_random_uuid(),
  -- Null only for actor_type = 'system'. A staff action always names a person.
  actor_staff_id  uuid references staff (id),
  actor_type      text not null default 'staff'
                  check (actor_type in ('staff', 'system', 'patient')),
  action          text not null,
  entity          text not null,
  entity_id       uuid,
  -- Changed fields only. Populated via app.changed_fields(); see the comment
  -- above and the pgTAP assertion in supabase/tests/audit_log.sql.
  before          jsonb,
  after           jsonb,
  at              timestamptz not null default now(),
  ip              inet
);

create index audit_log_entity_idx on audit_log (entity, entity_id, at desc);
create index audit_log_actor_idx  on audit_log (actor_staff_id, at desc);
create index audit_log_at_idx     on audit_log (at desc);

-- Append-only. An audit log you can edit is not an audit log.
create trigger audit_log_is_append_only
  before update or delete on audit_log
  for each row execute function app.refuse_mutation();

-- ---------------------------------------------------------------------------
-- The only writer. SECURITY DEFINER so transitions can call it while the
-- calling role holds no INSERT grant on audit_log at all.
-- ---------------------------------------------------------------------------
create or replace function app.write_audit(
  p_action    text,
  p_entity    text,
  p_entity_id uuid,
  p_before    jsonb default null,
  p_after     jsonb default null,
  p_actor_type text default 'staff'
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_id uuid;
  v_changed jsonb;
begin
  -- Only the fields that actually differ are stored, on both sides.
  v_changed := app.changed_fields(p_before, p_after);

  insert into audit_log (actor_staff_id, actor_type, action, entity, entity_id, before, after)
  values (
    case when p_actor_type = 'staff' then app.current_staff_id() end,
    p_actor_type,
    p_action,
    p_entity,
    p_entity_id,
    case
      when p_before is null then null
      else (select coalesce(jsonb_object_agg(key, p_before -> key), '{}'::jsonb)
            from jsonb_object_keys(v_changed) as key)
    end,
    case when p_after is null then null else v_changed end
  )
  returning id into v_id;

  return v_id;
end
$$;

revoke all on function app.write_audit(text, text, uuid, jsonb, jsonb, text) from public;

alter table audit_log enable row level security;

-- Readable by staff, writable by nobody through the API. The only INSERT path
-- is app.write_audit() running as definer inside a transition.
grant select on audit_log to authenticated;

create policy audit_log_read on audit_log
  for select to authenticated
  using (app.current_staff_id() is not null);

comment on table audit_log is
  'Append-only. Written only by app.write_audit() from inside a transition, in the same transaction as the change it records.';
comment on column audit_log.after is
  'Changed fields only, never a full row snapshot (HOSTING.md §4).';
