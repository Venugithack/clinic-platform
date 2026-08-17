-- Closing what the M9 permissions review found. PLAN.md §16.
--
-- Postgres grants EXECUTE on a new function to PUBLIC by default. Every
-- transition in this build revokes that explicitly — the pattern has been
-- copied into all twenty-odd of them — but the HELPERS never did, because they
-- looked like plumbing rather than surface. Twelve of them were reachable by
-- `anon`.
--
-- None of them is exploitable today, and it is worth being precise about why
-- rather than waving at it:
--
--   * `current_staff_id`, `current_staff_role`, `current_device_id` take no
--     arguments and read the CALLER's own session, so anon gets null;
--   * `touch_updated_at`, `refuse_mutation`, `notify_change` are trigger
--     functions and raise if called directly;
--   * the rest are pure arithmetic on their arguments.
--
-- But `current_device_id` is SECURITY DEFINER over `staff_sessions`, and the
-- day somebody adds a parameter to it — "which device is session X on?" — the
-- default grant turns a helper into a lookup anybody on the internet can run.
-- The build's rule everywhere else is that a grant is a decision somebody made,
-- so these become decisions too.
--
-- The revoke is safe for the trigger functions: Postgres checks EXECUTE on a
-- trigger function when the trigger is CREATED, not each time it fires, and
-- migrations run as the owner.

revoke execute on function app.touch_updated_at()      from public;
revoke execute on function app.refuse_mutation()       from public;
revoke execute on function app.notify_change()         from public;
revoke execute on function app.changed_fields(jsonb, jsonb) from public;
revoke execute on function app.units_in_pack(int, int, text) from public;
revoke execute on function app.month_end(date)         from public;
revoke execute on function app.financial_year(date)    from public;
revoke execute on function app.clinic_day(timestamptz) from public;
revoke execute on function app.clinic_is_open(timestamptz) from public;
revoke execute on function app.current_staff_id()      from public;
revoke execute on function app.current_staff_role()    from public;
revoke execute on function app.current_device_id()     from public;

-- Re-granted where something actually calls them.
--
-- The identity helpers are named in almost every RLS policy, and a policy is
-- evaluated as the querying role — so `authenticated` genuinely needs these
-- three or every table in the database becomes unreadable. `anon` keeps them
-- because they return null for a caller with no session, and a null is a
-- cheaper failure than a permission error on a public page.
grant execute on function app.current_staff_id()   to authenticated, anon, service_role;
grant execute on function app.current_staff_role() to authenticated, anon, service_role;
grant execute on function app.current_device_id()  to authenticated, service_role;

-- Pure functions used inside views the app reads.
grant execute on function app.units_in_pack(int, int, text) to authenticated, service_role;
grant execute on function app.month_end(date)               to authenticated, service_role;
grant execute on function app.financial_year(date)          to authenticated, service_role;
grant execute on function app.clinic_day(timestamptz)       to authenticated, service_role;

-- The public status page asks this directly (PLAN.md §13.3).
grant execute on function app.clinic_is_open(timestamptz) to anon, authenticated, service_role;

-- The three trigger functions are re-granted to nobody. They are invoked by
-- Postgres on behalf of a trigger, and nothing should be calling them by hand.

comment on function app.current_device_id() is
  'SECURITY DEFINER over staff_sessions, so its grants are narrow on purpose: it is one parameter away from being a session lookup for anybody (M9 review).';
