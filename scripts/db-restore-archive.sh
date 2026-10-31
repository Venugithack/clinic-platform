#!/usr/bin/env bash
#
# Restore the archive that is actually stored, rather than a fresh dump.
#
# `scripts/db-restore-drill.sh` proves the dump-and-restore *path* works: it
# takes a new dump and puts it back. What it cannot tell you is whether the
# object sitting in R2 — the one somebody will reach for at 22:00 on the day
# the database is gone — is readable. Nobody has ever downloaded one, decrypted
# it and restored it. `docs/README.md` §6 calls that the gap worth closing
# first, and W9 in the backend programme register is the item.
#
# This script is that path, and it is deliberately the opposite shape to
# db-backup.sh:
#
#   * it never dumps. pg_dump is not called, and BACKUP_DB_URL is refused if it
#     is even present in the environment.
#   * it never writes to the bucket. rclone is called to list and to fetch one
#     object; there is no copy-to-remote, no delete, no prune, no sync.
#   * it never restores over anything. The target is a generated, validated,
#     loopback-only scratch database that did not exist a moment earlier and
#     does not exist a moment later.
#   * it never prints what it read. The report is schema names, table names and
#     counts; the decrypted SQL goes to psql and to nothing else.
#
# The same file runs against a real R2 remote in
# .github/workflows/archive-restore.yml and against a directory full of
# synthetic objects in the local rehearsal, because a rehearsal of a
# reimplementation only rehearses the reimplementation.
#
# ── WHAT A GREEN RUN ACTUALLY PROVES ──────────────────────────────────────
#
# Each stage proves one thing, and it is worth being exact, because the value
# of this script is entirely in not overclaiming:
#
#   size/metadata     that the transfer produced as many bytes as the remote
#                     says it holds. If the remote listing also carried a
#                     checksum it is compared, and the report names where that
#                     checksum came from — on R2 it is the object's ETag, which
#                     is the MD5 only for an object stored as a single part.
#                     When no checksum is offered the report says so rather
#                     than implying one was checked.
#   age decryption    that the ciphertext is intact and was encrypted to the
#                     clinic's recipient. age authenticates its header with
#                     HMAC-SHA-256 and every 64 KiB chunk with
#                     ChaCha20-Poly1305 under STREAM, with a distinct flag on
#                     the final chunk, so a flipped bit, a spliced chunk and a
#                     truncated file are all refused rather than decrypted.
#                     It does NOT prove who uploaded the object: anybody
#                     holding the public recipient can produce a file that
#                     decrypts. Only a trusted stored digest or signature would
#                     prove that, and there is not one.
#   gzip -t           that the compressed stream is complete and its CRC32 and
#                     length agree with its contents.
#   psql restore      that the bytes are a loadable PostgreSQL dump, not merely
#                     a well-formed file, and that the objects in it build.
#   the SHA-256       a name for these exact bytes, so a later run can say it
#                     fetched the same object. On its own it proves identity,
#                     not provenance.
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 0. Refuse an environment that carries the writer's authority ───────────
#
# The backup workflow's credentials can delete every object in the bucket, and
# its database URL points at the clinic. Neither has any business in a restore
# proof, and the cheapest way to be sure they were not used is to refuse to
# start when they are present at all. This is not distrust of this file's own
# code; it is about the thing somebody adds to it in a year.
for forbidden in \
  BACKUP_DB_URL \
  DATABASE_URL \
  R2_BUCKET \
  R2_ACCESS_KEY_ID \
  R2_SECRET_ACCESS_KEY \
  RCLONE_CONFIG_R2_ACCESS_KEY_ID \
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY
do
  if [ -n "${!forbidden:-}" ]; then
    echo "REFUSED: ${forbidden} is set." >&2
    echo "  This is the read-only archive restore proof. It never dumps and never" >&2
    echo "  writes to the bucket, so it must not be handed the backup writer's" >&2
    echo "  credentials or the clinic's database URL. Use the dedicated read-only" >&2
    echo "  R2_RESTORE_* values; see docs/operations/ROLLOUT.md section 8.1." >&2
    exit 64
  fi
done

# Sourced only after the check above, and only for the PostgreSQL defaults:
# PGHOST, PGPORT and PGUSER have to resolve the same way here as they do in
# db-backup.sh and db-restore-drill.sh, because on a GitHub runner db-start.sh
# initdb's the cluster with the runner's own account as superuser while in the
# postgres:17 container it uses `postgres`. Getting that wrong is a connection
# refused halfway through a proof.
# shellcheck source=scripts/db-env.sh
source "${SCRIPT_DIR}/db-env.sh"

PROOF_STAGE="start"

fail() {
  local stage="$1"; shift
  echo "ARCHIVE RESTORE PROOF FAILED (${stage}): $*" >&2
  exit 1
}

# ── 1. What we were asked for ──────────────────────────────────────────────
ARCHIVE_KIND="${ARCHIVE_KIND:-daily}"
ARCHIVE_OBJECT="${ARCHIVE_OBJECT:-}"
RESTORE_BUCKET="${R2_RESTORE_BUCKET:-}"
PROOF_REPORT="${ARCHIVE_PROOF_REPORT:-}"

case "${ARCHIVE_KIND}" in
  hourly|daily|monthly) ;;
  *) fail selection "retention kind must be hourly, daily or monthly; got '${ARCHIVE_KIND}'." ;;
esac

[ -n "${RESTORE_BUCKET}" ] || fail selection \
  "R2_RESTORE_BUCKET is not set. It is the rclone destination holding the retention prefixes: 'r2restore:<bucket>' for R2, or a directory for the local rehearsal."

for tool in rclone age gzip psql sha256sum stat; do
  command -v "${tool}" >/dev/null 2>&1 || fail tooling "${tool} is not installed."
done

# ── 2. The identity, which never reaches a log ─────────────────────────────
#
# BACKUP_AGE_RECIPIENT is the PUBLIC key the backup encrypts to. It cannot
# decrypt anything, and handing it to `age -d` produces a confusing failure
# several steps later. Refuse it here by name, so the person reading the error
# knows which of the two values they are holding.
IDENTITY_SOURCE=""
if [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ]; then
  [ -r "${BACKUP_AGE_IDENTITY_FILE}" ] || fail decrypt "BACKUP_AGE_IDENTITY_FILE is not readable."
  IDENTITY_SOURCE="file"
elif [ -n "${BACKUP_AGE_IDENTITY:-}" ]; then
  IDENTITY_SOURCE="env"
else
  fail decrypt "BACKUP_AGE_IDENTITY (or BACKUP_AGE_IDENTITY_FILE) is not set. This is the PRIVATE age identity, not BACKUP_AGE_RECIPIENT."
fi

# ── 3. The restore target, settled before any database command ─────────────
# PGHOST, PGPORT and PGUSER come from db-env.sh above, which honours anything
# already exported. Only PGDATABASE is ignored: nothing here connects to it.
case "${PGHOST}" in
  127.0.0.1|localhost|::1|0.0.0.0) ;;
  *) fail target "the PostgreSQL target must be on this machine; PGHOST is '${PGHOST}'. A restore proof has no business dialling anything else." ;;
esac

# The same allowlist scripts/staging/guard.mjs applies to every other entry
# point in this repository, written again here because bash cannot import it.
# Keep the two in step.
SCRATCH_NAME_PATTERN='^clinic_restore_drill(_[a-z0-9_]+)?$'

validate_scratch_name() {
  local name="${1:-}"
  [ -n "${name}" ] || fail target "the scratch database name is empty."
  case "${name}" in
    clinic|clinic_staging|postgres|template0|template1)
      fail target "refusing '${name}' as a restore target: that is the clinic, the ordinary staging database, or a system database." ;;
  esac
  [[ "${name}" =~ ${SCRATCH_NAME_PATTERN} ]] || fail target \
    "refusing '${name}' as a restore target: a restore proof may only build a database named clinic_restore_drill, optionally with a _suffix."
}

if [ -n "${SCRATCH_DB:-}" ]; then
  validate_scratch_name "${SCRATCH_DB}"
else
  SCRATCH_DB="clinic_restore_drill_archive_$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')"
  validate_scratch_name "${SCRATCH_DB}"
fi
# Exported rather than passed as a `VAR=value command` prefix further down,
# because a prefix assignment to a readonly variable is a fatal bash error.
export SCRATCH_DB
readonly SCRATCH_DB
SCRATCH_CREATED=0

# An existing database of that name is somebody else's: a collision on the
# generated name, or a drill that is still running. Refuse rather than drop it.
#
# The query arrives on stdin, not through -c, and that is load-bearing: psql
# performs variable interpolation in its lexer, which -c does not run. Written
# as `-c "... :'db'"` this check raises a syntax error, the error is swallowed,
# no row comes back, and the script concludes the database is free — a check
# that fails OPEN on the one question where failing open means dropping
# somebody else's database. It did, until the rehearsal caught it.
if printf "%s\n" "select 1 from pg_database where datname = :'db'" \
    | psql -tAX -v ON_ERROR_STOP=1 -d postgres -v db="${SCRATCH_DB}" 2>/dev/null \
    | grep -q '^1$'; then
  fail target "the database '${SCRATCH_DB}' already exists. Refusing to drop it or restore over a database this run did not create."
fi

# ── 4. Private scratch space, removed however this ends ────────────────────
TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/clinic-archive-restore.XXXXXXXX")"
chmod 700 "${TMPROOT}"

cleanup() {
  local status=$?
  set +e
  if [ "${SCRATCH_CREATED}" -eq 1 ]; then
    # Re-resolve and re-validate immediately before the drop. The name has been
    # readonly since it was generated; this is the check that has to hold at the
    # moment the destructive statement is issued, not merely earlier.
    local target="${SCRATCH_DB}"
    if [[ "${target}" =~ ${SCRATCH_NAME_PATTERN} ]] \
      && [ "${target}" != "clinic" ] \
      && [ "${target}" != "clinic_staging" ] \
      && [ "${target}" != "postgres" ]; then
      psql -q -d postgres -c "drop database if exists ${target} with (force)" >/dev/null 2>&1
    else
      echo "NOT dropping '${target}': it is not a validated scratch database name." >&2
    fi
  fi
  if [ -n "${TMPROOT:-}" ] && [ -d "${TMPROOT}" ]; then
    find "${TMPROOT}" -type f -exec rm -f {} + 2>/dev/null
    rm -rf "${TMPROOT}" 2>/dev/null
  fi
  exit "${status}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Checked after the trap is armed, not before: refusing the directory is no use
# if refusing it leaves the directory behind inside the repository.
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
case "${TMPROOT}" in
  "${REPO_ROOT}"/*) fail tooling "the temporary directory landed inside the repository. Decrypted clinic data must never be written there. Set TMPDIR somewhere else." ;;
esac

IDENTITY_FILE="${TMPROOT}/identity"
if [ "${IDENTITY_SOURCE}" = "file" ]; then
  cat "${BACKUP_AGE_IDENTITY_FILE}" > "${IDENTITY_FILE}"
else
  printf '%s\n' "${BACKUP_AGE_IDENTITY}" > "${IDENTITY_FILE}"
fi
chmod 600 "${IDENTITY_FILE}"

if ! grep -q -e 'AGE-SECRET-KEY-1' -e 'BEGIN OPENSSH PRIVATE KEY' "${IDENTITY_FILE}"; then
  if grep -q '^age1' "${IDENTITY_FILE}"; then
    fail decrypt "that is BACKUP_AGE_RECIPIENT, the public key the backup encrypts TO. It cannot decrypt. BACKUP_AGE_IDENTITY is the private half and starts AGE-SECRET-KEY-1."
  fi
  fail decrypt "BACKUP_AGE_IDENTITY does not look like an age identity or an SSH private key."
fi

# ── 5. Choosing exactly one object, and never more than one ────────────────
#
# db-backup.sh writes clinic-<UTC stamp>.sql.gz.age and nothing else. The
# pattern below is that filename and only that filename, which is what makes
# every one of the interesting refusals fall out of one check: a name with a
# slash, a '..', a space, a semicolon, a control character, an empty string or
# any other extension simply is not this.
OBJECT_PATTERN='^clinic-[0-9]{8}T[0-9]{6}Z\.sql\.gz\.age$'

reject_object_name() {
  local name="$1" why="$2"
  fail selection "refusing object name '${name}': ${why}"
}

validate_object_name() {
  local name="$1"
  [ -n "${name}" ] || fail selection "an empty object name was given."
  [ "${#name}" -le 64 ] || reject_object_name "${name}" "it is longer than any name this backup writes."
  if printf '%s' "${name}" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    reject_object_name '<name containing control characters>' "it contains control characters."
  fi
  case "${name}" in
    */*|*\\*) reject_object_name "${name}" "it names a path. An object is selected inside one retention prefix and may not cross into another." ;;
    *..*)     reject_object_name "${name}" "it contains '..'." ;;
  esac
  if printf '%s' "${name}" | LC_ALL=C grep -q '[^A-Za-z0-9._-]'; then
    reject_object_name "${name}" "it contains a character outside A-Z a-z 0-9 . _ -"
  fi
  case "${name}" in
    *.sql.gz) reject_object_name "${name}" "it is not encrypted. Every object this clinic stores is age-encrypted and ends .sql.gz.age; refusing to restore a plaintext database out of a bucket." ;;
  esac
  [[ "${name}" =~ ${OBJECT_PATTERN} ]] || reject_object_name "${name}" \
    "it does not match this repository's backup naming convention, clinic-YYYYMMDDTHHMMSSZ.sql.gz.age."
}

# Listing only. `lsf` is non-recursive, --files-only drops directory entries,
# and the format is path|size|md5, so nothing here has to parse JSON in bash.
LIST_STATUS=0
LISTING=""

# Sets LISTING and LIST_STATUS in the caller's shell rather than printing, so
# that the exit status survives. A command substitution is a subshell and would
# lose it — which is exactly how the diagnostic below came to be unreachable on
# its first draft.
list_prefix() {
  LISTING="$(rclone lsf --files-only --format "psh" --separator "|" --hash md5 "$1" 2>/dev/null)" \
    && LIST_STATUS=0 || LIST_STATUS=$?
}

# Told apart deliberately. A prefix that exists and holds nothing this script
# recognises is a different problem from a remote that would not answer, and on
# the one authorized R2 run the difference is "the backup is not there" versus
# "the token is wrong". rclone exits 0 on an empty bucket prefix.
listing_failed() {
  [ "${LIST_STATUS}" -ne 0 ] && fail selection \
    "rclone could not list the ${ARCHIVE_KIND} prefix (exit ${LIST_STATUS}). Check the read-only credentials, the endpoint and the bucket name. Nothing was downloaded."
  return 0
}

PREFIX="${RESTORE_BUCKET%/}/${ARCHIVE_KIND}"

if [ -n "${ARCHIVE_OBJECT}" ]; then
  validate_object_name "${ARCHIVE_OBJECT}"
  list_prefix "${PREFIX}/${ARCHIVE_OBJECT}"
  [ -n "${LISTING}" ] || fail selection \
    "no object named '${ARCHIVE_OBJECT}' exists in the ${ARCHIVE_KIND} prefix (rclone exit ${LIST_STATUS})."
  SELECTED_LINE="${LISTING%%$'\n'*}"
else
  # The loop reads a here-string, not a process substitution. A `$(...)` result
  # has its trailing newline stripped, and `while read` does not run its body
  # for a final line that has none — which, in a prefix holding exactly one
  # object, is the object. That is a backup silently invisible to its own
  # restore, and it is what this comment is here to stop coming back.
  list_prefix "${PREFIX}/"
  listing_failed
  CANDIDATES=""
  while IFS= read -r line; do
    [ -n "${line}" ] || continue
    candidate="${line%%|*}"
    [[ "${candidate}" =~ ${OBJECT_PATTERN} ]] || continue
    CANDIDATES="${CANDIDATES}${line}"$'\n'
  done <<< "${LISTING}"
  [ -n "${CANDIDATES}" ] || fail selection \
    "the ${ARCHIVE_KIND} prefix holds no object matching clinic-YYYYMMDDTHHMMSSZ.sql.gz.age. Refusing to guess at anything else that is in there."
  # The stamp is UTC and fixed width, so ascending name order is ascending time
  # order and the newest valid object is the last line.
  SELECTED_LINE="$(printf '%s' "${CANDIDATES}" | LC_ALL=C sort | tail -n 1)"
fi

# Pinned here. Everything below uses these three values and never re-lists.
IFS='|' read -r _object _size _md5 <<< "${SELECTED_LINE}"
readonly SELECTED_OBJECT="${_object}"
readonly REMOTE_SIZE="${_size}"
readonly REMOTE_MD5="${_md5:-}"
validate_object_name "${SELECTED_OBJECT}"

[[ "${REMOTE_SIZE}" =~ ^[0-9]+$ ]] || fail selection "the remote listing gave no usable size for '${SELECTED_OBJECT}'."
[ "${REMOTE_SIZE}" -gt 0 ] || fail integrity \
  "the stored object '${SELECTED_OBJECT}' is zero bytes. There is nothing in it to restore, and a backup that size is a failure that was uploaded."

# Where the comparison checksum came from decides what it is worth, so the
# report says which. An rclone remote is 'name:path'; anything else is a
# directory on this machine, which is the local rehearsal.
if [[ "${RESTORE_BUCKET}" =~ ^[A-Za-z0-9_-]+: ]]; then
  REMOTE_KIND="rclone remote"
  CHECKSUM_ORIGIN="the object's ETag as reported by the remote (an MD5 only for a single-part upload, absent for a multipart one)"
else
  REMOTE_KIND="local directory (rehearsal)"
  CHECKSUM_ORIGIN="rclone reading the source file on this machine, which is a rehearsal stand-in and not a remote attestation"
fi

# ── 6. One download, into private space ────────────────────────────────────
DOWNLOADED="${TMPROOT}/${SELECTED_OBJECT}"
# rclone's own stderr is not forwarded: it echoes the remote path it was
# working on, and the bucket is not something the report carries. The exit
# status says enough to tell a credential problem from a missing object.
DOWNLOAD_STATUS=0
rclone copyto "${PREFIX}/${SELECTED_OBJECT}" "${DOWNLOADED}" >/dev/null 2>&1 \
  || DOWNLOAD_STATUS=$?
# Captured on the command itself. Inside `if ! cmd; then ... fi`, `$?` is the
# status of the negation — which is zero, every time — so an exit code read
# there reports success on the failure path.
[ "${DOWNLOAD_STATUS}" -eq 0 ] || fail download \
  "rclone could not download '${SELECTED_OBJECT}' from the ${ARCHIVE_KIND} prefix (exit ${DOWNLOAD_STATUS})."
[ -f "${DOWNLOADED}" ] || fail download "rclone reported success but wrote no file."
chmod 600 "${DOWNLOADED}"

DOWNLOADED_SIZE="$(stat -c %s "${DOWNLOADED}")"
[ "${DOWNLOADED_SIZE}" -gt 0 ] || fail integrity \
  "the downloaded object is zero bytes. The transfer produced nothing."
[ "${DOWNLOADED_SIZE}" -eq "${REMOTE_SIZE}" ] || fail integrity \
  "size mismatch: the remote lists ${REMOTE_SIZE} bytes and ${DOWNLOADED_SIZE} arrived. The transfer was incomplete, or the object changed under it."

DOWNLOADED_SHA256="$(sha256sum "${DOWNLOADED}" | cut -d' ' -f1)"

CHECKSUM_RESULT="none was offered by the remote listing, so only the byte count was compared"
if [ -n "${REMOTE_MD5}" ]; then
  LOCAL_MD5="$(md5sum "${DOWNLOADED}" 2>/dev/null | cut -d' ' -f1 || true)"
  if [ -n "${LOCAL_MD5}" ]; then
    [ "${LOCAL_MD5}" = "${REMOTE_MD5}" ] || fail integrity \
      "checksum mismatch between the listed object and the bytes that arrived."
    CHECKSUM_RESULT="MD5 matched, from ${CHECKSUM_ORIGIN}"
  fi
fi

# ── 7. Decrypt, then check the compressed stream, both before any SQL runs ─
PLAINTEXT="${TMPROOT}/archive.sql.gz"
if ! age -d -i "${IDENTITY_FILE}" -o "${PLAINTEXT}" "${DOWNLOADED}" 2>"${TMPROOT}/age.err"; then
  # age's own message names the reason — no matching identity, or a failed
  # authentication tag — and carries nothing from inside the file.
  AGE_ERR="$(tr -d '\r' < "${TMPROOT}/age.err" | tail -n 3 | tr '\n' ' ')"
  fail decrypt "age refused the object: ${AGE_ERR:-no detail}. Either the identity does not match the recipient the backup encrypted to, or the ciphertext has been altered or truncated."
fi
chmod 600 "${PLAINTEXT}"
[ -s "${PLAINTEXT}" ] || fail decrypt "decryption produced an empty file."

gzip -t "${PLAINTEXT}" 2>/dev/null \
  || fail integrity "the decrypted stream is not a complete gzip file. Its CRC or length does not agree with its contents."

PLAINTEXT_SIZE="$(stat -c %s "${PLAINTEXT}")"

# ── 8. Restore, using the drill this repository already has ────────────────
#
# scripts/db-restore-drill.sh already creates the scratch database, installs
# the three Supabase roles the dump grants to, handles the `CREATE SCHEMA
# public` collision, and asserts that jmc came back. Given an explicit file it
# takes no dump and never reads BACKUP_DB_URL. RESTORE_DRILL_KEEP hands the
# database's lifetime to this script, which needs it alive for section 9 and
# drops it in the trap above.
SCRATCH_CREATED=1
if ! RESTORE_DRILL_KEEP=1 \
     "${SCRIPT_DIR}/db-restore-drill.sh" "${PLAINTEXT}" > "${TMPROOT}/restore.log" 2>&1; then
  # The log is NOT printed, and that is deliberate rather than unhelpful. When
  # psql refuses a statement it quotes the statement back, and a statement out
  # of a clinic dump is a row of the clinic's data — a COPY line carrying a
  # patient's name lands in the CI log and stays there. So the failure is
  # described by shape only: how many errors, and how far into the dump the
  # first one was. Both are content-free, and the line number is the part that
  # actually tells you where to look.
  ERROR_LINES="$(grep -c 'ERROR:' "${TMPROOT}/restore.log" 2>/dev/null || true)"
  DUMP_LINE="$(sed -n 's/^psql:[^:]*:\([0-9][0-9]*\): ERROR:.*/\1/p' "${TMPROOT}/restore.log" 2>/dev/null | head -n 1)"
  fail restore "PostgreSQL did not load the decrypted dump cleanly: ${ERROR_LINES:-0} error line(s)${DUMP_LINE:+, the first at line ${DUMP_LINE} of the dump}. The output is withheld on purpose — psql quotes the statement it refused, and a statement out of this dump is a row of clinic data."
fi

# ── 9. Structural and count-only validation ────────────────────────────────
#
# Every query below answers a question about shape or quantity. None of them
# selects a column of clinic data, and the report carries only what they
# return: schema names, table names, counts.
scratch_query() {
  psql -tAX -v ON_ERROR_STOP=1 -d "${SCRATCH_DB}" -c "$1"
}

ARCHIVED_SCHEMAS="public app jmc"

RESTORED_SCHEMAS="$(scratch_query "
  select string_agg(nspname, ' ' order by nspname)
    from pg_namespace
   where nspname not like 'pg\\_%'
     and nspname <> 'information_schema'")" \
  || fail validation "could not read the restored schema list."

for schema in ${RESTORED_SCHEMAS}; do
  case " ${ARCHIVED_SCHEMAS} " in
    *" ${schema} "*) ;;
    *) fail validation "the restore contains schema '${schema}', which the backup does not archive. Either the dump is not this clinic's, or the schema selection has changed." ;;
  esac
done

case " ${RESTORED_SCHEMAS} " in
  *" jmc "*) ;;
  *) fail validation "the active jmc schema is not in the restore." ;;
esac

scratch_query "select to_regclass('jmc.clinic_revision') is not null" | grep -qx 't' \
  || fail validation "jmc.clinic_revision is missing. That table is the clinic's revision counter, and its absence means the active schema did not come back."

# The load-bearing tables. This is deliberately not all eighty-three: a list
# that has to be edited every time a migration adds a table is a list that gets
# edited to make the drill pass. These are the ones whose absence means the
# archive is not a clinic.
REQUIRED_TABLES="clinic_revision staff patients encounters prescriptions prescription_lines dispenses invoices payments medicines batches stock_movements audit_events sessions"
MISSING=""
for table in ${REQUIRED_TABLES}; do
  if ! scratch_query "select to_regclass('jmc.${table}') is not null" | grep -qx 't'; then
    MISSING="${MISSING} ${table}"
  fi
done
[ -z "${MISSING}" ] || fail validation "the restore is missing jmc tables:${MISSING}"

TABLE_COUNT="$(scratch_query "
  select count(*)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('app','jmc','public') and c.relkind in ('r','p')")"
[ "${TABLE_COUNT}" -gt 0 ] || fail validation "the restore contains no tables at all."

# Every table is counted, which is the cheapest full read that proves each
# relation is present and scannable rather than merely declared. The counts are
# summed; no individual table's contents leave this loop, even as a number.
TOTAL_ROWS=0
UNCOUNTABLE=""
while IFS= read -r qualified; do
  [ -n "${qualified}" ] || continue
  if rows="$(scratch_query "select count(*) from ${qualified}" 2>/dev/null)" && [[ "${rows}" =~ ^[0-9]+$ ]]; then
    TOTAL_ROWS=$((TOTAL_ROWS + rows))
  else
    UNCOUNTABLE="${UNCOUNTABLE} ${qualified}"
  fi
done < <(scratch_query "
  select format('%I.%I', n.nspname, c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('app','jmc','public') and c.relkind in ('r','p')
   order by n.nspname, c.relname")
[ -z "${UNCOUNTABLE}" ] || fail validation "these restored tables could not be counted:${UNCOUNTABLE}"

[ "${TOTAL_ROWS}" -gt 0 ] || fail validation \
  "every table in the restore is empty. The archive is structurally sound and holds no data, which is not a backup."

# History evidence, as far as the archive carries any. Supabase keeps its
# migration ledger in `supabase_migrations`, which db-backup.sh does not dump —
# it selects public, app and jmc — so on a clinic archive this is absent, and
# the report says so instead of inventing a version. jmc.clinic_revision is the
# history marker the archive does carry.
MIGRATION_EVIDENCE="not in the archive (the backup dumps public, app and jmc; Supabase keeps its migration ledger in supabase_migrations)"
if scratch_query "select to_regclass('supabase_migrations.schema_migrations') is not null" | grep -qx 't'; then
  MIGRATION_EVIDENCE="max schema_migrations version $(scratch_query "select coalesce(max(version), '(none)') from supabase_migrations.schema_migrations")"
fi
CLINIC_REVISION="$(scratch_query "select coalesce(max(revision), 0) from jmc.clinic_revision")"

PROOF_STAGE="complete"
PROVED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── 10. The report ─────────────────────────────────────────────────────────
if [ -n "${ARCHIVE_OBJECT}" ]; then
  SELECTION_MODE="explicit object name"
else
  SELECTION_MODE="newest valid object in the prefix"
fi

report() {
  cat <<REPORT
Archive restore proof
=====================
result                   PASS (stage: ${PROOF_STAGE})
retention kind           ${ARCHIVE_KIND}
selection                ${SELECTION_MODE}
object basename          ${SELECTED_OBJECT}
source                   ${REMOTE_KIND} (name withheld)
remote size              ${REMOTE_SIZE} bytes
downloaded size          ${DOWNLOADED_SIZE} bytes
remote checksum          ${CHECKSUM_RESULT}
encrypted object SHA-256 ${DOWNLOADED_SHA256}
decrypted size           ${PLAINTEXT_SIZE} bytes (gzip stream verified)
restored schemas         ${RESTORED_SCHEMAS}
tables restored          ${TABLE_COUNT}
rows across all tables   ${TOTAL_ROWS}
jmc.clinic_revision      max revision ${CLINIC_REVISION}
migration history        ${MIGRATION_EVIDENCE}
scratch database         ${SCRATCH_DB} (loopback, created by this run, dropped on exit)
proved at                ${PROVED_AT}

What this proves
----------------
- The transfer delivered the byte count the remote reports, and as for a
  checksum: ${CHECKSUM_RESULT}.
- age decrypted it with the clinic's identity. age authenticates its header
  with HMAC-SHA-256 and each 64 KiB chunk with ChaCha20-Poly1305 under STREAM,
  with a distinct final-chunk flag, so an altered, spliced or truncated
  ciphertext is refused rather than decrypted.
- The decrypted stream is a complete gzip file: gzip -t agrees with its CRC and
  its length.
- PostgreSQL 17 loaded it without error, the active jmc schema and
  jmc.clinic_revision are present, the restore holds nothing outside the
  schemas the backup archives, and every restored table was counted.

What this does NOT prove
------------------------
- Who uploaded the object. Anybody holding the public recipient can produce a
  file that decrypts with this identity. The SHA-256 above names these exact
  bytes so a later run can say it fetched the same ones, but there is no
  trusted stored digest or signature to check it against.
- That any other object in the bucket is readable. One object was fetched.
- Anything about the contents. Nothing above reads a column of clinic data.
REPORT
}

report
if [ -n "${PROOF_REPORT}" ]; then
  report > "${PROOF_REPORT}"
  chmod 600 "${PROOF_REPORT}"
  echo "report written to ${PROOF_REPORT}"
fi
