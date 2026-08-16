#!/usr/bin/env bash
# Apply supabase/migrations in filename order, forward-only, exactly once each.
#
# BUILD.md §1.2: migration-first, without exception. Every schema change is a
# file in supabase/migrations/. Nothing is clicked in Studio and kept. That is
# what makes `supabase db push` to any host a non-event later.
source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"

psql_run -q <<'SQL'
create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);
SQL

applied=0
for file in "${MIGRATIONS_DIR}"/*.sql; do
  version="$(basename "${file}" .sql)"

  already="$(psql -tA -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -c "select 1 from schema_migrations where version = '${version}'")"
  if [ "${already}" = "1" ]; then
    continue
  fi

  echo "→ ${version}"
  # Each migration runs in its own transaction: a failure leaves no half-applied
  # schema and no row in schema_migrations.
  psql -v ON_ERROR_STOP=1 --single-transaction \
    -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" \
    -q -f "${file}" \
    -c "insert into schema_migrations (version) values ('${version}')"
  applied=$((applied + 1))
done

echo "${applied} migration(s) applied"
