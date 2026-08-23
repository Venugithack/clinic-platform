#!/usr/bin/env bash
# Enable the PostgreSQL project's own apt repository (PGDG).
#
# Ubuntu 24.04's archive carries Postgres 16 and stops there, so
# `apt-get install postgresql-17` on a stock runner fails with "no installation
# candidate". PGDG carries every supported major, and the `-pgtap` package for
# each — which the database job needs and the distro archive does not ship at
# all for 17.
#
# The majors have to agree: supabase/config.toml runs the Docker stack on 17
# because there is no Supabase image for 16, and a test suite on a different
# major from the stack it is meant to prove is a test suite that can pass while
# the real thing is broken.
#
# This is the method apt.postgresql.org documents. Two jobs in ci.yml call it,
# which is why it is a file rather than eight lines pasted twice.
set -euo pipefail

sudo install -d /usr/share/postgresql-common/pgdg
sudo curl --fail --silent --show-error \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc

# shellcheck disable=SC2016
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  | sudo tee /etc/apt/sources.list.d/pgdg.list > /dev/null

sudo apt-get update
