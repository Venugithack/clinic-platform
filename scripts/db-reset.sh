#!/usr/bin/env bash
# Drop and rebuild the local database from migrations. Local only, by design:
# there is no path from this script to anything that holds patient data.
source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"

"$(dirname "${BASH_SOURCE[0]}")/db-start.sh" >/dev/null

psql -q -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d postgres \
  -c "drop database if exists ${PGDATABASE} with (force)" \
  -c "create database ${PGDATABASE}"

"$(dirname "${BASH_SOURCE[0]}")/db-migrate.sh"
