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

# Local cluster, or the hosted project.
#
# BACKUP_DB_URL is what the GitHub Actions schedule passes: the clinic's real
# database, reached through Supabase's SESSION-mode pooler. Not the direct
# connection — that is IPv6-only and Actions runners are IPv4-only, and the
# IPv4 add-on is paid, so the direct host is the one way to make this rig cost
# money. Not transaction mode either (port 6543); it cannot serve pg_dump.
#
# `--schema` is set on this path and deliberately not on the local one. A
# hosted Supabase database also contains auth, storage and extensions schemas
# owned by roles that do not exist anywhere else, and dumping those would break
# the promise in HOSTING.md §7 that this file restores onto a plain Postgres
# cluster. `public` and `app` are the clinic's own — every table, every
# register, every transition.
#
# What is knowingly left out: `auth.users`, which holds the devices' anonymous
# Supabase sessions. Those are minted on demand and re-registered from the
# admin screen; the identity that has to survive is the staff PIN, and that
# lives in public.staff.
if [ -n "${BACKUP_DB_URL:-}" ]; then
  pg_dump "${BACKUP_DB_URL}" \
    --no-owner --no-privileges \
    --schema=public --schema=app \
    | gzip -9 > "${TARGET}"
else
  pg_dump -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" \
    --no-owner --no-privileges \
    | gzip -9 > "${TARGET}"
fi

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
  if ! command -v rclone >/dev/null 2>&1; then
    echo "R2_BUCKET is set but rclone is not installed" >&2
    exit 1
  fi

  # Refuse to ship plaintext. The local prune above tolerates an unencrypted
  # archive because a drill needs one; this is the boundary where a complete
  # copy of every patient record leaves the country's border and our control
  # (PLAN.md §15, DPDP), and it is not a judgement call.
  case "${TARGET}" in
    *.age) ;;
    *)
      echo "refusing to upload an unencrypted dump — set BACKUP_AGE_RECIPIENT" >&2
      exit 1
      ;;
  esac

  rclone copy "${TARGET}" "${R2_BUCKET}/${KIND}/"
  echo "uploaded to ${R2_BUCKET}/${KIND}/"

  # Retention, enforced HERE and not by the local prune above.
  #
  # On a GitHub runner the working directory is discarded when the job ends, so
  # there is never a second local file to prune and `ls | tail` above always
  # finds nothing. Left at that, R2 would grow forever — slowly, invisibly, and
  # then past the 10 GB free tier some months from now.
  #
  # Sorting by name is sorting by time: STAMP is `date -u +%Y%m%dT%H%M%SZ`, so
  # lexical order is chronological order, with no dependence on what a listing
  # reports for mtime.
  rclone lsf "${R2_BUCKET}/${KIND}/" 2>/dev/null \
    | sort -r \
    | tail -n "+$((keep + 1))" \
    | while read -r stale; do
        [ -n "${stale}" ] || continue
        rclone deletefile "${R2_BUCKET}/${KIND}/${stale}"
        echo "pruned ${KIND}/${stale} from R2"
      done
fi
