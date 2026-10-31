-- ═══════════════════════════════════════════════════════════════════════════
-- A RECONCILED VISIT STAYS RECONCILED, AND A CLOSURE IS SOMETHING THAT HAPPENED
--
-- Owner policy items 72 and 75. Forward-only.
--
-- ── WHAT KEEPS GOING WRONG, STATED ONCE ───────────────────────────────────
--
-- Three acceptance reviews in a row have found the same shape here, one layer
-- down each time:
--
--   `20260920000000` let a same-attendance record a closure it never made.
--   `20260922000000` checked `subject_visit_closed`, a boolean the writer sets.
--   The first draft of this migration checked that an EVENT existed, and then
--   that the event's `to_status` was honest — but never that the visit had
--   actually moved, so an event could be fabricated beside a visit that was
--   already `done` for some other reason entirely.
--
-- Each fix asked a better question of the same untrusted writer. The fourth
-- attempt tried to answer it with provenance — a transaction-local setting the
-- closing function set and the trigger checked — and the fifth review set that
-- setting itself, because any session can.
--
-- So nothing is claimed and nothing is trusted. Inserting a closure event is
-- what closes the visit: the trigger locks the row, refuses one that is not in
-- the queue, writes the transition and fills in `from_status` from what it
-- locked. A fabricated event beside an untouched visit cannot exist, because
-- the insert is the thing that moves it.
--
-- ── AND THE QUEUE CANNOT UNDO IT ──────────────────────────────────────────
--
-- `set_appointment_status` moves any visit to any status, so a visit closed as
-- the same attendance could be put back to `waiting` and signed again under a
-- fresh reference: two encounters and two ₹300 fees for one attendance.
-- Reproduced. Once a same-attendance determination names a visit, `done` is the
-- only status it may still take — `waiting` and `in_consult` would let it be
-- charged twice, and `cancelled` would say the attendance never happened.
--
-- ── OWNER ITEM 75, 16 SEPTEMBER 2026 ──────────────────────────────────────
--
--   "A doctor may retrospectively link same_attendance to a same-patient visit
--   already marked done. Record whether the resolution closed it now or found
--   it already done; never claim the resolution performed a closure it did not
--   perform. A cancelled visit remains ineligible until separately corrected.
--   Other open visits remain untouched."
--
-- `subject_visit_disposition` carries it, because a boolean cannot hold three
-- answers and the attempt to make it do so is what produced the false sentence.
--
-- One constraint added by `20260922000000` is dropped and replaced by rules
-- that say what it meant to say. Nothing already applied is edited.
-- ═══════════════════════════════════════════════════════════════════════════

set local search_path = jmc;


-- ── 1. What this would refuse, named with SQL that actually works ──────────
--
-- `20260922000000`'s pre-flight told an operator to "close or cancel the visits
-- they name, and record the correction", which is unusable: the resolution row
-- is immutable, so closing the visit afterwards changes nothing about it, and
-- the unique key on `idempotency_key` forbids a replacement determination.
--
-- The first draft of THIS pre-flight then printed SQL of its own that did not
-- work either — it read the prior status from an `UPDATE ... RETURNING`, which
-- returns the row as it now IS, so every event it wrote said `done -> done` and
-- the new rules rejected all of them. The fourth review reproduced that. What
-- it prints now is a call to the one function that may perform the closure at
-- all, which reads the status itself.
do $$
declare
  hollow text;
  hollow_ids text;
  unusable text;
  unusable_ids text;
  wrong_subject text;
  wrong_ids text;
begin
  -- Claimed a closure; the visit is still open. The determination stands and
  -- the queue is what is wrong, so the queue is what is corrected.
  select string_agg(format('%s (visit %s)', r.id, r.subject_visit_id), ', ' order by r.id),
         string_agg(quote_literal(r.id), ', ' order by r.id)
    into hollow, hollow_ids
    from jmc.consultation_attempt_resolutions r
    join jmc.appointments a on a.id = r.subject_visit_id
   where r.resolution = 'same_attendance'
     and r.subject_visit_closed
     and a.status in ('waiting', 'in_consult');

  if hollow is not null then
    /*
     * SELF-CONTAINED, and that is the point.
     *
     * The first version of this message told the operator to call
     * `jmc.close_visit_for_reconciliation()`, which this migration does not
     * create until two hundred lines below the raise that prints it — so the
     * recovery was unavailable at exactly the moment it was needed. The fifth
     * review found it. What follows uses only the schema that exists when this
     * raise fires, which is the schema BEFORE this migration.
     *
     * `for update of a` so the visits cannot move between being read and being
     * closed, and the prior status comes from the CTE rather than from the
     * update's own RETURNING, which would hand back the row as it now is.
     */
    raise exception
      E'These reconciliations record a closure that the queue does not show, so the clinic reports a '
      'closure that did not happen: %.\n'
      'The determination is a doctor''s and is not edited. Bring the visits into line with it, in one '
      'statement, using only what exists before this migration:\n'
      '  with target as (\n'
      '    select a.id as visit, a.status as before, r.id as resolution, r.reason, r.resolved_by\n'
      '      from jmc.appointments a\n'
      '      join jmc.consultation_attempt_resolutions r on r.subject_visit_id = a.id\n'
      '     where r.id in (%)\n'
      '       and a.status in (''waiting'', ''in_consult'')\n'
      '       for update of a\n'
      '  ), moved as (\n'
      '    update jmc.appointments a set status = ''done''\n'
      '      from target t where a.id = t.visit returning a.id\n'
      '  )\n'
      '  insert into jmc.appointment_events\n'
      '    (id, arrival_id, event, from_status, to_status, reason, detail, actor_id)\n'
      '  select gen_random_uuid()::text, t.visit, ''closed_on_reconciliation'', t.before, ''done'',\n'
      '         t.reason, ''Closed by the correction of '' || t.resolution, t.resolved_by\n'
      '    from target t;\n'
      'Then apply this migration again: its backfill matches those events to the determinations that '
      'wrote them.', hollow, hollow_ids;
  end if;

  -- Named a cancelled visit. Owner item 75 keeps a cancelled visit ineligible,
  -- so this one genuinely needs a person: either the cancellation was wrong, or
  -- the determination was.
  select string_agg(format('%s (visit %s)', r.id, r.subject_visit_id), ', ' order by r.id),
         string_agg(quote_literal(r.id), ', ' order by r.id)
    into unusable, unusable_ids
    from jmc.consultation_attempt_resolutions r
    join jmc.appointments a on a.id = r.subject_visit_id
   where r.resolution = 'same_attendance' and a.status = 'cancelled';

  if unusable is not null then
    raise exception
      E'These reconciliations name a cancelled visit as the same attendance, which the owner decision of '
      '16 September 2026 makes ineligible until the cancellation is separately corrected: %.\n'
      'Read each one with the doctor who recorded it:\n'
      '  select a.id, a.token, a.status, r.id as resolution, r.reason\n'
      '    from jmc.appointments a join jmc.consultation_attempt_resolutions r on r.subject_visit_id = a.id\n'
      '   where r.id in (%);', unusable, unusable_ids;
  end if;

  -- A new attendance is defined by a visit that is still available to consult.
  select string_agg(format('%s (visit %s)', r.id, r.subject_visit_id), ', ' order by r.id),
         string_agg(quote_literal(r.id), ', ' order by r.id)
    into wrong_subject, wrong_ids
    from jmc.consultation_attempt_resolutions r
    join jmc.appointments a on a.id = r.subject_visit_id
   where r.resolution = 'new_attendance'
     and a.status not in ('waiting', 'in_consult');

  if wrong_subject is not null then
    raise exception
      E'These reconciliations record a new attendance against a visit that is no longer available to '
      'consult, which is the one thing a new attendance says is not the case: %.\n'
      'Read them with the doctor. If the visit was closed by mistake, reopen it BEFORE applying this '
      'migration, because afterwards a reconciled visit cannot be reopened:\n'
      '  update jmc.appointments set status = ''waiting'' where id in (\n'
      '    select subject_visit_id from jmc.consultation_attempt_resolutions where id in (%));',
      wrong_subject, wrong_ids;
  end if;
end $$;


-- ── 2. Which of the three things happened ─────────────────────────────────
--
-- `closed_now`     this determination closed the visit it named.
-- `already_done`   the visit was already finished; the link is retrospective
--                  and no closure is claimed.
-- `not_applicable` no visit was named, or this determination does not close
--                  visits at all.
alter table jmc.consultation_attempt_resolutions
  add column if not exists subject_visit_disposition text not null default 'not_applicable';

alter table jmc.appointment_events
  add column if not exists resolution_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'resolutions_disposition_is_one_of_three'
       and conrelid = 'jmc.consultation_attempt_resolutions'::regclass
  ) then
    alter table jmc.consultation_attempt_resolutions
      add constraint resolutions_disposition_is_one_of_three
      check (subject_visit_disposition in ('closed_now', 'already_done', 'not_applicable'));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'appointment_events_resolution_fk'
       and conrelid = 'jmc.appointment_events'::regclass
  ) then
    alter table jmc.appointment_events
      add constraint appointment_events_resolution_fk
      foreign key (resolution_id) references jmc.consultation_attempt_resolutions (id);
  end if;
end $$;

-- One closure proof per determination, and no more. Without this a resolution
-- could accumulate events until one of them happened to look right.
create unique index if not exists appointment_events_one_closure_per_resolution
  on jmc.appointment_events (resolution_id)
  where resolution_id is not null and event = 'closed_on_reconciliation';


-- ── 3. The backfill, which append-only history does not permit by default ──
--
-- Both tables carry `before update or delete` triggers that raise
-- unconditionally, so the first draft of this migration could not upgrade a
-- single real row: it was green only because the rehearsal had no reconciliation
-- written between `20260922000000` and this file. The fourth review found it,
-- and the rehearsal now seeds exactly those rows and applies the two migrations
-- in sequence.
--
-- Disabling a trigger for the width of one statement is a migration mechanism
-- and not a hole: this runs inside the migration's transaction, as the table
-- owner, on rows whose content is derived entirely from what is already stored.
-- Nothing here decides anything — `closed_now` is read off the boolean that
-- `20260922000000` already guaranteed, and the closure events are matched to
-- the determinations that wrote them.
do $$
declare upgraded integer; matched integer;
begin
  alter table jmc.consultation_attempt_resolutions
    disable trigger consultation_attempt_resolutions_immutable;
  alter table jmc.appointment_events disable trigger appointment_events_immutable;

  update jmc.consultation_attempt_resolutions
     set subject_visit_disposition = 'closed_now'
   where subject_visit_closed
     and subject_visit_disposition <> 'closed_now';
  get diagnostics upgraded = row_count;

  -- One closure per visit per resolution, so this is unambiguous. The `not
  -- exists` keeps it idempotent if this migration is applied twice.
  update jmc.appointment_events e
     set resolution_id = r.id
    from jmc.consultation_attempt_resolutions r
   where e.resolution_id is null
     and e.event = 'closed_on_reconciliation'
     and e.arrival_id = r.subject_visit_id
     and r.resolution = 'same_attendance'
     and r.subject_visit_closed
     and not exists (
       select 1 from jmc.appointment_events other
        where other.resolution_id = r.id and other.event = 'closed_on_reconciliation'
     );
  get diagnostics matched = row_count;

  alter table jmc.consultation_attempt_resolutions
    enable trigger consultation_attempt_resolutions_immutable;
  alter table jmc.appointment_events enable trigger appointment_events_immutable;

  if upgraded > 0 or matched > 0 then
    raise notice 'Upgraded % reconciliation(s) and matched % closure event(s) to their determinations.',
      upgraded, matched;
  end if;
end $$;

comment on column jmc.consultation_attempt_resolutions.subject_visit_disposition is
  'What this determination did with the visit it named: closed it now, found it already done, or nothing. Owner item 75 — never claim a closure that was not performed.';


-- ── 4. The rules that replace the one that could be walked around ─────────
alter table jmc.consultation_attempt_resolutions
  drop constraint if exists resolutions_same_attendance_closes_its_visit;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'resolutions_disposition_follows_the_determination'
       and conrelid = 'jmc.consultation_attempt_resolutions'::regclass
  ) then
    alter table jmc.consultation_attempt_resolutions
      add constraint resolutions_disposition_follows_the_determination
      check (
        case
          when resolution = 'same_attendance' and subject_visit_id is not null
            then subject_visit_disposition in ('closed_now', 'already_done')
          else subject_visit_disposition = 'not_applicable'
        end
      );
  end if;

  -- The old column keeps meaning exactly what it always meant, and can no
  -- longer disagree with the new one.
  if not exists (
    select 1 from pg_constraint
     where conname = 'resolutions_closed_flag_follows_disposition'
       and conrelid = 'jmc.consultation_attempt_resolutions'::regclass
  ) then
    alter table jmc.consultation_attempt_resolutions
      add constraint resolutions_closed_flag_follows_disposition
      check (subject_visit_closed = (subject_visit_disposition = 'closed_now'));
  end if;

  -- Owner item 73: an abandoned attempt closes nothing and names nothing.
  if not exists (
    select 1 from pg_constraint
     where conname = 'resolutions_abandoned_names_no_visit'
       and conrelid = 'jmc.consultation_attempt_resolutions'::regclass
  ) then
    alter table jmc.consultation_attempt_resolutions
      add constraint resolutions_abandoned_names_no_visit
      check (resolution <> 'abandoned_attempt' or subject_visit_id is null);
  end if;
end $$;


-- ── 5. Inserting the closure event IS the closure ─────────────────────────
--
-- The fifth review broke the previous design in four steps: mark a visit done
-- for an unrelated reason, insert a `closed_now` determination, call
-- `set_config('jmc.closing_reconciliation', ...)` — which any session may do —
-- and insert a fabricated `waiting -> done` event. A transaction-local setting
-- is a convention, not provenance, and it was being used as provenance.
--
-- So there is nothing left to claim. The trigger below takes the visit's row
-- lock, refuses a visit that is not in the queue, derives `from_status` from
-- what it locked, writes the transition, and only then lets the row be
-- inserted. A fabricated event cannot exist beside a visit that did not move,
-- because inserting the event is what moves it.
--
-- It also derives nothing from the caller. The fifth review closed a doctor's
-- determination through the function with a NURSE's id and the event named the
-- nurse; `actor_id` is checked against the determination's own `resolved_by`
-- here, and the function below passes no identity at all.
create or replace function jmc.close_the_visit_this_event_names()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
declare
  r record;
  was text;
  signed_as text;
begin
  if new.event <> 'closed_on_reconciliation' then
    return new;
  end if;

  if new.resolution_id is null then
    raise exception
      'A closure event records a determination closing a visit, so it names the determination.';
  end if;

  select resolution, subject_visit_id, subject_visit_disposition, resolved_by, patient_id,
         reason, encounter_id
    into r
    from jmc.consultation_attempt_resolutions
   where id = new.resolution_id
     for update;

  if not found then
    raise exception 'Closure event names reconciliation %, which does not exist.', new.resolution_id;
  end if;
  if r.resolution is distinct from 'same_attendance'
     or r.subject_visit_id is distinct from new.arrival_id
     or r.subject_visit_disposition is distinct from 'closed_now' then
    raise exception
      'Closure event for reconciliation % does not match that determination: it must be a same '
      'attendance recorded as closed_now, naming this very visit.', new.resolution_id;
  end if;
  if new.actor_id is distinct from r.resolved_by then
    raise exception
      'Closure event for reconciliation % names % as the actor, and that determination was recorded by '
      '%. A closure is performed by the doctor who determined it.',
      new.resolution_id, new.actor_id, r.resolved_by;
  end if;

  select status into was from jmc.appointments where id = new.arrival_id for update;

  if was is null then
    raise exception 'Closure event names visit %, which does not exist.', new.arrival_id;
  end if;
  if was not in ('waiting', 'in_consult') then
    raise exception
      'Visit % is %, so it cannot be closed: a closure moves a visit out of the queue, and this one is '
      'not in it. A determination about a visit that was already finished is recorded as already_done.',
      new.arrival_id, was;
  end if;

  -- The transition, performed here, by the act of recording it.
  update jmc.appointments set status = 'done' where id = new.arrival_id;

  /*
   * And the WORDS are the determination's too.
   *
   * The trigger protected the transition, the visit, the actor and both
   * statuses, and took `reason` and `detail` from whoever wrote the row — so a
   * direct writer could leave a genuine closure, by the right doctor, carrying
   * a fabricated reason in an append-only clinical record. Owner item 72 keeps
   * the doctor's reason; the sixth review found that it kept whatever it was
   * handed.
   *
   * Overwritten from the locked determination, exactly as both statuses
   * already are. Nothing a caller supplies survives.
   */
  select rx.prescription_number into signed_as
    from jmc.prescriptions rx where rx.encounter_id = r.encounter_id limit 1;

  new.reason := r.reason;
  new.detail := 'Same attendance as the consultation already signed'
                || coalesce(' as ' || signed_as, '');
  new.from_status := was;
  new.to_status := 'done';
  return new;
end;
$$;

drop trigger if exists appointment_events_closure_is_genuine on jmc.appointment_events;
create trigger appointment_events_closure_is_genuine
before insert on jmc.appointment_events
for each row execute function jmc.close_the_visit_this_event_names();


-- ── 6. What a caller may ask for, which is one thing ──────────────────────
--
-- The resolution's id, and nothing else. Everything the closure records —
-- which visit, which doctor, in what words — is read from the determination
-- under its own lock, so a caller cannot put somebody else's name on it.
--
-- Returns what actually happened, so a caller that believed otherwise finds
-- out rather than recording it.
create or replace function jmc.close_visit_for_reconciliation(p_resolution text)
returns text
language plpgsql
set search_path = pg_catalog, jmc
as $$
declare
  r record;
  was text;
begin
  select id, resolution, subject_visit_id, subject_visit_disposition, resolved_by, reason, encounter_id
    into r
    from jmc.consultation_attempt_resolutions
   where id = p_resolution
     for update;

  if not found then
    raise exception 'Reconciliation % was not found.', p_resolution;
  end if;
  if r.resolution <> 'same_attendance' then
    raise exception 'Reconciliation % is not a same attendance, so it closes nothing.', p_resolution;
  end if;
  if r.subject_visit_id is null then
    return 'not_applicable';
  end if;

  select status into was from jmc.appointments where id = r.subject_visit_id for update;

  if was is null then
    raise exception 'Reconciliation % names a visit that does not exist.', p_resolution;
  end if;
  if was = 'cancelled' then
    raise exception
      'That visit was cancelled, so it is not an attendance for a consultation to be the same as.';
  end if;
  if was = 'done' then
    -- Owner item 75's retrospective link. Nothing is written and nothing is
    -- claimed; the caller records `already_done`.
    return 'already_done';
  end if;

  /*
   * The insert performs the transition, in section 5 — and section 5 also
   * fills in both statuses, the reason and the detail from the determination
   * it locks. What is passed here is what that trigger will overwrite; it is
   * written out rather than left null so the statement reads as the record it
   * produces.
   */
  insert into jmc.appointment_events
    (id, arrival_id, event, from_status, to_status, reason, detail, actor_id, resolution_id)
  values
    (gen_random_uuid()::text, r.subject_visit_id, 'closed_on_reconciliation', was, 'done',
     r.reason, 'Same attendance as the consultation already signed', r.resolved_by, r.id);

  return 'closed_now';
end;
$$;


-- ── 7. And the determination is checked against the clinic at COMMIT ──────
--
-- Deferred, so that the determination, the visit and the event are all present
-- and can be compared with one another. Sections 5 and 6 make a forged closure
-- unwritable; this is what catches a determination that is wrong about a visit
-- nobody forged anything about.
create or replace function jmc.enforce_reconciliation_subject()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
declare
  visit_status text;
  closures integer;
  other_encounter text;
begin
  if new.subject_visit_id is null then
    return new;
  end if;

  select status into visit_status
    from jmc.appointments where id = new.subject_visit_id;

  if visit_status is null then
    raise exception 'Reconciliation % names a visit that does not exist.', new.id;
  end if;

  if new.resolution = 'same_attendance' then
    if visit_status <> 'done' then
      raise exception
        'Reconciliation % records visit % as the same attendance, but that visit is % rather than done. '
        'A same attendance closes the visit it names; a cancelled visit is ineligible until the '
        'cancellation is separately corrected.',
        new.id, new.subject_visit_id, visit_status;
    end if;

    select count(*) into closures
      from jmc.appointment_events
     where resolution_id = new.id
       and arrival_id = new.subject_visit_id
       and event = 'closed_on_reconciliation';

    if new.subject_visit_disposition = 'closed_now' and closures <> 1 then
      raise exception
        'Reconciliation % says it closed visit % now, and no closure event records it doing so.',
        new.id, new.subject_visit_id;
    end if;

    if new.subject_visit_disposition = 'already_done' then
      if closures <> 0 then
        raise exception
          'Reconciliation % says it found visit % already done, and a closure event says it closed it. '
          'One of the two is untrue.',
          new.id, new.subject_visit_id;
      end if;

      -- Owner item 75 links retrospectively to a visit that was ALREADY
      -- FINISHED — not to one that has a consultation of its own. If a signing
      -- under a fresh reference won the race and wrote an encounter against
      -- that visit, then the visit is `done` because it was consulted, and
      -- recording it as the same attendance as some earlier consultation says
      -- something false and hides the very duplicate that reconciliation exists
      -- to expose. The fourth review found it.
      --
      -- The encounter this determination is ABOUT is excluded, because a
      -- consultation signed against its own visit is the ordinary shape.
      select e.id into other_encounter
        from jmc.encounters e
       where e.appointment_id = new.subject_visit_id
         and (new.encounter_id is null or e.id <> new.encounter_id)
       limit 1;

      if other_encounter is not null then
        raise exception
          'Visit % already has a consultation of its own (%), so it is not a visit that was merely left '
          'finished. Reconciliation % would record it as the same attendance as a different consultation '
          'and hide a duplicate rather than resolve one.',
          new.subject_visit_id, other_encounter, new.id;
      end if;
    end if;

  elsif new.resolution = 'new_attendance' then
    -- Owner item 74: a new attendance keeps the visit available for a fresh
    -- consultation. A finished or cancelled visit is not available.
    if visit_status not in ('waiting', 'in_consult') then
      raise exception
        'Reconciliation % records visit % as the attendance that continues, and that visit is %. A new '
        'attendance names the visit still to be consulted.',
        new.id, new.subject_visit_id, visit_status;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists resolutions_subject_is_what_it_claims
  on jmc.consultation_attempt_resolutions;
create constraint trigger resolutions_subject_is_what_it_claims
after insert on jmc.consultation_attempt_resolutions
deferrable initially deferred
for each row execute function jmc.enforce_reconciliation_subject();


-- ── 8. A reconciled visit stays reconciled ────────────────────────────────
--
-- Owner item 72's closure has to survive the queue, so it is enforced where the
-- queue is: once a same-attendance determination names a visit, `done` is the
-- only status it may still take. `waiting` and `in_consult` would let one
-- attendance be consulted and charged twice; `cancelled` would say the
-- attendance never happened.
--
-- `done` is still allowed, and must be: section 5 closes the visit with the
-- determination already written, so the closure is itself an update this sees.
--
-- A `new_attendance` subject is deliberately NOT covered: that visit is meant
-- to stay open and be consulted, which is the whole of owner item 74.
create or replace function jmc.reject_reopening_a_reconciled_visit()
returns trigger
language plpgsql
set search_path = pg_catalog, jmc
as $$
declare
  determined text;
begin
  if new.status = old.status or new.status = 'done' then
    return new;
  end if;

  select r.id into determined
    from jmc.consultation_attempt_resolutions r
   where r.subject_visit_id = old.id
     and r.resolution = 'same_attendance'
   limit 1;

  if determined is not null then
    raise exception
      'Visit % was recorded as the same attendance as a consultation that is already signed (%), so it '
      'stays closed. Putting it back in the queue would let it be consulted and charged a second time '
      'for one attendance; cancelling it would say the attendance never happened. If the patient is '
      'here again, arrive them afresh.',
      old.token, determined;
  end if;

  return new;
end;
$$;

drop trigger if exists appointments_reconciled_visits_stay_closed on jmc.appointments;
create trigger appointments_reconciled_visits_stay_closed
before update on jmc.appointments
for each row execute function jmc.reject_reopening_a_reconciled_visit();


-- ── 9. Access, exactly as every other object in this schema ────────────────
revoke all on function jmc.enforce_reconciliation_subject() from public, anon, authenticated, service_role;
revoke all on function jmc.reject_reopening_a_reconciled_visit() from public, anon, authenticated, service_role;
revoke all on function jmc.close_the_visit_this_event_names() from public, anon, authenticated, service_role;
revoke all on function jmc.close_visit_for_reconciliation(text) from public, anon, authenticated, service_role;
