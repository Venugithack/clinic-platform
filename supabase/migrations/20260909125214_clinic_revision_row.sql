-- The revision counter's single row.
--
-- `clinic_revision` was created with the rest of the schema and never given the
-- single row it exists to hold, and nothing anywhere complains about that:
-- `update clinic_revision ... where id = 1` updates zero rows without erroring,
-- `currentRevision()` reads `?? 0` off a missing row and returns 0, and the
-- tablets then poll `snapshot?since=0` against a revision that is permanently
-- 0. Every poll answers "unchanged". Four tablets share one clinic and none of
-- them ever sees another's writes — the queue on the nurse's tablet and the
-- shelf figure at the counter simply stop moving, with no error on any screen.
--
-- It starts at 0 because the number is a change token rather than a count of
-- anything; the only property that matters is that it moves.
--
-- `do nothing` on conflict because the row may already be there. This schema
-- was built on first use before it was ever a migration, so a database that has
-- been serving a clinic holds a live revision that four tablets have copies of.
-- Only its absence is being repaired here.

set local search_path = jmc;

insert into clinic_revision (id, revision, changed_at)
values (1, 0, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
on conflict (id) do nothing;
