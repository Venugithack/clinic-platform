#!/usr/bin/env bash
# Load the development seed. Local only.
source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"

psql_run -q -f "${REPO_ROOT}/supabase/seed.sql"

psql_run -tA -c "select 'drugs=' || count(*) from drugs"
psql_run -tA -c "select 'batches=' || count(*) from stock_batches"
psql_run -tA -c "select 'ledger rows=' || count(*) from stock_movements"

# Rule 3, checked the moment there is any stock at all.
drift="$(psql -tA -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" \
  -c 'select count(*) from stock_cache_drift')"
if [ "${drift}" != "0" ]; then
  echo "seed left the cache disagreeing with the ledger (${drift} batches)" >&2
  exit 1
fi
echo "cache and ledger agree"
