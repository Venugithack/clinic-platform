#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"
"${PG_BIN}/pg_ctl" -D "${PGDATA}" -w stop || true
