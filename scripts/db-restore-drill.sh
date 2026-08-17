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

if [ -z "${BACKUP_FILE}" ] || [ ! -f "${BACKUP_FILE}" ]; then
  echo "no backup to restore — is BACKUP_AGE_RECIPIENT set? an encrypted archive has to be decrypted first" >&2
  exit 1
fi

echo "restoring ${BACKUP_FILE} → ${SCRATCH_DB}"

# The tables whose counts have to survive the round trip. The registers under
# PLAN.md §15.2 are the legal retention obligation, so they lead the list.
TABLES="audit_log stock_movements stock_batches dispenses dispense_lines prescriptions encounters patients drugs staff"

counts_of() {
  local database="$1"
  for table in ${TABLES}; do
    printf '%s=' "${table}"
    psql -tA -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${database}" \
      -c "select count(*) from ${table}"
  done
}

before="$(counts_of "${PGDATABASE}")"

psql -q -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d postgres \
  -c "drop database if exists ${SCRATCH_DB} with (force)" \
  -c "create database ${SCRATCH_DB}"

gunzip -c "${BACKUP_FILE}" \
  | psql -q -v ON_ERROR_STOP=1 -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${SCRATCH_DB}" \
  > /dev/null

after="$(counts_of "${SCRATCH_DB}")"

psql -q -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d postgres \
  -c "drop database if exists ${SCRATCH_DB} with (force)"

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
