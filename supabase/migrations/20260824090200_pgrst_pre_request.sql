-- Actually install the db-pre-request hook, rather than only documenting it.
--
-- 20260816140200 defines `app.pre_request()` and its comment says "PostgREST
-- db-pre-request hook". Nothing ever told PostgREST that. The only place the
-- wiring existed was `scripts/dev-api.mjs`, which starts the development
-- stand-in with `db-pre-request = "app.pre_request"` on the command line — so
-- the hook ran under the stand-in and has never run anywhere else.
--
-- What that costs, on the Docker stack and on a hosted project alike:
--
--   · `app.current_device_id()` reads `app.staff_session` and has no fallback,
--     so it returns null and every device is "unknown". `app.set_presence`
--     then refuses with "this device is not registered as a clinic device" —
--     on the cabin tablet, which is registered.
--   · `app.current_staff_id()` DOES fall back to auth.uid(), which is worse
--     than failing. Every tablet shares one device session (TABLET.md §5), so
--     every request resolves to that session's staff member no matter who
--     typed their PIN. The counter's actions are attributed to the doctor, an
--     admin-only transition refuses for the admin and succeeds for whoever the
--     device belongs to, and the H1 register names the wrong person —
--     precisely the failure PLAN.md §15.2 says it cannot accept.
--
-- Configuring it in the database rather than in config.toml is deliberate: this
-- is the form Supabase documents, it survives `supabase db push` to a hosted
-- project, and it means the hook is a property of the schema rather than of
-- whoever last edited a TOML file. `notify pgrst` makes a running PostgREST
-- pick it up without a restart.
do $$
begin
  -- A bare Postgres cluster has no PostgREST and no `authenticator`; the roles
  -- migration creates anon/authenticated/service_role and deliberately not this
  -- one. Skipping there keeps `db-migrate.sh` and CI working unchanged.
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'alter role authenticator set pgrst.db_pre_request = ''app.pre_request''';
  end if;
end $$;

notify pgrst, 'reload config';
