#!/usr/bin/env bash
# The practised restore. HOSTING.md §5, BUILD.md §1.7.
#
# "A backup that has never been restored is a belief, not a backup." This runs
# weekly in CI against a scratch database, asserts row counts match the source,
# and fails loudly when they do not. It is deliberately part of M0 rather than
# M9: it is a habit, and habits start on day 7 or never.
#
# TWO MODES, and the difference was a defect found during M9.
#
# As first written, the drill restored the newest backup on disk and compared it
# against the LIVE database. That can only pass in the seconds after a backup is
# taken: any consult, any sale, any test run moves the live counts and the drill
# reports a failure that is nothing of the sort. Run a week later it failed with
# eleven patients against four — and the restore had worked perfectly.
#
# A drill that cries wolf is worse than no drill, because the day it is right
# everybody assumes it is stale. So:
#
#   no argument      take a FRESH dump, restore it, compare counts. Any
#                    difference is a real restore failure. This is the drill.
#   a file argument  restore that specific archive and report what came back.
#                    An old backup SHOULD have old counts; the assertion is that
#                    it loads without error and is not empty.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"

BACKUP_FILE="${1:-}"
SCRATCH_DB="${SCRATCH_DB:-clinic_restore_drill}"
COMPARE=1

if [ -z "${BACKUP_FILE}" ]; then
  # Take one now, so the comparison is against the state that was dumped.
  "$(dirname "${BASH_SOURCE[0]}")/db-backup.sh" drill >/dev/null
  BACKUP_FILE="$(ls -1t "${REPO_ROOT}"/.backups/drill/*.sql.gz 2>/dev/null | head -1 || true)"
else
  # An archive from another day. Its counts are its own.
  COMPARE=0
fi

# A THIRD case, added when this started running against the hosted clinic.
#
# BACKUP_DB_URL means the dump above came from the real database in Mumbai
# while the restore lands in a throwaway cluster on this runner. The comparison
# still happens and still means something — it is just that `before` has to
# come from Mumbai rather than from a local database that has no tables in it
# at all.
#
# Note what this does NOT do, deliberately: fall back to "the archive is not
# empty". That heuristic is wrong twice. It passes a schema-only dump, which is
# precisely the restore failure worth catching, and it fails every night
# between now and go-live, because a clinic that has not been set up yet
# genuinely has no staff and no drugs. Counting both sides is correct on an
# empty database and on a full one.
#
# The residual risk is the one the header warns about: a consult landing
# between the dump and the count reads as a failure. The nightly schedule is
# 22:00 IST, after the clinic closes, and the diff printed on failure makes a
# one-row drift obvious for what it is.
REMOTE_SOURCE="${BACKUP_DB_URL:-}"

if [ -z "${BACKUP_FILE}" ] || [ ! -f "${BACKUP_FILE}" ]; then
  echo "no backup to restore — is BACKUP_AGE_RECIPIENT set? an encrypted archive has to be decrypted first" >&2
  exit 1
fi

echo "restoring ${BACKUP_FILE} → ${SCRATCH_DB}"

# The tables whose counts have to survive the round trip. The registers under
# PLAN.md §15.2 are the legal retention obligation, so they lead the list.
TABLES="audit_log stock_movements stock_batches dispenses dispense_lines prescriptions encounters patients drugs staff"

# Takes a psql connection spec rather than a database name, so the same
# function counts a local scratch database and a hosted project over TLS.
counts_at() {
  for table in ${TABLES}; do
    printf '%s=' "${table}"
    psql -tA "$@" -c "select count(*) from ${table}"
  done
}

counts_of() {
  counts_at -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "$1"
}

before=""
if [ "${COMPARE}" -eq 1 ]; then
  if [ -n "${REMOTE_SOURCE}" ]; then
    before="$(counts_at "${REMOTE_SOURCE}")"
  else
    before="$(counts_of "${PGDATABASE}")"
  fi
fi

psql -q -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d postgres \
  -c "drop database if exists ${SCRATCH_DB} with (force)" \
  -c "create database ${SCRATCH_DB}"

# TWO THINGS THE HOSTED ARCHIVE NEEDS THAT A BARE CLUSTER DOES NOT HAVE.
#
# Both were invisible until the rig first ran against Mumbai, because both are
# consequences of the `--schema` flags that db-backup.sh adds on the hosted path
# and only there. CI restored local dumps for weeks without meeting either.
#
# Roles first. They are cluster-level, so no dump of a single database has ever
# contained them, and 44 of this schema's RLS policies say `to authenticated`,
# `to anon` or `to service_role`. Migration 20260816090100 creates them in
# exactly this shape and for exactly this reason: Supabase ships them, a bare
# cluster does not.
psql -q -v ON_ERROR_STOP=1 -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${SCRATCH_DB}" <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;
SQL

# Then the public schema. `--schema=public` makes pg_dump emit its own
# `CREATE SCHEMA public`, and `create database` above has already supplied one,
# so the restore dies on the first statement it reads. Drop ours only when the
# archive is bringing its own — a local dump carries no such line, and dropping
# it there would leave the restore with nowhere to put the tables.
#
# The grep is `-c` and not `-q` for a reason that cost a CI run. Both `-q` and
# `-m1` stop reading the instant they match, which closes the pipe, hands gunzip
# a SIGPIPE, and — under the `set -o pipefail` at the top of this file — reports
# the whole test as FALSE precisely when it is true. `-c` has to read the entire
# stream to produce a count, so gunzip always exits cleanly.
if gunzip -c "${BACKUP_FILE}" | grep -c '^CREATE SCHEMA public;' >/dev/null; then
  psql -q -v ON_ERROR_STOP=1 -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${SCRATCH_DB}" \
    -c "drop schema public cascade"
fi

gunzip -c "${BACKUP_FILE}" \
  | psql -q -v ON_ERROR_STOP=1 -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${SCRATCH_DB}" \
  > /dev/null

after="$(counts_of "${SCRATCH_DB}")"

# Rule 3, asserted on real rows once a night.
#
# `stock_cache_drift` (20260816090500_pharmacy_inventory.sql) compares
# `stock_batches.qty_base_on_hand` against the sum of the ledger movements
# behind it, and its own comment says it "must always be empty ... the nightly
# job alerts if it is not". There was no nightly job. The view had been read by
# nothing since the day it was written, which makes an invariant a decoration.
#
# It is asked HERE, of the restored copy, rather than of production directly.
# The rows are the same rows, so the answer is the same answer, and this job
# already has a Postgres up with the whole clinic in it - the check costs no
# Actions minutes on a budget the hourly schedule is already spending.
#
# It also gives the drill something to say about DATA. Until there is clinic
# data every count here is zero, so all this job proves is that the schema round
# trips; a cache that disagrees with its own ledger is the first fact about the
# ROWS that a restore can be asked for.
drift="$(psql -tA -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${SCRATCH_DB}" \
  -c "select count(*) from stock_cache_drift")"

if [ "${drift}" = "0" ]; then
  echo "stock cache drift: none"
else
  echo "STOCK CACHE DRIFT - ${drift} batch(es) disagree with the ledger" >&2
  psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${SCRATCH_DB}" >&2 \
    -c "select batch_no, cached, ledger, drift from stock_cache_drift order by abs(drift) desc limit 20"
  drift_failed=1
fi

psql -q -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d postgres \
  -c "drop database if exists ${SCRATCH_DB} with (force)"

# Raised after the scratch database has been dropped, so a drift never leaves a
# restored copy of the clinic sitting on the runner.
if [ "${drift_failed:-0}" -eq 1 ]; then
  echo "RESTORE DRILL FAILED - the stock cache does not match the ledger" >&2
  exit 1
fi

if [ "${COMPARE}" -eq 1 ]; then
  if [ "${before}" != "${after}" ]; then
    echo "RESTORE DRILL FAILED — row counts differ" >&2
    diff <(echo "${before}") <(echo "${after}") >&2 || true
    exit 1
  fi

  echo "${after}" | tr '\n' ' '
  echo
  echo "restore drill: row counts match"
else
  # An older archive. It loaded, which is the question being asked; the only
  # failure that matters here is a restore that produces nothing at all.
  if ! grep -qE '^(staff|drugs)=[1-9]' <<<"${after}"; then
    echo "RESTORE DRILL FAILED — the archive restored empty" >&2
    echo "${after}" >&2
    exit 1
  fi

  echo "${after}" | tr '\n' ' '
  echo
  echo "restore drill: ${BACKUP_FILE} restored, counts above are that archive's"
fi
