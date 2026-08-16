#!/usr/bin/env bash
# The practised restore. HOSTING.md §5, BUILD.md §1.7.
#
# "A backup that has never been restored is a belief, not a backup." This runs
# weekly in CI against a scratch database, asserts row counts match the source,
# and fails loudly when they do not. It is deliberately part of M0 rather than
# M9: it is a habit, and habits start on day 7 or never.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"

BACKUP_FILE="${1:-}"
SCRATCH_DB="${SCRATCH_DB:-clinic_restore_drill}"

if [ -z "${BACKUP_FILE}" ]; then
  BACKUP_FILE="$(ls -1t "${REPO_ROOT}"/.backups/*/*.sql.gz 2>/dev/null | head -1 || true)"
fi

if [ -z "${BACKUP_FILE}" ] || [ ! -f "${BACKUP_FILE}" ]; then
  echo "no backup to restore — run scripts/db-backup.sh first" >&2
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

if [ "${before}" != "${after}" ]; then
  echo "RESTORE DRILL FAILED — row counts differ" >&2
  diff <(echo "${before}") <(echo "${after}") >&2 || true
  exit 1
fi

echo "${before}" | tr '\n' ' '
echo
echo "restore drill: row counts match"
