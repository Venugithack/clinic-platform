#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"

if [ ! -d "${PGDATA}/base" ]; then
  mkdir -p "${PGDATA}"
  chown "${PG_OS_USER}" "${PGDATA}"
  chmod 700 "${PGDATA}"
  as_pg "${PG_BIN}/initdb" -D "${PGDATA}" -U "${PGUSER}" --auth=trust --encoding=UTF8 >/dev/null
fi

if ! as_pg "${PG_BIN}/pg_ctl" -D "${PGDATA}" status >/dev/null 2>&1; then
  as_pg "${PG_BIN}/pg_ctl" -D "${PGDATA}" \
    -o "-p ${PGPORT} -k ${PGDATA} -c listen_addresses=127.0.0.1" \
    -l "${PGDATA}/server.log" -w start
fi

if ! psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -lqt | cut -d'|' -f1 | grep -qw "${PGDATABASE}"; then
  createdb -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" "${PGDATABASE}"
fi

echo "ready: postgresql://${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
