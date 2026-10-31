-- Which length of PIN each staff member currently holds.
--
-- The clinic is moving from a six-digit PIN to a four-digit one, and a stored
-- hash cannot be converted: scrypt output says nothing about what went into
-- it, so there is no way to shorten a PIN except by asking the person for a
-- new one. That makes this a two-stage migration with a period in the middle
-- where both lengths are live, and the only way to know which is which is to
-- write it down.
--
-- ── WHY A COLUMN AND NOT AN INFERENCE ──────────────────────────────────────
--
-- The alternative is to accept either length from everybody until the clinic
-- has "probably" finished. That is worse in two ways. It halves the search
-- space for every account at once, including the ones already migrated, which
-- is the opposite of what the migration is for. And it leaves nobody able to
-- answer the question the rollout actually turns on — how many people are
-- still on the old PIN — except by asking them one at a time.
--
-- With a column, `where pin_format = 'legacy_six' and active = 1` is the
-- rollout's progress bar and its exit gate: six-digit compatibility comes out
-- of the code when that count reaches zero, and not before. The brief is
-- explicit that deploying exact-four-only before a reset path exists would
-- lock the whole clinic out.
--
-- ── THE TWO DEFAULTS, WHICH LOOK LIKE A MISTAKE AND ARE NOT ────────────────
--
-- The column is added with default 'legacy_six' so that every row already in
-- the table — every staff member who has one of the old PINs right now — is
-- backfilled correctly in a single statement, without this migration having to
-- know who they are.
--
-- The default is then changed to 'four'. From here on, a row inserted by
-- anything that forgets to name this column gets the strict format. That is
-- the safe direction to be wrong in: a four-digit PIN wrongly marked
-- 'legacy_six' would silently keep a weaker account alive past the cutover,
-- while a six-digit PIN wrongly marked 'four' simply fails to sign in and
-- somebody says so immediately.

set local search_path = jmc;

alter table staff
  add column if not exists pin_format text not null default 'legacy_six'
  check (pin_format in ('legacy_six', 'four'));

alter table staff alter column pin_format set default 'four';

comment on column staff.pin_format is
  'Length of the PIN this staff member currently holds: legacy_six until they '
  'are reset, four afterwards. New and reset PINs are always four. '
  'Six-digit compatibility is removed only when no active row is legacy_six.';

-- The rollout reads this on every admin snapshot, and sign-in reads the column
-- for every attempt. Partial, because the interesting rows are the shrinking
-- set of people who have not been reset yet.
create index if not exists staff_legacy_pin on staff (pin_format)
  where pin_format = 'legacy_six';
