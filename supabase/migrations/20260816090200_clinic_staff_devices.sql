-- Clinic, staff and registered devices.
--
-- Single-tenant: PLAN.md §18 Q15 was answered "one-off" on 16 Aug 2026, so
-- there is no clinic_id on any table. The `clinic` table holds exactly one row,
-- and a check constraint keeps it that way.
--
-- RLS is enabled on every table in the same migration that creates it
-- (BUILD.md §1.4). Retrofitted RLS is how a table ends up readable.

create table clinic (
  id                uuid primary key default gen_random_uuid(),
  singleton         boolean not null default true,
  name              text not null,
  address           text,
  phone             text,
  doctor_reg_no     text,
  drug_licence_no   text,
  gstin             text,
  -- Hours, weekly off and holidays are settings, not constants: the doctor
  -- configures them once the platform is ready (PLAN.md §18 Q10).
  open_hours        jsonb not null default '{}'::jsonb,
  timezone          text not null default 'Asia/Kolkata',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint clinic_is_a_singleton unique (singleton),
  constraint clinic_singleton_is_true check (singleton)
);

create type staff_role as enum ('doctor', 'counter', 'admin');

create table staff (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  role          staff_role not null,
  reg_no        text,
  phone         text,
  auth_user_id  uuid unique,
  -- 6-digit PIN over a registered device session (TABLET.md §5). Stored as a
  -- pgcrypto bcrypt digest; the PIN itself never reaches the database.
  pin_hash      text,
  pin_set_at    timestamptz,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index staff_active_idx on staff (active) where active;

-- The device holds the session; the PIN holds the identity (TABLET.md §5).
create table devices (
  id                uuid primary key default gen_random_uuid(),
  label             text not null,
  device_token      text not null unique,
  is_clinic_device  boolean not null default true,
  -- The admin who registered it. Not the person using it — attribution comes
  -- from the PIN, which is the whole point of the split.
  registered_by     uuid references staff (id),
  registered_at     timestamptz not null default now(),
  last_seen_at      timestamptz,
  -- Idle lock: 3 minutes on the counter, 10 in the cabin (TABLET.md §5). It is
  -- a property of where the tablet stands, so it is set once at registration.
  idle_timeout_seconds int not null default 180 check (idle_timeout_seconds between 30 and 3600),
  -- Lost tablet: revoked from the admin screen. A PIN alone is useless on any
  -- other device.
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index devices_live_idx on devices (revoked_at) where revoked_at is null;

create trigger clinic_touch  before update on clinic  for each row execute function app.touch_updated_at();
create trigger staff_touch   before update on staff   for each row execute function app.touch_updated_at();
create trigger devices_touch before update on devices for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Who is acting. Every write carries the staff id from the PIN, because the
-- H1 register needs a person's name, not a tablet's (BUILD.md §1.6).
-- ---------------------------------------------------------------------------
create or replace function app.current_staff_id() returns uuid
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select s.id
  from staff s
  where s.auth_user_id = auth.uid()
    and s.active
$$;

create or replace function app.current_staff_role() returns staff_role
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select s.role
  from staff s
  where s.auth_user_id = auth.uid()
    and s.active
$$;

grant execute on function app.current_staff_id(), app.current_staff_role()
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS. Note what is absent: no policy grants `anon` anything at all. Patient
-- surfaces default-deny (PLAN.md §5.3 rule 7) — the public routes read only
-- what a later migration explicitly exposes to them, and nothing here is it.
-- ---------------------------------------------------------------------------
alter table clinic  enable row level security;
alter table staff   enable row level security;
alter table devices enable row level security;

grant select on clinic, staff, devices to authenticated;

create policy clinic_read on clinic
  for select to authenticated
  using (app.current_staff_id() is not null);

create policy staff_read on staff
  for select to authenticated
  using (app.current_staff_id() is not null);

create policy devices_read on devices
  for select to authenticated
  using (app.current_staff_id() is not null);

-- Staff and device administration is an admin-only write.
--
-- The PIN hash is never client-writable, and the way to say that in Postgres is
-- to grant the writable columns rather than the table: a column-level REVOKE
-- against a table-level grant is silently a no-op, so `grant update on staff`
-- followed by `revoke update (pin_hash)` would leave the hash wide open. The
-- only path to pin_hash is app.set_staff_pin() (0700).
grant insert (name, role, reg_no, phone, auth_user_id, active) on staff to authenticated;
grant update (name, role, reg_no, phone, auth_user_id, active) on staff to authenticated;
grant insert, update on devices to authenticated;

create policy staff_admin_write on staff
  for insert to authenticated
  with check (app.current_staff_role() = 'admin');

create policy staff_admin_update on staff
  for update to authenticated
  using (app.current_staff_role() = 'admin')
  with check (app.current_staff_role() = 'admin');

create policy devices_admin_write on devices
  for insert to authenticated
  with check (app.current_staff_role() = 'admin');

create policy devices_admin_update on devices
  for update to authenticated
  using (app.current_staff_role() = 'admin')
  with check (app.current_staff_role() = 'admin');

comment on table clinic is 'Exactly one row. Single-tenant by PLAN.md §18 Q15, answered 16 Aug 2026.';
comment on column staff.pin_hash is 'bcrypt digest of the 6-digit PIN. Written only by app.set_staff_pin().';
comment on table devices is 'TABLET.md §5: the device holds the session, the PIN holds the identity.';
