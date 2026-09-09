#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"

SCRATCH_DB="${SCRATCH_DB:-clinic_restore_drill}"
BACKUP_FILE="${1:-}"
COMPARE=1

if [ -z "${BACKUP_FILE}" ]; then
  "$(dirname "${BASH_SOURCE[0]}")/db-backup.sh" drill >/dev/null
  BACKUP_FILE="$(ls -1t "${REPO_ROOT}"/.backups/drill/*.sql.gz 2>/dev/null | head -1 || true)"
else
  COMPARE=0
fi

if [ -z "${BACKUP_FILE}" ] || [ ! -f "${BACKUP_FILE}" ]; then
  echo "no plaintext backup is available to restore" >&2
  exit 1
fi

table_counts() {
  local connection=("$@")
  local table
  while IFS= read -r table; do
    printf '%s=' "${table}"
    psql -tA -v ON_ERROR_STOP=1 "${connection[@]}" -c "select count(*) from ${table}"
  done < <(
    psql -tA -v ON_ERROR_STOP=1 "${connection[@]}" -c \
      "select format('%I.%I', n.nspname, c.relname)
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('app', 'jmc', 'public')
          and c.relkind in ('r', 'p')
        order by n.nspname, c.relname"
  )
}

remote_source="${BACKUP_DB_URL:-}"
if [ "${COMPARE}" -eq 1 ]; then
  if [ -n "${remote_source}" ]; then
    before="$(table_counts "${remote_source}")"
  else
    before="$(table_counts -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}")"
  fi
fi

cleanup() {
  psql -q -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d postgres \
    -c "drop database if exists ${SCRATCH_DB} with (force)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup
psql -q -v ON_ERROR_STOP=1 -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d postgres \
  -c "create database ${SCRATCH_DB}"

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

if gunzip -c "${BACKUP_FILE}" | grep -c '^CREATE SCHEMA public;' >/dev/null; then
  psql -q -v ON_ERROR_STOP=1 -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${SCRATCH_DB}" \
    -c "drop schema public cascade"
fi

gunzip -c "${BACKUP_FILE}" \
  | psql -q -v ON_ERROR_STOP=1 -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${SCRATCH_DB}" \
  >/dev/null

after="$(table_counts -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${SCRATCH_DB}")"

if [ "${COMPARE}" -eq 1 ] && [ "${before}" != "${after}" ]; then
  echo "RESTORE DRILL FAILED: table names or row counts differ" >&2
  diff <(printf '%s' "${before}") <(printf '%s' "${after}") >&2 || true
  exit 1
fi

if ! printf '%s\n' "${after}" | grep -q '^jmc\.clinic_revision='; then
  echo "RESTORE DRILL FAILED: active jmc schema was not restored" >&2
  exit 1
fi

printf '%s\n' "${after}"
echo "restore drill: active and legacy clinic schemas restored successfully"
