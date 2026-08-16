#!/usr/bin/env bash
# Run the pgTAP suite against a freshly migrated database.
#
# The transitions live in the database now (HOSTING.md §3), so this — not
# Vitest — is what proves rules 2 and 3 hold.
source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"

"$(dirname "${BASH_SOURCE[0]}")/db-reset.sh" >/dev/null
psql_run -q -c "create extension if not exists pgtap"

failed=0
for file in "${TESTS_DIR}"/*.sql; do
  name="$(basename "${file}")"
  echo "── ${name}"
  # Each test file runs in one transaction and rolls back, so tests cannot see
  # each other's rows and order never matters.
  output="$(psql -X -q -v ON_ERROR_STOP=1 --no-align --tuples-only \
    -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -f "${file}" 2>&1)" || { echo "${output}"; failed=1; continue; }

  echo "${output}"
  if grep -qE '^not ok' <<<"${output}"; then
    failed=1
  fi
  if ! grep -qE '^(ok|1\.\.)' <<<"${output}"; then
    echo "no TAP output from ${name}"
    failed=1
  fi
done

if [ "${failed}" -ne 0 ]; then
  echo "pgTAP: FAILED"
  exit 1
fi
echo "pgTAP: all green"
