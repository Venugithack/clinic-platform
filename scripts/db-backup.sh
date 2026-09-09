#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"

BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/.backups}"
KIND="${1:-hourly}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_DIR}/${KIND}/clinic-${STAMP}.sql.gz"

case "${KIND}" in
  hourly) keep=24 ;;
  daily) keep=30 ;;
  monthly) keep=12 ;;
  drill) keep=2 ;;
  *) echo "unknown backup kind: ${KIND}" >&2; exit 1 ;;
esac

mkdir -p "$(dirname "${TARGET}")"

if [ -n "${BACKUP_DB_URL:-}" ]; then
  # jmc is the active application. public/app are retained until the legacy
  # database is formally retired, so a backup can recover either generation.
  pg_dump "${BACKUP_DB_URL}" \
    --no-owner --no-privileges \
    --schema=public --schema=app --schema=jmc \
    | gzip -9 > "${TARGET}"
else
  pg_dump -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" \
    --no-owner --no-privileges \
    | gzip -9 > "${TARGET}"
fi

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null 2>&1 || { echo "age is not installed" >&2; exit 1; }
  age -r "${BACKUP_AGE_RECIPIENT}" -o "${TARGET}.age" "${TARGET}"
  rm -f "${TARGET}"
  TARGET="${TARGET}.age"
fi

echo "backup: ${TARGET} ($(du -h "${TARGET}" | cut -f1))"

# shellcheck disable=SC2012
ls -1t "${BACKUP_DIR}/${KIND}" 2>/dev/null | tail -n "+$((keep + 1))" | while read -r old; do
  rm -f "${BACKUP_DIR}/${KIND}/${old}"
done

if [ -n "${R2_BUCKET:-}" ]; then
  command -v rclone >/dev/null 2>&1 || { echo "rclone is not installed" >&2; exit 1; }
  case "${TARGET}" in
    *.age) ;;
    *) echo "refusing to upload an unencrypted database" >&2; exit 1 ;;
  esac

  rclone copy "${TARGET}" "${R2_BUCKET}/${KIND}/"
  rclone lsf "${R2_BUCKET}/${KIND}/" 2>/dev/null \
    | sort -r \
    | tail -n "+$((keep + 1))" \
    | while read -r stale; do
        [ -n "${stale}" ] || continue
        rclone deletefile "${R2_BUCKET}/${KIND}/${stale}"
      done
  echo "uploaded: ${R2_BUCKET}/${KIND}/"
fi
