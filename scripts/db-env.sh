#!/usr/bin/env bash
set -euo pipefail

PG_VERSION="${PG_VERSION:-17}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/${PG_VERSION}/bin}"
PGPORT="${PGPORT:-54329}"
PGHOST="${PGHOST:-127.0.0.1}"
PGDATABASE="${PGDATABASE:-clinic}"

if [ "$(id -u)" -eq 0 ]; then
  PG_OS_USER="${PG_OS_USER:-postgres}"
  PGDATA="${PGDATA:-/var/lib/postgresql/clinic-pgdata}"
  PGUSER="${PGUSER:-postgres}"
  as_pg() { setpriv --reuid="${PG_OS_USER}" --regid="${PG_OS_USER}" --clear-groups "$@"; }
else
  PG_OS_USER="$(id -un)"
  PGDATA="${PGDATA:-${TMPDIR:-/tmp}/clinic-pgdata}"
  PGUSER="${PGUSER:-$(id -un)}"
  as_pg() { "$@"; }
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGDATA PGPORT PGHOST PGDATABASE PGUSER PG_BIN PG_OS_USER REPO_ROOT
