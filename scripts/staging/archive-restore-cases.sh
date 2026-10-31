#!/usr/bin/env bash
#
# The local rehearsal of scripts/db-restore-archive.sh, and its regression
# suite. Runs inside the container scripts/staging/archive-restore-rehearsal.mjs
# builds; see that file for why it is a container at all.
#
# Nothing here reaches a network. The "bucket" is a directory, rclone addresses
# it as a local remote, the age identity is generated per run and thrown away,
# the archive is built from the synthetic staging fixtures by the real
# scripts/db-backup.sh, and the restore target is a PostgreSQL 17 started on
# this container's own loopback address.
#
# ── THE ONE THING THIS SUITE HAS TO PROVE ─────────────────────────────────
#
# It would be easy to write a rehearsal that passes because the script restored
# the dump that was sitting on disk next to it, which is exactly the flaw in
# the nightly drill that W9 exists to fix. So the bucket holds two objects
# built from one dump: an older one that is the dump, and a newer one that is
# the dump plus a marker table that exists nowhere else. Every copy outside the
# bucket is deleted before the first case runs. Then:
#
#   * selecting the newest object restores N+1 tables,
#   * selecting the older one by name restores N,
#   * and each run's reported SHA-256 equals the SHA-256 of the object it
#     claims to have fetched.
#
# A run that read a local dump instead could satisfy none of those.
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d /tmp/archive-rehearsal.XXXXXXXX)"
BUCKET="${WORK}/bucket"
SHIM_DIR="${WORK}/bin"
SHIM_LOG="${WORK}/rclone-and-psql.log"
RUN_TMP="${WORK}/tmp"
OUT="${WORK}/stdout"
ERR="${WORK}/stderr"

STAGING_URL="${REHEARSAL_SOURCE_URL:-}"

PASSED=0
FAILED=0
FAILURES=""

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

ok()   { PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$1"; }
bad()  {
  FAILED=$((FAILED + 1))
  FAILURES="${FAILURES}  - $1: $2"$'\n'
  printf '  FAIL %s\n       %s\n' "$1" "$2"
}

check() { # check <name> <condition-description> <0|1 result>
  if [ "$3" -eq 0 ]; then ok "$1"; else bad "$1" "$2"; fi
}

cleanup_all() {
  pg_ctl_stop
  rm -rf "${WORK}" 2>/dev/null
}
# Replaced once the server is actually running; until then, stopping it is a
# no-op. Called only through the EXIT trap, which shellcheck cannot see.
# shellcheck disable=SC2329
pg_ctl_stop() { :; }
trap cleanup_all EXIT

mkdir -p "${BUCKET}/hourly" "${BUCKET}/daily" "${BUCKET}/monthly" "${SHIM_DIR}" "${RUN_TMP}"

# ──────────────────────────────────────────────────────────────────────────
# Setup 1: the recording shims
#
# `rclone` and `psql` on the script's PATH are wrappers that append their
# arguments to a log and then exec the real binary. That turns two of the
# required assertions from "grep the source for a forbidden word" into "look
# at what it actually ran": no rclone subcommand that writes, and not one
# database command before a non-loopback target is refused.
#
# The rclone wrapper also carries the only fault injection in this suite.
# ARCHIVE_TEST_TRUNCATE makes a download arrive one byte short, which is the
# single failure a directory cannot produce on its own and which the size
# comparison exists to catch.
# ──────────────────────────────────────────────────────────────────────────
REAL_RCLONE="$(command -v rclone)"
REAL_PSQL="$(command -v psql)"

cat > "${SHIM_DIR}/rclone" <<'SHIM'
#!/usr/bin/env bash
printf 'rclone %s\n' "$*" >> "${SHIM_LOG}"
"${REAL_RCLONE}" "$@"
status=$?
if [ "${ARCHIVE_TEST_TRUNCATE:-}" = "1" ] && [ "${1:-}" = "copyto" ] && [ "${status}" -eq 0 ]; then
  dest="${3:-}"
  if [ -f "${dest}" ]; then
    size=$(stat -c %s "${dest}")
    truncate -s $((size - 1)) "${dest}"
  fi
fi
exit "${status}"
SHIM

cat > "${SHIM_DIR}/psql" <<'SHIM'
#!/usr/bin/env bash
printf 'psql %s\n' "$*" >> "${SHIM_LOG}"
exec "${REAL_PSQL}" "$@"
SHIM

chmod +x "${SHIM_DIR}/rclone" "${SHIM_DIR}/psql"

# ──────────────────────────────────────────────────────────────────────────
# Setup 2: a PostgreSQL 17 on this container's loopback, and two throwaway
# age identities.
# ──────────────────────────────────────────────────────────────────────────
step "Starting a disposable PostgreSQL 17 and generating throwaway age identities"
# PG_BIN is pinned rather than left to scripts/db-env.sh's default, which
# derives it from PG_VERSION. The postgres:17 image sets PG_VERSION to the full
# Debian package version — 17.11-1.pgdg13+2 — and the server lives in
# /usr/lib/postgresql/17/bin regardless. On a CI runner, where PG_VERSION is
# unset, db-env.sh's own default resolves to the same directory.
export PG_BIN=/usr/lib/postgresql/17/bin
"${REPO}/scripts/db-start.sh" >/dev/null || { say "could not start PostgreSQL"; exit 1; }
pg_ctl_stop() {
  PGDATA=/var/lib/postgresql/clinic-pgdata \
    setpriv --reuid=postgres --regid=postgres --clear-groups \
    /usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/postgresql/clinic-pgdata -m immediate stop >/dev/null 2>&1
}

export PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres

age-keygen -o "${WORK}/identity-good" 2>/dev/null
age-keygen -o "${WORK}/identity-wrong" 2>/dev/null
chmod 600 "${WORK}/identity-good" "${WORK}/identity-wrong"
GOOD_RECIPIENT="$(age-keygen -y "${WORK}/identity-good")"
say "identities generated (never printed)"

# ──────────────────────────────────────────────────────────────────────────
# Setup 3: build the stored objects with the real backup script
# ──────────────────────────────────────────────────────────────────────────
step "Building the stored objects from the synthetic staging fixtures"
[ -n "${STAGING_URL}" ] || { say "REHEARSAL_SOURCE_URL is not set"; exit 1; }

BUILD="${WORK}/build"
mkdir -p "${BUILD}"

# The real scripts/db-backup.sh, with no R2_BUCKET and no age recipient, so it
# writes one plaintext dump and uploads nothing. This is the same three-schema
# selection the clinic's nightly backup uses.
BACKUP_DIR="${BUILD}" BACKUP_DB_URL="${STAGING_URL}" \
  "${REPO}/scripts/db-backup.sh" drill >/dev/null || { say "db-backup.sh failed"; exit 1; }
DUMPS=( "${BUILD}"/drill/*.sql.gz )
DUMP="${DUMPS[0]}"
[ -s "${DUMP}" ] || { say "no dump produced"; exit 1; }

# The marker. It exists in the newer object and in no other file anywhere, so
# a restore that contains it can only have come from the bucket.
MARKER="archive_rehearsal_marker_$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')"
{
  printf 'create table jmc.%s (checked boolean not null default true);\n' "${MARKER}"
  printf 'insert into jmc.%s (checked) values (true);\n' "${MARKER}"
} | gzip -9 > "${BUILD}/marker.sql.gz"

cat "${DUMP}" "${BUILD}/marker.sql.gz" > "${BUILD}/marked.sql.gz"

OLDER_NAME="clinic-20260101T000000Z.sql.gz.age"
NEWER_NAME="clinic-20260102T000000Z.sql.gz.age"

age -r "${GOOD_RECIPIENT}" -o "${BUCKET}/hourly/${OLDER_NAME}" "${DUMP}"
age -r "${GOOD_RECIPIENT}" -o "${BUCKET}/hourly/${NEWER_NAME}" "${BUILD}/marked.sql.gz"

# The decoys. Every one of them sorts AFTER the newest valid object, so a
# selection that does not filter by name would pick one of them.
printf 'not a backup\n' > "${BUCKET}/hourly/notes.txt"
cp "${BUCKET}/hourly/${NEWER_NAME}" "${BUCKET}/hourly/zzz-clinic-20991231T235959Z.sql.gz.age"
cp "${DUMP}" "${BUCKET}/hourly/clinic-20260103T000000Z.sql.gz"
mkdir -p "${BUCKET}/hourly/sub"
cp "${BUCKET}/hourly/${NEWER_NAME}" "${BUCKET}/hourly/sub/clinic-20991231T235959Z.sql.gz.age"

# The monthly prefix holds one zero-byte object and nothing else. The daily
# prefix holds nothing at all.
: > "${BUCKET}/monthly/clinic-20260105T000000Z.sql.gz.age"

# The damaged objects, each in its own prefix-free name so a case can ask for
# it explicitly.
DAMAGED="${WORK}/damaged"
mkdir -p "${DAMAGED}/hourly"
cp "${BUCKET}/hourly/${NEWER_NAME}" "${DAMAGED}/hourly/clinic-20260201T000000Z.sql.gz.age"
printf '\xff\xff\xff\xff' | dd of="${DAMAGED}/hourly/clinic-20260201T000000Z.sql.gz.age" \
  bs=1 seek=400 conv=notrunc status=none

age -r "$(age-keygen -y "${WORK}/identity-wrong")" \
  -o "${DAMAGED}/hourly/clinic-20260202T000000Z.sql.gz.age" "${DUMP}"

head -c -8 "${DUMP}" > "${BUILD}/truncated.sql.gz"
age -r "${GOOD_RECIPIENT}" -o "${DAMAGED}/hourly/clinic-20260203T000000Z.sql.gz.age" "${BUILD}/truncated.sql.gz"

printf 'this is not sql at all;\n' | gzip -9 > "${BUILD}/notsql.sql.gz"
age -r "${GOOD_RECIPIENT}" -o "${DAMAGED}/hourly/clinic-20260204T000000Z.sql.gz.age" "${BUILD}/notsql.sql.gz"

OLDER_SHA="$(sha256sum "${BUCKET}/hourly/${OLDER_NAME}" | cut -d' ' -f1)"
NEWER_SHA="$(sha256sum "${BUCKET}/hourly/${NEWER_NAME}" | cut -d' ' -f1)"

# Every plaintext and every copy outside a bucket now goes. From here the only
# place these bytes exist is inside an object in a bucket directory.
rm -rf "${BUILD}"
say "stored objects built; every local dump deleted"

LEFTOVER_PLAINTEXT="$(find "${WORK}" -name '*.sql.gz' -not -path "${BUCKET}/*" -not -path "${DAMAGED}/*" 2>/dev/null | head -5)"

# ──────────────────────────────────────────────────────────────────────────
# The runner
# ──────────────────────────────────────────────────────────────────────────
STATUS=0

run_proof() { # run_proof <VAR=value>...
  : > "${SHIM_LOG}"
  rm -rf "${RUN_TMP:?}"/* 2>/dev/null
  env -i \
    PATH="${SHIM_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/postgresql/17/bin" \
    HOME=/root \
    TMPDIR="${RUN_TMP}" \
    SHIM_LOG="${SHIM_LOG}" \
    REAL_RCLONE="${REAL_RCLONE}" \
    REAL_PSQL="${REAL_PSQL}" \
    PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres \
    R2_RESTORE_BUCKET="${BUCKET}" \
    BACKUP_AGE_IDENTITY_FILE="${WORK}/identity-good" \
    "$@" \
    bash "${REPO}/scripts/db-restore-archive.sh" > "${OUT}" 2> "${ERR}"
  STATUS=$?
}

report_field() { sed -n "s/^$1 *//p" "${OUT}" | head -1; }

tmp_is_clean() {
  local leftovers
  leftovers="$(find "${RUN_TMP}" -mindepth 1 2>/dev/null | head -5)"
  [ -z "${leftovers}" ]
}

scratch_databases() {
  "${REAL_PSQL}" -tAX -d postgres -c \
    "select datname from pg_database where datname like 'clinic_restore_drill%' order by 1" 2>/dev/null
}

database_exists() {
  # On stdin, not through -c. psql does variable interpolation in its lexer and
  # -c does not run it, so the -c spelling of this raises a syntax error and
  # answers "no such database" to every question. That is how the same mistake
  # in db-restore-archive.sh stayed invisible for one run of this suite.
  printf "%s\n" "select 1 from pg_database where datname = :'db'" \
    | "${REAL_PSQL}" -tAX -d postgres -v db="$1" 2>/dev/null | grep -qx 1
}

expect_refusal() { # expect_refusal <case> <regex>
  local name="$1" pattern="$2"
  if [ "${STATUS}" -eq 0 ]; then
    bad "${name}" "the script succeeded; it was supposed to refuse"
    return
  fi
  if ! grep -qE "${pattern}" "${ERR}"; then
    bad "${name}" "refused, but not for the stated reason (wanted /${pattern}/): $(head -c 240 "${ERR}" | tr '\n' ' ')"
    return
  fi
  ok "${name}"
}

expect_clean_after_run() { # expect_clean_after_run <case>
  local name="$1"
  if tmp_is_clean; then ok "${name}: temporary files removed"
  else bad "${name}: temporary files removed" "$(find "${RUN_TMP}" -mindepth 1 | head -3 | tr '\n' ' ')"; fi
  local scratch
  scratch="$(scratch_databases | grep -v '^clinic_restore_drill_taken$' || true)"
  if [ -z "${scratch}" ]; then ok "${name}: scratch database removed"
  else bad "${name}: scratch database removed" "left behind: ${scratch}"; fi
}

# ──────────────────────────────────────────────────────────────────────────
step "1, 2, 4: the newest valid object is selected, downloaded, decrypted and restored"
run_proof ARCHIVE_KIND=hourly
if [ "${STATUS}" -ne 0 ]; then
  bad "1: a valid synthetic archive restores" "$(tail -c 400 "${ERR}" | tr '\n' ' ')"
  NEWER_TABLES=""
else
  ok "1: a valid synthetic archive restores"
  SELECTED="$(report_field 'object basename')"
  check "4: the newest VALID object is chosen, decoys ignored" \
    "selected '${SELECTED}', wanted '${NEWER_NAME}'" \
    "$([ "${SELECTED}" = "${NEWER_NAME}" ] && echo 0 || echo 1)"
  REPORTED_SHA="$(report_field 'encrypted object SHA-256')"
  check "2a: the reported SHA-256 is the stored object's" \
    "reported ${REPORTED_SHA}, stored ${NEWER_SHA}" \
    "$([ "${REPORTED_SHA}" = "${NEWER_SHA}" ] && echo 0 || echo 1)"
  NEWER_TABLES="$(report_field 'tables restored')"
  # Printed in full, because this is the shape of the report the owner will
  # read after the authorized R2 run and it should hold no surprises. Case 23
  # below asserts that it carries nothing secret or identifying.
  printf '\n  --- the proof report, as the real run will print it ---\n'
  sed 's/^/  | /' "${OUT}"
  printf '\n'
fi
expect_clean_after_run "19/21"

# ──────────────────────────────────────────────────────────────────────────
step "3, 2b: an explicit object name selects that object and nothing else"
run_proof ARCHIVE_KIND=hourly ARCHIVE_OBJECT="${OLDER_NAME}"
if [ "${STATUS}" -ne 0 ]; then
  bad "3: an explicit valid object name works" "$(tail -c 400 "${ERR}" | tr '\n' ' ')"
  OLDER_TABLES=""
else
  ok "3: an explicit valid object name works"
  SELECTED="$(report_field 'object basename')"
  check "3b: it selected the object it was asked for" \
    "selected '${SELECTED}'" "$([ "${SELECTED}" = "${OLDER_NAME}" ] && echo 0 || echo 1)"
  REPORTED_SHA="$(report_field 'encrypted object SHA-256')"
  check "2b: the reported SHA-256 is that stored object's" \
    "reported ${REPORTED_SHA}, stored ${OLDER_SHA}" \
    "$([ "${REPORTED_SHA}" = "${OLDER_SHA}" ] && echo 0 || echo 1)"
  OLDER_TABLES="$(report_field 'tables restored')"
fi

step "2c: the restored bytes came from the stored object, not from a local dump"
if [ -n "${NEWER_TABLES}" ] && [ -n "${OLDER_TABLES}" ]; then
  check "2c: the marker table that exists only in the newer object was restored" \
    "newer restored ${NEWER_TABLES} tables, older ${OLDER_TABLES}; wanted exactly one more" \
    "$([ "${NEWER_TABLES}" -eq $((OLDER_TABLES + 1)) ] && echo 0 || echo 1)"
else
  bad "2c: the marker table that exists only in the newer object was restored" \
      "one of the two runs did not report a table count"
fi
check "2d: no plaintext dump survives outside the bucket to have been restored instead" \
  "found: ${LEFTOVER_PLAINTEXT}" "$([ -z "${LEFTOVER_PLAINTEXT}" ] && echo 0 || echo 1)"

# ──────────────────────────────────────────────────────────────────────────
step "24: the restore path issues no rclone write, delete or prune"
WRITES="$(grep -E '^rclone (copy|sync|move|moveto|delete|deletefile|purge|rmdir|rmdirs|mkdir|rcat|touch|settier|cleanup|backend)' "${SHIM_LOG}" \
  | grep -vE '^rclone copyto ' || true)"
check "24: no rclone subcommand that writes to the remote" "found: ${WRITES}" \
  "$([ -z "${WRITES}" ] && echo 0 || echo 1)"
COPYTO_DESTS="$(grep -E '^rclone copyto ' "${SHIM_LOG}" | awk '{print $NF}' || true)"
OUTSIDE=""
while IFS= read -r dest; do
  [ -n "${dest}" ] || continue
  case "${dest}" in "${RUN_TMP}"/*) ;; *) OUTSIDE="${OUTSIDE} ${dest}" ;; esac
done <<< "${COPYTO_DESTS}"
check "24b: every copyto wrote into the private temporary directory" "outside:${OUTSIDE}" \
  "$([ -z "${OUTSIDE}" ] && echo 0 || echo 1)"

# ──────────────────────────────────────────────────────────────────────────
step "4b, 4c: a prefix holding exactly one object, and a prefix that will not list"
# A prefix with one object is the case a `while read` over a `$(...)` result
# drops entirely, because the only line has no trailing newline. It looks
# exactly like an empty bucket, which is the most alarming way for a restore to
# fail. This ran red for real while the selection was being tightened.
SINGLE="${WORK}/single-bucket"
mkdir -p "${SINGLE}/daily"
cp "${BUCKET}/hourly/${OLDER_NAME}" "${SINGLE}/daily/${OLDER_NAME}"
run_proof ARCHIVE_KIND=daily R2_RESTORE_BUCKET="${SINGLE}"
if [ "${STATUS}" -eq 0 ]; then
  ok "4b: a prefix holding exactly one valid object selects it"
  SELECTED="$(report_field 'object basename')"
  check "4b2: and it is that object" "selected '${SELECTED}'" \
    "$([ "${SELECTED}" = "${OLDER_NAME}" ] && echo 0 || echo 1)"
else
  bad "4b: a prefix holding exactly one valid object selects it" "$(tail -c 300 "${ERR}" | tr '\n' ' ')"
  bad "4b2: and it is that object" "the run failed"
fi

# A remote that will not answer must not be reported as an empty bucket. On the
# one authorized R2 run, the difference is "the backup is not there" against
# "the token is wrong".
run_proof ARCHIVE_KIND=daily R2_RESTORE_BUCKET="${WORK}/no-such-bucket"
expect_refusal "4c: a prefix that cannot be listed is named as a listing failure" \
  "could not list the daily prefix"

step "5, 6: an empty prefix and a missing object both fail safely"
run_proof ARCHIVE_KIND=daily
expect_refusal "5: an empty prefix is refused" "holds no object matching"
expect_clean_after_run "5"

run_proof ARCHIVE_KIND=hourly ARCHIVE_OBJECT="clinic-20990101T000000Z.sql.gz.age"
expect_refusal "6: a missing object is refused" "no object named"
expect_clean_after_run "6"

# ──────────────────────────────────────────────────────────────────────────
step "7, 8, 9: names that must never be accepted"
run_proof ARCHIVE_KIND=hourly ARCHIVE_OBJECT="clinic-20260103T000000Z.sql.gz"
expect_refusal "7: an unencrypted .sql.gz object is refused" "not encrypted"

run_proof ARCHIVE_KIND=hourly ARCHIVE_OBJECT="clinic-20260102T000000Z.tar.age"
expect_refusal "8: an unexpected extension is refused" "naming convention"

run_proof ARCHIVE_KIND=hourly ARCHIVE_OBJECT="../daily/clinic-20260102T000000Z.sql.gz.age"
expect_refusal "9a: a parent-directory traversal is refused" "names a path|contains '\.\.'"

run_proof ARCHIVE_KIND=hourly ARCHIVE_OBJECT="hourly/clinic-20260102T000000Z.sql.gz.age"
expect_refusal "9b: a cross-prefix name is refused" "names a path"

run_proof ARCHIVE_KIND=hourly ARCHIVE_OBJECT="/etc/passwd"
expect_refusal "9c: an absolute path is refused" "names a path"

run_proof ARCHIVE_KIND=hourly ARCHIVE_OBJECT='clinic-20260102T000000Z.sql.gz.age; rm -rf /'
expect_refusal "9d: a command appended to a name is refused" "names a path"

run_proof ARCHIVE_KIND=hourly ARCHIVE_OBJECT='clinic-20260102T000000Z.sql.gz.age;whoami'
expect_refusal "9d2: shell metacharacters with no slash are refused" "outside A-Z"

# The un-expanded command substitution IS the payload here.
# shellcheck disable=SC2016
run_proof ARCHIVE_KIND=hourly ARCHIVE_OBJECT='clinic-20260102T000000Z.sql.gz.age$(id)'
expect_refusal "9d3: a command substitution in a name is refused" "outside A-Z"

run_proof ARCHIVE_KIND=hourly ARCHIVE_OBJECT="$(printf 'clinic-2026\t0102T000000Z.sql.gz.age')"
expect_refusal "9e: control characters are refused" "control characters"

# An empty ARCHIVE_OBJECT is "no object requested", not a name to validate, so
# this one is the newest-object path and must succeed.
run_proof ARCHIVE_KIND=hourly ARCHIVE_OBJECT=""
if [ "${STATUS}" -eq 0 ]; then ok "9f: an empty ARCHIVE_OBJECT means 'newest', and succeeds"
else bad "9f: an empty ARCHIVE_OBJECT means 'newest', and succeeds" "$(tail -c 200 "${ERR}" | tr '\n' ' ')"; fi

run_proof ARCHIVE_KIND=weekly
expect_refusal "9g: an unapproved retention kind is refused" "hourly, daily or monthly"

# ──────────────────────────────────────────────────────────────────────────
step "10, 11: a transfer that did not deliver the object"
run_proof ARCHIVE_KIND=monthly
expect_refusal "10: a zero-byte stored object is refused" "zero bytes"
expect_clean_after_run "10"

run_proof ARCHIVE_KIND=hourly ARCHIVE_TEST_TRUNCATE=1
expect_refusal "11: a remote/downloaded size mismatch is refused" "size mismatch"
expect_clean_after_run "11"

# ──────────────────────────────────────────────────────────────────────────
step "12, 13, 14: objects that must fail before any SQL runs"
run_proof ARCHIVE_KIND=hourly R2_RESTORE_BUCKET="${DAMAGED}" ARCHIVE_OBJECT="clinic-20260201T000000Z.sql.gz.age"
expect_refusal "12: corrupted age ciphertext is refused" "age refused the object"
check "12b: nothing was restored" "a scratch database was created" \
  "$([ -z "$(scratch_databases | grep -v '^clinic_restore_drill_taken$' || true)" ] && echo 0 || echo 1)"

run_proof ARCHIVE_KIND=hourly R2_RESTORE_BUCKET="${DAMAGED}" ARCHIVE_OBJECT="clinic-20260202T000000Z.sql.gz.age"
expect_refusal "13: a wrong age identity is refused" "age refused the object"

run_proof ARCHIVE_KIND=hourly R2_RESTORE_BUCKET="${DAMAGED}" ARCHIVE_OBJECT="clinic-20260203T000000Z.sql.gz.age"
expect_refusal "14: a valid ciphertext over a broken gzip stream is refused" "not a complete gzip file"
NO_DB_COMMANDS="$(grep -c '^psql ' "${SHIM_LOG}" || true)"
check "14b: the gzip check ran before the restore" \
  "psql was called ${NO_DB_COMMANDS} times, and only the pre-flight existence check is allowed" \
  "$([ "${NO_DB_COMMANDS}" -le 1 ] && echo 0 || echo 1)"
expect_clean_after_run "20"

# ──────────────────────────────────────────────────────────────────────────
step "15, 22: a decryptable archive that is not a loadable dump"
run_proof ARCHIVE_KIND=hourly R2_RESTORE_BUCKET="${DAMAGED}" ARCHIVE_OBJECT="clinic-20260204T000000Z.sql.gz.age"
expect_refusal "15: invalid SQL fails the restore" "did not load the decrypted dump cleanly"
expect_clean_after_run "15/22"

# ──────────────────────────────────────────────────────────────────────────
step "16, 17, 18: targets that must be refused"
run_proof ARCHIVE_KIND=hourly PGHOST=db.example.com
expect_refusal "16: a non-loopback PostgreSQL target is refused" "must be on this machine"
DB_COMMANDS="$(grep -c '^psql ' "${SHIM_LOG}" || true)"
check "16b: refused before any database command" "psql ran ${DB_COMMANDS} times" \
  "$([ "${DB_COMMANDS}" -eq 0 ] && echo 0 || echo 1)"

for forbidden_db in clinic clinic_staging postgres; do
  run_proof ARCHIVE_KIND=hourly SCRATCH_DB="${forbidden_db}"
  expect_refusal "17: '${forbidden_db}' is refused as a restore target" "refusing '${forbidden_db}'"
done

"${REAL_PSQL}" -q -d postgres -c "create database keepme" >/dev/null 2>&1
"${REAL_PSQL}" -q -d postgres -c "create database clinic_restore_drill_taken" >/dev/null 2>&1

run_proof ARCHIVE_KIND=hourly SCRATCH_DB=keepme
expect_refusal "18a: an existing non-drill database is refused as a target" "refusing 'keepme'"
check "18b: the existing database still exists" "keepme was dropped" \
  "$(database_exists keepme && echo 0 || echo 1)"

run_proof ARCHIVE_KIND=hourly SCRATCH_DB=clinic_restore_drill_taken
expect_refusal "18c: an existing drill-named database is not reused or dropped" "already exists"
check "18d: that database still exists" "clinic_restore_drill_taken was dropped" \
  "$(database_exists clinic_restore_drill_taken && echo 0 || echo 1)"
check "18e: the live clinic database still exists" "the 'clinic' database was dropped" \
  "$(database_exists clinic && echo 0 || echo 1)"

# ──────────────────────────────────────────────────────────────────────────
step "26, 27: environments and keys that must be refused"
run_proof ARCHIVE_KIND=hourly BACKUP_DB_URL="postgresql://postgres:x@127.0.0.1:5432/clinic_staging"
expect_refusal "26a: a BACKUP_DB_URL in the environment is refused" "BACKUP_DB_URL is set"

run_proof ARCHIVE_KIND=hourly R2_BUCKET="r2:clinic-backups"
expect_refusal "26b: the backup writer's bucket variable is refused" "R2_BUCKET is set"

run_proof ARCHIVE_KIND=hourly RCLONE_CONFIG_R2_ACCESS_KEY_ID="whatever"
expect_refusal "26c: the backup writer's rclone credentials are refused" "RCLONE_CONFIG_R2_ACCESS_KEY_ID is set"

printf '%s\n' "${GOOD_RECIPIENT}" > "${WORK}/recipient-not-identity"
run_proof ARCHIVE_KIND=hourly BACKUP_AGE_IDENTITY_FILE="${WORK}/recipient-not-identity"
expect_refusal "27: the public recipient offered as the identity is refused by name" "BACKUP_AGE_RECIPIENT"

# ──────────────────────────────────────────────────────────────────────────
step "23: nothing secret, identifying or executable reaches the output"
run_proof ARCHIVE_KIND=hourly ARCHIVE_PROOF_REPORT="${WORK}/proof-report.txt"
if [ "${STATUS}" -ne 0 ]; then bad "23: the reporting run succeeded" "$(tail -c 300 "${ERR}" | tr '\n' ' ')"; fi

IDENTITY_SECRET="$(grep -o 'AGE-SECRET-KEY-1[A-Z0-9]*' "${WORK}/identity-good" | head -1)"
COMBINED="${WORK}/combined"
cat "${OUT}" "${ERR}" "${WORK}/proof-report.txt" > "${COMBINED}" 2>/dev/null

leak() { # leak <label> <fixed-string>
  if grep -qF -- "$2" "${COMBINED}" 2>/dev/null; then
    bad "23: no $1 in the output" "found it"
  else
    ok "23: no $1 in the output"
  fi
}
leak "age private identity"        "${IDENTITY_SECRET}"
leak "age secret-key marker"       "AGE-SECRET-KEY"
leak "age public recipient"        "${GOOD_RECIPIENT}"
leak "connection string"           "postgresql://"
leak "password"                    "PGPASSWORD"
leak "bucket path"                 "${BUCKET}"
for identity in Anbarasan Kaliyaperumal Nirmaladevi Vadivelan Walkin; do
  leak "fixture identity ${identity}" "${identity}"
done
for sql in "insert into" "INSERT INTO" "COPY jmc." "create table jmc." "CREATE TABLE"; do
  leak "SQL (${sql})" "${sql}"
done
leak "marker table name (which is in the archive)" "${MARKER}"
expect_clean_after_run "23"

# ──────────────────────────────────────────────────────────────────────────
step "25: the existing restore drill still behaves exactly as it did"
DRILL_OUT="${WORK}/drill-out"
# Its explicit-file mode, which is the mode db-restore-archive.sh uses and the
# one this branch changed. Its dump-and-compare mode is left to
# `npm run staging:drill`, which is the caller that exercises it for real; this
# harness cannot run it honestly because db-restore-drill.sh looks for the dump
# in the repository's own .backups/drill, not in BACKUP_DIR, and would pick up
# whatever a previous run left there.
age -d -i "${WORK}/identity-good" -o "${WORK}/drill-input.sql.gz" "${BUCKET}/hourly/${OLDER_NAME}"
if SCRATCH_DB=clinic_restore_drill PGHOST=127.0.0.1 PGPORT=54329 PGUSER=postgres \
   "${REPO}/scripts/db-restore-drill.sh" "${WORK}/drill-input.sql.gz" > "${DRILL_OUT}" 2>&1; then
  ok "25a: scripts/db-restore-drill.sh still restores a named file and asserts jmc came back"
else
  bad "25a: scripts/db-restore-drill.sh still restores a named file and asserts jmc came back" \
      "$(tail -c 400 "${DRILL_OUT}" | tr '\n' ' ')"
fi
rm -f "${WORK}/drill-input.sql.gz"
check "25b: it still drops its scratch database on exit" "clinic_restore_drill survived" \
  "$(database_exists clinic_restore_drill && echo 1 || echo 0)"

if SCRATCH_DB=clinic "${REPO}/scripts/db-restore-drill.sh" /dev/null >"${DRILL_OUT}" 2>&1; then
  bad "25c: the drill refuses an unsafe scratch name" "it accepted SCRATCH_DB=clinic"
else
  if grep -q "refusing 'clinic'" "${DRILL_OUT}"; then
    ok "25c: the drill refuses an unsafe scratch name"
  else
    bad "25c: the drill refuses an unsafe scratch name" "$(head -c 200 "${DRILL_OUT}")"
  fi
fi
check "25d: the live clinic database is still there afterwards" "'clinic' was dropped" \
  "$(database_exists clinic && echo 0 || echo 1)"

# ──────────────────────────────────────────────────────────────────────────
step "Result"
say "passed: ${PASSED}   failed: ${FAILED}"
if [ "${FAILED}" -ne 0 ]; then
  printf '\nfailures:\n%s' "${FAILURES}"
  exit 1
fi
say "The archive restore proof restores the stored object, and refuses everything it should."
