-- Emergency recovery for a clinic that has data and administrators but no usable
-- registered browser/tablet. Normal tablet registration still requires an
-- already signed-in administrator and a one-time device code.
--
-- Recovery is intentionally narrower:
--   * exact clinic name
--   * active administrator name + existing 6-digit PIN
--   * no registered device seen in the last 30 minutes
--
-- A successful recovery revokes every stale device/session before minting the
-- replacement tablet. That makes this a takeover of the clinic's device trust,
-- not a second permanent registration path.
create or replace function app.recover_admin_device(
  p_clinic_name  text,
  p_admin_name   text,
  p_pin          text,
  p_device_label text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_catalog
as $$
declare
  v_admin staff%rowtype;
  v_clinic clinic%rowtype;
  v_device_id uuid;
  v_device_token text;
  v_session_token text;
begin
  perform pg_advisory_xact_lock(hashtext('clinic-admin-device-recovery'));

  if coalesce(trim(p_clinic_name), '') = ''
     or coalesce(trim(p_admin_name), '') = ''
     or coalesce(trim(p_device_label), '') = ''
     or p_pin !~ '^[0-9]{6}$' then
    raise exception 'clinic name, administrator name, 6-digit PIN and tablet name are required'
      using errcode = 'CL006';
  end if;

  select * into v_clinic from clinic limit 1;
  if not found or lower(trim(v_clinic.name)) <> lower(trim(p_clinic_name)) then
    raise exception 'incorrect recovery details' using errcode = 'CL005';
  end if;

  -- Recovery is not an alternate way to add a tablet during normal operation.
  -- If any trusted tablet has talked to the clinic recently, use the ordinary
  -- admin-issued registration code from People and tablets instead.
  if exists (
    select 1
    from devices d
    where d.revoked_at is null
      and d.last_seen_at is not null
      and d.last_seen_at > now() - interval '30 minutes'
  ) then
    raise exception 'recovery is unavailable while a registered tablet has been active recently; use an administrator registration code'
      using errcode = 'CL005';
  end if;

  select * into v_admin
  from staff s
  where s.active
    and s.role = 'admin'
    and lower(trim(s.name)) = lower(trim(p_admin_name))
    and s.pin_hash is not null
  order by s.created_at
  limit 1;

  if not found or v_admin.pin_hash <> crypt(p_pin, v_admin.pin_hash) then
    raise exception 'incorrect recovery details' using errcode = 'CL005';
  end if;

  -- The old device trust is assumed lost. End every session first and revoke
  -- every old device in the same transaction before issuing the replacement.
  update staff_sessions
  set ended_at = coalesce(ended_at, now())
  where ended_at is null;

  update devices
  set revoked_at = coalesce(revoked_at, now())
  where revoked_at is null;

  v_device_token := encode(gen_random_bytes(32), 'hex');
  insert into devices (
    label,
    device_token,
    is_clinic_device,
    registered_by,
    idle_timeout_seconds,
    last_seen_at
  ) values (
    trim(p_device_label),
    v_device_token,
    true,
    v_admin.id,
    600,
    now()
  ) returning id into v_device_id;

  v_session_token := encode(gen_random_bytes(32), 'hex');
  insert into staff_sessions (staff_id, device_id, token_hash, expires_at)
  values (
    v_admin.id,
    v_device_id,
    encode(digest(v_session_token, 'sha256'), 'hex'),
    now() + interval '10 minutes'
  );

  perform app.write_audit(
    'recover_device',
    'devices',
    v_device_id,
    null,
    jsonb_build_object(
      'label', trim(p_device_label),
      'registered_by', v_admin.id,
      'recovery', true
    ),
    'system'
  );

  return jsonb_build_object(
    'staff_id', v_admin.id,
    'staff_name', v_admin.name,
    'device_id', v_device_id,
    'device_label', trim(p_device_label),
    'device_token', v_device_token,
    'session_token', v_session_token
  );
end
$$;

revoke all on function app.recover_admin_device(text, text, text, text) from public;
grant execute on function app.recover_admin_device(text, text, text, text) to authenticated;

comment on function app.recover_admin_device(text, text, text, text) is
  'Emergency replacement of lost device trust. Requires clinic name + admin name/PIN and refuses while any trusted tablet was seen in the last 30 minutes.';
