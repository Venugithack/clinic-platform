-- Wiring the request context: who is asking, and which person is standing there.
--
-- lib/auth promises that the staff PIN session token reaches Postgres in the
-- `app.staff_session` GUC, where app.current_staff_id() reads it (0700). This
-- is the function that keeps that promise. PostgREST calls it once per request,
-- before anything else, via its `db-pre-request` setting.
--
-- It does two things, and both matter for attribution:
--
--   1. Normalises the JWT subject. PostgREST ≥ v10 exposes claims as a single
--      `request.jwt.claims` JSON GUC; older versions and some gateways set
--      `request.jwt.claim.sub` directly. auth.uid() reads the latter, so this
--      fills it in when only the former is present.
--
--   2. Lifts the x-staff-session header into `app.staff_session`. Without this
--      the device's auth user is the only identity Postgres can see, and every
--      audit row would name a tablet instead of a person — which the Schedule
--      H1 register cannot accept.
--
-- On a real Supabase project this is configured as the `db-pre-request` hook.
-- It is inert until something calls it, so the migration is safe everywhere.

create or replace function app.pre_request() returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_claims  jsonb;
  v_headers jsonb;
begin
  v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  if v_claims is not null and v_claims ? 'sub' then
    perform set_config('request.jwt.claim.sub', v_claims ->> 'sub', true);
  end if;

  v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  perform set_config(
    'app.staff_session',
    coalesce(v_headers ->> 'x-staff-session', ''),
    true
  );
exception
  -- A malformed header must not take the request down; it just means nobody is
  -- identified, and current_staff_id() returns null, and the transitions refuse.
  when others then
    perform set_config('app.staff_session', '', true);
end
$$;

revoke all on function app.pre_request() from public;
grant execute on function app.pre_request() to anon, authenticated, service_role;

comment on function app.pre_request() is
  'PostgREST db-pre-request hook. Lifts the PIN session out of x-staff-session so audit rows name a person, not a tablet.';
