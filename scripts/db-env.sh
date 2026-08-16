#!/usr/bin/env bash
# Shared settings for the local database scripts.
#
# HOSTING.md §1a: build local first. Supabase in Docker on the dev machine is
# the intended local stack, and `supabase start` is what the clinic dev machine
# runs. These scripts drive a plain Postgres 16 cluster instead, for CI and for
# any environment without a Docker daemon — the migrations are identical and
# stay `supabase db push`-compatible either way, because nothing in them is
# Supabase-proprietary (HOSTING.md §7).
set -euo pipefail

PG_VERSION="${PG_VERSION:-16}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/${PG_VERSION}/bin}"
PGPORT="${PGPORT:-54329}"
PGHOST="${PGHOST:-127.0.0.1}"
PGDATABASE="${PGDATABASE:-clinic}"

# Postgres refuses to run as root. When these scripts are invoked as root — CI
# containers, the remote build box — the server runs as the `postgres` OS user
# instead, and the client still connects over TCP as an ordinary superuser role.
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
MIGRATIONS_DIR="${REPO_ROOT}/supabase/migrations"
TESTS_DIR="${REPO_ROOT}/supabase/tests"

export PGDATA PGPORT PGHOST PGDATABASE PGUSER PG_BIN PG_OS_USER REPO_ROOT MIGRATIONS_DIR TESTS_DIR

psql_run() {
  psql -v ON_ERROR_STOP=1 -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" "$@"
}
