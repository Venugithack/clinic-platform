-- M9 — the permissions review, written as a test rather than as a memo.
--
-- PLAN.md §16 lists "permissions review" as an M9 deliverable. A review done
-- once is a PDF nobody reads again; the same review as an assertion fails the
-- build the day somebody adds a convenience grant to ship a feature on a
-- Friday. So this file states the whole grant matrix and refuses to let it
-- drift.
--
-- It is deliberately written to be ANNOYING to update. Adding a table to any of
-- these lists is a two-line change and a moment's thought about whether the
-- thing being added should really be directly writable — which is the entire
-- value of the exercise.
begin;
select * from no_plan();

-- ---------------------------------------------------------------------------
-- 1. What `authenticated` may write to DIRECTLY.
--
-- Everything else in this database moves through a transition, which is
-- PLAN.md §5.3 rule 2. The seven below are the deliberate exceptions and each
-- one earns it:
--
--   patients, encounters,                   clinical and demographic records.
--   prescriptions, vitals                   Ordinary CRUD under RLS; they move
--                                           neither stock nor money, and the
--                                           ones that DO — signing an Rx — are
--                                           still transitions.
--   drugs, suppliers                        master data. Same argument.
--
-- `devices` was on this list until M11c. Registration was a plain INSERT and
-- the admin-only policy made that defensible — but a device token invented by
-- the browser is only as good as the browser's random source, and revoking a
-- tablet has to end its live sessions in the same transaction as it sets
-- `revoked_at`. Both are arguments for a transition, so devices went behind
-- `app.register_device` and `app.revoke_device` and this list got shorter.
--
-- `appointments` is NOT on the list, and that surprised the author of this file
-- when the review was first run. Booking one allocates a token under an
-- advisory lock, so it was written as a transition in M1 and the table was
-- never granted at all. The review's job is to find that the schema is stricter
-- than somebody remembered, as well as looser.
--
-- Note what is NOT here: stock_batches, stock_movements, dispenses, bills,
-- cash_movements, purchase_orders, presence, wa_messages, replay_log. Every
-- one of those is transition-owned, and that is what makes the audit log
-- complete rather than well-intentioned.
-- ---------------------------------------------------------------------------
select set_eq(
  $$ select distinct table_name::text
     from information_schema.table_privileges
     where grantee = 'authenticated'
       and table_schema = 'public'
       and privilege_type in ('INSERT', 'UPDATE', 'DELETE') $$,
  $$ values ('patients'), ('encounters'), ('prescriptions'),
            ('vitals'), ('drugs'), ('suppliers') $$,
  'exactly six tables are directly writable, and every other state change in the build goes through a transition (rule 2)'
);

select is(
  (select count(*)::int
   from information_schema.table_privileges
   where grantee = 'authenticated'
     and table_schema = 'public'
     and privilege_type = 'DELETE'),
  0,
  'nothing is deletable by anybody through the API — corrections are compensating rows, never erasures'
);

-- The one that matters most, restated here so a reader of this file does not
-- have to go and find 20_transition_grants.sql to believe it.
select is(
  (select count(*)::int
   from information_schema.table_privileges
   where grantee = 'authenticated'
     and table_name in ('stock_movements', 'stock_batches', 'dispenses',
                        'bills', 'cash_movements', 'audit_log', 'replay_log')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE')),
  0,
  'the ledger, the till, the audit log and the replay log take no direct writes at all'
);

-- ---------------------------------------------------------------------------
-- 2. The public surface.
-- ---------------------------------------------------------------------------
select set_eq(
  $$ select table_name::text || ':' || privilege_type::text
     from information_schema.table_privileges
     where grantee = 'anon' and table_schema = 'public' $$,
  $$ values ('clinic_now:SELECT') $$,
  'anon may read exactly one object in this database, and it carries no patient data'
);

-- ---------------------------------------------------------------------------
-- 3. RLS is on everywhere it should be.
--
-- BUILD.md §1.4: RLS goes on in the same migration that creates the table,
-- because retrofitted RLS is how a table ends up readable. `schema_migrations`
-- is the harness's own bookkeeping and holds no clinic data.
-- ---------------------------------------------------------------------------
select set_eq(
  $$ select c.relname::text
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity $$,
  $$ values ('schema_migrations') $$,
  'every table holding clinic data has row level security enabled'
);

-- ---------------------------------------------------------------------------
-- 4. Device registration and staff administration are admin acts.
--
-- A device row is what lets a PIN unlock the app at all, so a counter
-- assistant able to register one is a counter assistant able to take the
-- clinic home. Since M11c neither table takes a direct write; the guard is in
-- the transition, and A8_admin.sql drives it.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_policy
   where polrelid in ('devices'::regclass, 'staff'::regclass)
     and polcmd <> 'r'),
  0,
  'no write policy survives on devices or staff, because there is no write grant left for one to narrow'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app'
     and p.proname in ('add_staff', 'update_staff', 'register_device', 'revoke_device')
     and p.prosecdef),
  4,
  'and the four transitions that replaced those grants all run as definer'
);

-- ---------------------------------------------------------------------------
-- 5. Every transition is SECURITY DEFINER, and none is executable by the world.
--
-- A transition that is not definer cannot write to the tables it owns; one
-- granted to `public` is reachable by anon. Both are one-word mistakes, so
-- both are asserted rather than reviewed.
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and not p.prosecdef
     and p.proname not in ('touch_updated_at', 'refuse_mutation', 'changed_fields',
                           'units_in_pack', 'month_end', 'financial_year',
                           'notify_change', 'clinic_day', 'parse_expiry')),
  0,
  'every transition runs as definer; the exceptions are pure helpers that touch no table'
);

select is(
  (select count(*)::int
   from information_schema.role_routine_grants
   where routine_schema = 'app' and grantee = 'PUBLIC'),
  0,
  'and nothing in the app schema is executable by PUBLIC — a grant to public is a grant to anon, and twelve helpers were, until this review'
);

-- ---------------------------------------------------------------------------
-- 6. The append-only tables really are.
-- ---------------------------------------------------------------------------
select set_eq(
  $$ select c.relname::text
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where t.tgfoid = 'app.refuse_mutation'::regproc and not t.tgisinternal $$,
  $$ values ('stock_movements'), ('audit_log'), ('cash_movements') $$,
  'the stock ledger, the audit log and the cash drawer refuse UPDATE and DELETE at the row level — an edit is a story nobody can reconstruct'
);

select * from finish();
rollback;
