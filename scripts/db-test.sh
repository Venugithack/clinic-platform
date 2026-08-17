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

# Leave the database usable.
#
# Every pgTAP file rolls back, but this script resets the schema first, which
# takes the development seed with it. Without this the next thing to run —
# `pnpm test:e2e`, or a developer opening the app — meets an empty clinic with
# no staff, no drugs and no explanation.
"$(dirname "${BASH_SOURCE[0]}")/db-seed.sh" >/dev/null
echo "seed restored"

# And leave the API usable, which is a separate problem with a worse symptom.
#
# The reset above drops and rebuilds the schema underneath a running PostgREST.
# It reconnects by itself — but if it reconnects while the rebuild is still in
# progress it caches whatever existed at that instant, and nothing tells it to
# look again. The failure that produces is a transition returning 404 from a
# screen, against a database where the function demonstrably exists. That cost
# an hour once; one NOTIFY closes it.
psql_run -q -c "notify pgrst, 'reload schema'" >/dev/null 2>&1 || true
