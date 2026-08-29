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

# Always start from a known API process.
#
# Two failure modes, both of which present as "the app is subtly wrong" rather
# than "the app is down", which is why they are killed rather than reused:
#
#   a stale dev-api holds the port with a different signing key than the
#   .env.local about to be written, and the symptom is a lock screen with
#   nobody on it;
#
#   an ORPHANED PostgREST outlives its parent, keeps port 54322, and serves a
#   schema cache from before the latest migration. The new PostgREST cannot
#   bind, exits, and the orphan answers in its place — so a transition added in
#   this session returns PGRST202 "could not find the function" while psql can
#   see it perfectly well.
for pid in $(pgrep -f "node .*scripts/dev-api\.mjs" 2>/dev/null || true); do
  kill "${pid}" 2>/dev/null || true
done
pkill -x postgrest 2>/dev/null || true
sleep 0.5

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
# Selects lib/realtime's WebSocket adapter over Supabase Realtime. Unset in
# production, where Supabase Realtime is the adapter (HOSTING.md §7).
NEXT_PUBLIC_REALTIME_WS_URL=ws://127.0.0.1:54321/realtime
ENV

# Readiness probe.
#
# PostgREST builds its schema cache once, at boot. Every way that cache can go
# stale ends in the same place — a transition that exists in the database
# returns "could not find the function" through the API, and a screen button
# quietly does nothing. So the stack refuses to report itself ready until the
# RPC surface the app actually calls is visible through it.
# The OpenAPI surface is the cache, in the API's own words. Calling each
# function would not do: PostgREST matches on the exact argument set, so an
# argument-less probe 404s against a function that is present and fine.
#
# Polled rather than asked once. PostgREST prints its banner and starts
# listening BEFORE the schema cache is built, and answers 503 in between — so a
# single-shot probe is a race that gets slower to win as the schema grows, and
# loses as "the cache is stale" when the cache was merely a second away.
missing=""
for _ in $(seq 1 30); do
  surface="$(curl -s \
    -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${ANON_KEY}" \
    -H 'Accept-Profile: app' \
    'http://127.0.0.1:54321/rest/v1/')"

  missing=""
  for fn in dispense unlock_pin book_appointment sign_prescription \
            raise_counter_query answer_counter_query withdraw_counter_query \
            receive_goods start_stock_take return_to_supplier \
            write_off_expired draft_purchase_orders; do
    if ! grep -q "\"/rpc/${fn}\"" <<<"${surface}"; then
      missing="${missing} ${fn}"
    fi
  done

  [ -z "${missing}" ] && break
  sleep 0.5
done

if [ -n "${missing}" ]; then
  echo "the API cannot see these transitions:${missing}" >&2
  echo "PostgREST's schema cache is stale — check for an orphaned postgrest process." >&2
  exit 1
fi

echo "dev stack ready — .env.local written"
