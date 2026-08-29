begin;
select * from no_plan();

-- The clinic screen marker (20260829130000).
--
-- Presence is the one thing left in this schema that cares which browser is
-- asking, and the rule it protects is worth restating: only a screen physically
-- in the clinic may say the doctor is physically in the clinic. His laptop at
-- home signs in fine, sees everything, and sets nothing.
--
-- 20260827224500 took device identity out of sign-in — correctly, because staff
-- now open the clinic URL on whatever is in their hand — and app.unlock_pin
-- then minted every session with `device_id => null`. So app.current_device_id()
-- returned null for everyone, the check could never pass, and the feature was
-- dead rather than strict: nobody could say he was in the clinic, and /now could
-- never tell a patient he was.
--
-- Both halves are pinned here, because only the pair is meaningful. An unmarked
-- screen must still be refused, and a marked one must now work — a test for the
-- first alone passed all through the outage.

-- Conditional, unlike the older specs, and deliberately. `clinic` is a
-- singleton, so an unconditional insert only runs on the bare migrated database
-- CI builds — which makes the file impossible to run against a developer's
-- seeded stack, and this is a migration whose whole risk lives in the sign-in
-- path somebody will want to try by hand.
insert into clinic (id, name, timezone, open_hours)
select 'c3500000-0000-0000-0000-000000000035', 'Marker Clinic', 'Asia/Kolkata',
       '{"mon":["00:00-23:59"],"tue":["00:00-23:59"],"wed":["00:00-23:59"],
         "thu":["00:00-23:59"],"fri":["00:00-23:59"],"sat":["00:00-23:59"],
         "sun":["00:00-23:59"]}'::jsonb
where not exists (select 1 from clinic);

insert into staff (id, name, role, auth_user_id, pin_hash, pin_set_at) values
  ('35000000-0000-0000-0000-000000000001', 'Marker Admin', 'admin',
   'a3500000-0000-0000-0000-000000000001',
   crypt('481920', gen_salt('bf', 4)), now());

-- ---------------------------------------------------------------------------
-- Two shapes, one body — and that is a deployment decision, not an accident.
--
-- A default argument makes an overload rather than replacing anything, and
-- PostgREST resolves on the exact argument names it is sent. Dropping the
-- two-argument form would mean the bundle already deployed could not sign
-- anybody in until Cloudflare finished building; never adding the three-
-- argument form would mean the new bundle could not. Either way there is a
-- window where nobody at the clinic can sign in, lasting as long as a deploy.
--
-- So both shapes answer during the rollover. What must stay true is that they
-- cannot DISAGREE, which is what the delegation below is checked for.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'unlock_pin'),
  2,
  'both call shapes answer, so a deploy never has a sign-in gap'
);

select is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname = 'unlock_pin'
      and pg_get_functiondef(p.oid) ilike '%select app.unlock_pin(p_staff_id, p_pin, null::text)%'),
  1,
  'and the older one delegates rather than keeping a second body'
);

-- ---------------------------------------------------------------------------
-- An unmarked browser — which is every browser by default.
-- ---------------------------------------------------------------------------
create temporary table t_plain as
select app.unlock_pin('35000000-0000-0000-0000-000000000001', '481920') as result;

select is(
  (select (result->>'ok')::boolean from t_plain),
  true,
  'a browser with no marker signs in — the marker never gates access'
);

select is(
  (select s.device_id from staff_sessions s
    where s.token_hash = encode(digest(
            (select result->>'session_token' from t_plain), 'sha256'), 'hex')),
  null,
  'and its session carries no device'
);

select set_config('app.staff_session',
  (select result->>'session_token' from t_plain), true);

select throws_ok(
  $$ select app.set_presence('in_clinic') $$,
  'CL023',
  null,
  'so it cannot say the doctor is in the clinic'
);

-- Everything that is not a claim about being physically present still works
-- from anywhere, which is what makes the rule bearable rather than obstructive.
select lives_ok(
  $$ select app.set_presence('away') $$,
  'though it can say he is away, from anywhere'
);

-- ---------------------------------------------------------------------------
-- Marking a screen. Administrator only — this is the one browser claim left in
-- the system and it is not self-service.
-- ---------------------------------------------------------------------------
-- The counter cannot mark its own screen. 34_device_free_pin_access asserts the
-- GRANT is back; this is the gate behind it, which is the half that matters —
-- a marker anyone could mint would make presence a claim about nothing.
insert into staff (id, name, role, auth_user_id, pin_hash, pin_set_at) values
  ('35000000-0000-0000-0000-000000000002', 'Marker Counter', 'counter',
   'a3500000-0000-0000-0000-000000000002',
   crypt('481920', gen_salt('bf', 4)), now());

create temporary table t_counter as
select app.unlock_pin('35000000-0000-0000-0000-000000000002', '481920') as result;

select set_config('app.staff_session',
  (select result->>'session_token' from t_counter), true);

select throws_ok(
  $$ select app.register_device('Counter screen', true, null) $$,
  'CL005',
  null,
  'the counter cannot mark a screen as being in the clinic'
);

select set_config('app.staff_session',
  (select result->>'session_token' from t_plain), true);

create temporary table t_screen as
select app.register_device('Consulting room', true, null) as device;

select isnt(
  (select device->>'device_token' from t_screen),
  null,
  'the administrator gets a token for the screen'
);

-- The marker is read when a session is MINTED, so it is the next sign-in that
-- carries it — not the one that did the marking.
create temporary table t_marked as
select app.unlock_pin(
  '35000000-0000-0000-0000-000000000001', '481920',
  (select device->>'device_token' from t_screen)) as result;

select is(
  (select s.device_id from staff_sessions s
    where s.token_hash = encode(digest(
            (select result->>'session_token' from t_marked), 'sha256'), 'hex')),
  (select (device->>'id')::uuid from t_screen),
  'signing in on a marked screen ties the session to it'
);

select set_config('app.staff_session',
  (select result->>'session_token' from t_marked), true);

select lives_ok(
  $$ select app.set_presence('in_clinic') $$,
  'and from there he may say he is in the clinic'
);

-- ---------------------------------------------------------------------------
-- A stale marker is an unmarked screen, never a locked-out one.
--
-- Failing in this direction is the point. A marker that refused the SIGN-IN
-- once it had gone stale would turn "that tablet was replaced" into "nobody can
-- work this morning", which is a worse outage than the one it guards against.
-- ---------------------------------------------------------------------------
-- Revoked from somewhere else, because app.revoke_device raises CL027 against
-- the device the caller is sitting on — "that is the tablet you are using,
-- revoke it from the other one". That guard is about a tablet left in an
-- auto-rickshaw and it is right, but it also means the Staff access screen
-- cannot revoke the very screen it is unmarking, so the UI clears the browser's
-- marker first and treats CL027 as done: the only browser holding the token has
-- already let go of it.
-- Still on the marked screen from the test above, so this is the self-revoke.
select throws_ok(
  format('select app.revoke_device(%L::uuid)', (select device->>'id' from t_screen)),
  'CL027',
  null,
  'a screen cannot revoke itself'
);

-- From any other browser it goes through.
select set_config('app.staff_session',
  (select result->>'session_token' from t_plain), true);

select lives_ok(
  format('select app.revoke_device(%L::uuid)', (select device->>'id' from t_screen)),
  'the screen is revoked'
);

create temporary table t_revoked as
select app.unlock_pin(
  '35000000-0000-0000-0000-000000000001', '481920',
  (select device->>'device_token' from t_screen)) as result;

select is(
  (select (result->>'ok')::boolean from t_revoked),
  true,
  'a revoked marker still signs in'
);

select is(
  (select s.device_id from staff_sessions s
    where s.token_hash = encode(digest(
            (select result->>'session_token' from t_revoked), 'sha256'), 'hex')),
  null,
  'but carries no device, so presence goes back to being refused'
);

create temporary table t_nonsense as
select app.unlock_pin(
  '35000000-0000-0000-0000-000000000001', '481920', 'not-a-real-token') as result;

select is(
  (select (result->>'ok')::boolean from t_nonsense),
  true,
  'and a token that was never issued is ignored rather than fatal'
);

select * from finish();
rollback;
