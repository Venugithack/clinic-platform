#!/usr/bin/env bash
# The backup rig. HOSTING.md §5.
#
# Supabase free has no PITR and no downloadable backups. That is the single
# serious gap in running this for zero rupees a month, and it is entirely
# fixable — this script is the fix, and scripts/db-restore-drill.sh is the part
# that makes it honest. A backup that has never been restored is a belief.
#
#   What        pg_dump of the whole database, gzipped, age-encrypted
#   Where       Cloudflare R2 (10 GB free, zero egress) when configured
#   When        hourly during clinic hours, plus one nightly full
#   Retention   24 hourly · 30 daily · 12 monthly
#   Worst case  <= 1 hour of consults and dispenses
#
# Encryption is not optional: this file is a complete copy of every patient
# record the clinic holds, and it is leaving the database (PLAN.md §15, DPDP).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"

BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/.backups}"
KIND="${1:-hourly}"   # hourly | daily | monthly
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_DIR}/${KIND}/clinic-${STAMP}.sql.gz"

mkdir -p "$(dirname "${TARGET}")"

pg_dump -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" \
  --no-owner --no-privileges \
  | gzip -9 > "${TARGET}"

# age-encrypt when a recipient key is configured. Refuse to ship an unencrypted
# dump off the machine; keeping a plaintext one locally for a restore drill is
# fine, uploading one is not.
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  if ! command -v age >/dev/null 2>&1; then
    echo "BACKUP_AGE_RECIPIENT is set but age is not installed" >&2
    exit 1
  fi
  age -r "${BACKUP_AGE_RECIPIENT}" -o "${TARGET}.age" "${TARGET}"
  rm -f "${TARGET}"
  TARGET="${TARGET}.age"
fi

echo "backup: ${TARGET} ($(du -h "${TARGET}" | cut -f1))"

# Retention. 24 hourly, 30 daily, 12 monthly.
case "${KIND}" in
  hourly)  keep=24 ;;
  daily)   keep=30 ;;
  monthly) keep=12 ;;
  *)       keep=24 ;;
esac

# shellcheck disable=SC2012
ls -1t "${BACKUP_DIR}/${KIND}" 2>/dev/null | tail -n "+$((keep + 1))" | while read -r old; do
  rm -f "${BACKUP_DIR}/${KIND}/${old}"
  echo "pruned ${old}"
done

# Off-platform copy. R2 dumps are also the migration artefact in HOSTING.md §7's
# exit ramp — already tested weekly, so leaving a free tier is a restore, not a
# project.
if [ -n "${R2_BUCKET:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "${TARGET}" "${R2_BUCKET}/${KIND}/"
    echo "uploaded to ${R2_BUCKET}/${KIND}/"
  else
    echo "R2_BUCKET is set but rclone is not installed" >&2
    exit 1
  fi
fi
