#!/usr/bin/env bash
# Stand the whole system up from an empty database, in a browser.
#
# The rest of the suite runs against `seed.sql`, which inserts two devices —
# and that is exactly why the first-run deadlock survived four milestones
# unnoticed: a staff session needs an unlock, an unlock needs a registered
# device, and registering a device needed an admin session. On a seeded
# database nobody ever meets that. On the real one it is the first thing that
# happens.
#
# So this is a drill in the same sense as db-restore-drill.sh. Standing the
# system up from nothing happens exactly once, in a clinic, with somebody
# waiting — the worst possible moment to find out it was never tried.
#
# It leaves the database seeded again, so it is safe to run at any point.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"

echo "── resetting to migrations only (no seed)"
"$(dirname "${BASH_SOURCE[0]}")/db-reset.sh" >/dev/null

# PostgREST caches the schema and reconnects on its own; a rebuild underneath
# it can leave that cache stale (BUILD.md §14). One NOTIFY closes it.
psql_run -q -c "notify pgrst, 'reload schema'" >/dev/null 2>&1 || true

restore_seed() {
  # Reset first: the drill leaves a clinic, an admin and a tablet behind, and
  # the seed inserts its own singleton clinic row.
  echo "── restoring the development seed"
  "$(dirname "${BASH_SOURCE[0]}")/db-reset.sh" >/dev/null
  "$(dirname "${BASH_SOURCE[0]}")/db-seed.sh" >/dev/null
  psql_run -q -c "notify pgrst, 'reload schema'" >/dev/null 2>&1 || true
}
trap restore_seed EXIT

empty="$(psql -tA -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" \
  -c "select count(*) from staff")"
if [ "${empty}" != "0" ]; then
  echo "the database is not empty — the drill would prove nothing" >&2
  exit 1
fi

echo "── standing the clinic up in a browser"
E2E_FIRST_RUN=1 npx playwright test e2e/first-run --workers=1

echo "first-run drill: passed"
