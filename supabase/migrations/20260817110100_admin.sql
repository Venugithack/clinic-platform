-- Staff and devices, from a screen. PLAN.md §16, TABLET.md §5.
--
-- `app.set_staff_pin` and an admin-only device policy have existed since M0
-- with nothing in front of them. So "the new pharmacist starts on Monday" and
-- "the counter tablet was left in an auto-rickshaw" were both, in this build,
-- a developer with `psql`.
--
-- Two of the rules below are the whole point of the migration.
--
-- **The last admin cannot be demoted or switched off.** A single-doctor clinic
-- has one or two admins. Deactivate the last one and nobody can ever register
-- a tablet, add staff or reset a PIN again — the system needs a developer to
-- get back in, which is precisely what M11 exists to remove.
--
-- **Revoking a device kills its live sessions in the same transaction.**
-- `revoked_at` alone stops the NEXT unlock; it does nothing about the tablet
-- that is currently unlocked and in somebody else's bag. The lost-tablet story
-- is only true if the session dies with the registration.
--
-- Devices also stop being directly writable here. They were the one blessed
-- exception in the M9 permissions review (`A5_permissions.sql` §1), and that
-- was fair while registration was a plain INSERT — but a device token that the
-- browser makes up is a device token as good as the browser's random source,
-- and revocation now has to do two things atomically. Both are arguments for a
-- transition, so `devices` joins everything else behind one.
--
-- Nothing here deletes a staff member. Every prescription, dispense, bill and
-- H1 register line names one, and those names are the legal record of who did
-- it. `active = false` is how somebody leaves.
--
-- Error code added here:
--   CL027  this change would lock the clinic out of its own system

-- ---------------------------------------------------------------------------
-- app.add_staff
--
-- The PIN is required, not optional. A staff member without one appears on the
-- lock screen and cannot unlock it, which reads as a broken tablet rather than
-- as an incomplete setup.
-- ---------------------------------------------------------------------------
create or replace function app.add_staff(
  p_name   text,
  p_role   staff_role,
  p_pin    text,
  p_phone  text default null,
  p_reg_no text default null
) returns staff
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_first boolean;
  v_staff staff;
begin
  -- The bootstrap. An empty staff table is day one of go-live, and somebody
  -- has to be able to make the first admin without psql. The window closes the
  -- instant this row exists and can never reopen — a database with staff in it
  -- takes this path exactly once, ever.
  v_first := not exists (select 1 from staff);

  if not v_first then
    if app.current_staff_role() is distinct from 'admin' then
      raise exception 'staff are added by an administrator' using errcode = 'CL005';
    end if;
  end if;

  if nullif(trim(coalesce(p_name, '')), '') is null then
    raise exception 'a staff member needs a name — it goes on every prescription they touch'
      using errcode = 'CL006';
  end if;

  if p_pin !~ '^[0-9]{6}$' then
    raise exception 'a staff PIN is exactly 6 digits' using errcode = 'CL006';
  end if;

  insert into staff (name, role, phone, reg_no, pin_hash, pin_set_at)
  values (
    trim(p_name),
    -- The first person through the door is an admin whatever the form said,
    -- because anything else is a database nobody can administer.
    case when v_first then 'admin'::staff_role else p_role end,
    nullif(trim(coalesce(p_phone, '')), ''),
    nullif(trim(coalesce(p_reg_no, '')), ''),
    crypt(p_pin, gen_salt('bf', 12)),
    now())
  returning * into v_staff;

  -- The PIN itself never reaches the audit log, and neither does its digest.
  perform app.write_audit('add_staff', 'staff', v_staff.id, null,
    jsonb_build_object('name', v_staff.name, 'role', v_staff.role,
                       'bootstrap', v_first),
    case when v_first then 'system' else 'staff' end);

  return v_staff;
end
$$;

-- ---------------------------------------------------------------------------
-- app.update_staff — rename, re-role, deactivate, reactivate.
-- ---------------------------------------------------------------------------
create or replace function app.update_staff(
  p_staff_id uuid,
  p_name     text default null,
  p_role     staff_role default null,
  p_phone    text default null,
  p_reg_no   text default null,
  p_active   boolean default null
) returns staff
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_before jsonb;
  v_staff  staff;
  v_admins int;
begin
  if app.current_staff_role() is distinct from 'admin' then
    raise exception 'staff are changed by an administrator' using errcode = 'CL005';
  end if;

  select * into v_staff from staff where id = p_staff_id;
  if not found then
    raise exception 'no such staff member' using errcode = 'CL006';
  end if;
  v_before := to_jsonb(v_staff);

  -- The lock-out guard. Counted over the state this change would LEAVE, not
  -- the state it started from, so demoting and deactivating are both caught by
  -- the same arithmetic.
  if v_staff.role = 'admin' and v_staff.active
     and (coalesce(p_role, v_staff.role) <> 'admin'
          or coalesce(p_active, v_staff.active) = false) then
    select count(*) into v_admins
    from staff where role = 'admin' and active and id <> p_staff_id;

    if v_admins = 0 then
      raise exception
        'this is the only administrator left — make somebody else an admin first, or nobody can register a tablet or reset a PIN again'
        using errcode = 'CL027';
    end if;
  end if;

  update staff set
    name   = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
    role   = coalesce(p_role, role),
    phone  = case when p_phone is null then phone else nullif(trim(p_phone), '') end,
    reg_no = case when p_reg_no is null then reg_no else nullif(trim(p_reg_no), '') end,
    active = coalesce(p_active, active)
  where id = p_staff_id
  returning * into v_staff;

  -- Somebody switched off should not stay signed in on a tablet in the back
  -- room until it happens to idle out.
  if v_staff.active = false then
    update staff_sessions set ended_at = now()
    where staff_id = p_staff_id and ended_at is null;
  end if;

  perform app.write_audit('update_staff', 'staff', p_staff_id,
    v_before - 'pin_hash', to_jsonb(v_staff) - 'pin_hash');

  return v_staff;
end
$$;

-- ---------------------------------------------------------------------------
-- app.register_device
--
-- The token is generated here rather than in the browser: it is the only
-- credential a tablet holds, and 24 bytes from pgcrypto is a better answer
-- than whatever the page happened to have. It comes back exactly once — the
-- admin reads it onto the new tablet and it is never shown again.
-- ---------------------------------------------------------------------------
create or replace function app.register_device(
  p_label                text,
  p_is_clinic_device     boolean default true,
  p_idle_timeout_seconds int default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_device devices;
  v_token  text;
begin
  if app.current_staff_role() is distinct from 'admin' then
    raise exception 'a tablet is registered by an administrator' using errcode = 'CL005';
  end if;

  if nullif(trim(coalesce(p_label, '')), '') is null then
    raise exception 'give the tablet a name — "counter tablet", "cabin tablet"'
      using errcode = 'CL006';
  end if;

  if p_idle_timeout_seconds is not null
     and (p_idle_timeout_seconds < 30 or p_idle_timeout_seconds > 3600) then
    raise exception 'the idle lock is between 30 seconds and an hour'
      using errcode = 'CL006';
  end if;

  v_token := encode(gen_random_bytes(24), 'hex');

  insert into devices (label, device_token, is_clinic_device,
                       idle_timeout_seconds, registered_by)
  values (
    trim(p_label),
    v_token,
    coalesce(p_is_clinic_device, true),
    -- The counter tablet locks in three minutes because it faces the public;
    -- the cabin tablet gets ten (TABLET.md §5).
    coalesce(p_idle_timeout_seconds, case when p_is_clinic_device then 180 else 600 end),
    app.current_staff_id())
  returning * into v_device;

  perform app.write_audit('register_device', 'device', v_device.id, null,
    jsonb_build_object('label', v_device.label,
                       'is_clinic_device', v_device.is_clinic_device));

  return jsonb_build_object(
    'id', v_device.id,
    'label', v_device.label,
    'device_token', v_token,
    'idle_timeout_seconds', v_device.idle_timeout_seconds);
end
$$;

-- ---------------------------------------------------------------------------
-- app.revoke_device — the tablet left in an auto-rickshaw.
-- ---------------------------------------------------------------------------
create or replace function app.revoke_device(p_device_id uuid)
returns int
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_device devices;
  v_killed int;
begin
  if app.current_staff_role() is distinct from 'admin' then
    raise exception 'a tablet is revoked by an administrator' using errcode = 'CL005';
  end if;

  select * into v_device from devices where id = p_device_id;
  if not found then
    raise exception 'no such tablet' using errcode = 'CL006';
  end if;

  -- Revoking the tablet in your hands signs you out of the screen you are
  -- using, on a device that can never sign in again. If it is genuinely the
  -- one that is lost, it is not the one you are holding.
  if p_device_id = app.current_device_id() then
    raise exception 'that is the tablet you are using — revoke it from the other one'
      using errcode = 'CL027';
  end if;

  if v_device.revoked_at is not null then
    return 0;
  end if;

  update devices set revoked_at = now() where id = p_device_id;

  -- The half that matters. Without this the tablet keeps working, signed in,
  -- until it happens to idle out — which on the cabin tablet is ten minutes
  -- and on a tablet somebody is actively using is never. Ended, not deleted:
  -- who was signed in on that tablet, and until when, is exactly the question
  -- somebody asks after a device goes missing.
  update staff_sessions set ended_at = now()
  where device_id = p_device_id and ended_at is null;
  get diagnostics v_killed = row_count;

  perform app.write_audit('revoke_device', 'device', p_device_id,
    to_jsonb(v_device), jsonb_build_object('revoked_at', now(),
                                           'sessions_ended', v_killed));

  return v_killed;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants. `devices` stops being directly writable; the two transitions above
-- are now the only way in, which is PLAN.md §5.3 rule 2 applied to the last
-- table that was exempt from it.
-- ---------------------------------------------------------------------------
revoke insert, update, delete on devices from authenticated;
drop policy if exists devices_admin_write on devices;
drop policy if exists devices_admin_update on devices;

-- `staff` never had a write grant at all — the admin policies on it have been
-- decoration since M0, narrowing a permission nobody held. Dropped, because a
-- policy that cannot fire is a policy somebody will one day read as proof that
-- the table is writable.
drop policy if exists staff_admin_write on staff;
drop policy if exists staff_admin_update on staff;

revoke all on function app.add_staff(text, staff_role, text, text, text) from public;
revoke all on function app.update_staff(uuid, text, staff_role, text, text, boolean) from public;
revoke all on function app.register_device(text, boolean, int) from public;
revoke all on function app.revoke_device(uuid) from public;

grant execute on function app.add_staff(text, staff_role, text, text, text)
  to authenticated, service_role;
grant execute on function app.update_staff(uuid, text, staff_role, text, text, boolean)
  to authenticated, service_role;
grant execute on function app.register_device(text, boolean, int)
  to authenticated, service_role;
grant execute on function app.revoke_device(uuid)
  to authenticated, service_role;

comment on function app.add_staff(text, staff_role, text, text, text) is
  'Creates the first admin on an empty database, and after that requires one. The PIN is not optional: a staff member without one is on the lock screen and cannot pass it.';

comment on function app.revoke_device(uuid) is
  'Revokes the registration AND ends the live sessions in the same transaction. revoked_at alone only stops the next unlock (TABLET.md §5).';
