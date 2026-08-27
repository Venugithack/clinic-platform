-- Guard the empty-clinic bootstrap separately from Supabase Auth.
-- A verified email proves control of an inbox, not that the inbox owns this
-- clinic. Production seeds exactly one owner address out-of-band; the row is
-- consumed by the successful first setup and is never exposed through the API.

create table if not exists app.bootstrap_owner (
  email text primary key,
  created_at timestamptz not null default now()
);

alter table app.bootstrap_owner enable row level security;
revoke all on table app.bootstrap_owner from public, anon, authenticated;

create or replace function app.first_run_owner(
  p_staff_name text,
  p_pin text
) returns jsonb
language plpgsql
security definer
set search_path = public, app, extensions, pg_catalog
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := app.current_auth_email();
  v_clinic clinic;
  v_staff staff;
begin
  if v_uid is null or v_email is null or app.current_auth_is_anonymous() then
    raise exception 'verify the administrator email first' using errcode = 'CL005';
  end if;

  if not exists (
    select 1 from app.bootstrap_owner b where lower(b.email) = v_email
  ) then
    raise exception 'this email is not configured as the clinic owner' using errcode = 'CL005';
  end if;

  if exists (select 1 from staff) then
    raise exception 'this clinic is already set up' using errcode = 'CL007';
  end if;
  if nullif(trim(coalesce(p_staff_name, '')), '') is null then
    raise exception 'administrator name is required' using errcode = 'CL006';
  end if;
  if p_pin !~ '^[0-9]{6}$' then
    raise exception 'a staff PIN is exactly 6 digits' using errcode = 'CL006';
  end if;

  select * into v_clinic from clinic limit 1;
  if v_clinic.id is null then
    insert into clinic (name) values ('Jayamurugan Clinic') returning * into v_clinic;
  else
    update clinic set name = 'Jayamurugan Clinic' where id = v_clinic.id returning * into v_clinic;
  end if;

  insert into staff (name, role, email, auth_user_id, pin_hash, pin_set_at)
  values (
    trim(p_staff_name), 'admin', v_email, v_uid,
    crypt(p_pin, gen_salt('bf', 12)), now()
  ) returning * into v_staff;

  delete from app.bootstrap_owner;

  perform app.write_audit(
    'first_run_owner', 'clinic', v_clinic.id, null,
    jsonb_build_object('clinic', v_clinic.name, 'admin', v_staff.name, 'email', v_email),
    'system'
  );

  return jsonb_build_object(
    'staff_id', v_staff.id,
    'staff_name', v_staff.name,
    'staff_role', v_staff.role,
    'email', v_email,
    'clinic_name', v_clinic.name
  );
end
$$;

revoke all on function app.first_run_owner(text, text) from public;
grant execute on function app.first_run_owner(text, text) to authenticated, service_role;
