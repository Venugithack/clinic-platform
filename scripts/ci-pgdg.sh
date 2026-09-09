#!/usr/bin/env bash
set -euo pipefail

# Ubuntu runners do not ship the PostgreSQL 17 packages used by Supabase.
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl --fail --silent --show-error \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc

# shellcheck disable=SC2016
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list > /dev/null

sudo apt-get update
