#!/usr/bin/env bash
# Bring up everything the app needs locally: database, schema, seed, API, env.
#
#   ./scripts/dev-stack.sh          start it
#   ./scripts/dev-stack.sh --reset  drop and rebuild the database first
#
# On the clinic dev machine `supabase start` is the real local stack (BUILD.md
# §1.2). This is the same API surface without Docker — see scripts/dev-api.mjs
# for why the two are interchangeable from the app's point of view.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/db-env.sh"

PGRST_VERSION="${PGRST_VERSION:-v12.2.3}"
PGRST_BIN="${PGRST_BIN:-${REPO_ROOT}/.tools/postgrest}"
API_LOG="${API_LOG:-${REPO_ROOT}/.tools/dev-api.log}"

mkdir -p "$(dirname "${PGRST_BIN}")"

if [ ! -x "${PGRST_BIN}" ]; then
  echo "→ fetching PostgREST ${PGRST_VERSION}"
  curl -fsSL \
    "https://github.com/PostgREST/postgrest/releases/download/${PGRST_VERSION}/postgrest-${PGRST_VERSION}-linux-static-x64.tar.xz" \
    | tar -xJ -C "$(dirname "${PGRST_BIN}")"
  chmod +x "${PGRST_BIN}"
fi

if [ "${1:-}" = "--reset" ]; then
  "$(dirname "${BASH_SOURCE[0]}")/db-reset.sh" >/dev/null
  "$(dirname "${BASH_SOURCE[0]}")/db-seed.sh"
else
  "$(dirname "${BASH_SOURCE[0]}")/db-start.sh" >/dev/null
  "$(dirname "${BASH_SOURCE[0]}")/db-migrate.sh"
fi

PGRST_BIN="${PGRST_BIN}" nohup node "${REPO_ROOT}/scripts/dev-api.mjs" > "${API_LOG}" 2>&1 &

for _ in $(seq 1 30); do
  if grep -q '^anon key' "${API_LOG}" 2>/dev/null; then break; fi
  sleep 0.5
done

if ! grep -q '^anon key' "${API_LOG}"; then
  echo "the dev API did not start:" >&2
  cat "${API_LOG}" >&2
  exit 1
fi

ANON_KEY="$(sed -n 's/^anon key  //p' "${API_LOG}" | head -1)"

# NEXT_PUBLIC_* values are inlined at build time, so this must exist before
# `next build` — not before `next start`.
cat > "${REPO_ROOT}/.env.local" <<ENV
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=${ANON_KEY}
ENV

echo "dev stack ready — .env.local written"
