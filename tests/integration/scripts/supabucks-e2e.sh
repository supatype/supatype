#!/usr/bin/env bash
# Prove Supatype serves a built SPA, against a running stack.
#
# `app.mode = "static"` is the deployment most users ship: one command, one origin, the API and the
# page served together. Nothing asserted it. The example builds to ./dist and the config points at
# it, so every way this breaks is silent — a build that emits nothing, a base path that makes every
# asset 404, an anon key that was never injected, a fallback route that returns 404 instead of the
# app shell. Each of those leaves a stack that is up and an app that is blank.
#
# Usage:
#   bash tests/integration/scripts/supabucks-e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EXAMPLE_DIR="$ROOT_DIR/examples/supabucks"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
# IPv4 explicitly: `localhost` resolves to ::1 first on some hosts, where Docker's IPv6 forwarder
# may accept and then reset.
BASE_URL="${SUPABUCKS_E2E_URL:-http://127.0.0.1:${KONG_PORT}}"
MAX_WAIT="${SUPABUCKS_E2E_MAX_WAIT:-300}"

source "$SCRIPT_DIR/lib/http-wait.sh"
source "$SCRIPT_DIR/lib/example-keys.sh"

DEV_PID=""
ENV_EXISTED="no"
[[ -f "$EXAMPLE_DIR/.env" ]] && ENV_EXISTED="yes"

cleanup() {
  echo ""
  echo "==> teardown"
  if [[ -n "$DEV_PID" ]]; then kill "$DEV_PID" 2>/dev/null || true; fi
  (cd "$EXAMPLE_DIR" && docker compose -p supatype-supabucks down -v --remove-orphans) >/dev/null 2>&1 || true
  # The .env this script mints into is not gitignored here, so a failure must not leave a key behind.
  if [[ "$ENV_EXISTED" == "no" ]]; then rm -f "$EXAMPLE_DIR/.env"; fi
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

fail() { echo "  FAIL $*" >&2; exit 1; }

echo "==> Minting keys"
# Before the build, not after: Vite reads VITE_SUPATYPE_ANON_KEY at build time and bakes the value
# into the bundle. Mint it later and the bundle ships an empty key.
mint_keys "$EXAMPLE_DIR" "$CLI_BIN"

echo "==> Building the SPA"
(cd "$EXAMPLE_DIR" && VITE_SUPATYPE_ANON_KEY="$ANON_KEY" npx vite build)

INDEX_BUILT="$EXAMPLE_DIR/dist/index.html"
[[ -f "$INDEX_BUILT" ]] || fail "vite build produced no dist/index.html — nothing for static mode to serve"

echo "==> Bringing the stack up"
(cd "$EXAMPLE_DIR" && node "$CLI_BIN" dev) &
DEV_PID=$!

ready() { http_ok "$BASE_URL/auth/v1/health"; }
if ! wait_until "$MAX_WAIT" "$BASE_URL/auth/v1/health" ready; then
  echo "ERROR: the stack never became ready"
  exit 1
fi

echo ""
echo "==> The app shell is served at /"
status="$(http_status "$BASE_URL/")"
[[ "$status" == "200" ]] || fail "GET / returned $status, expected 200"
root_html="$(curl -s --connect-timeout 3 --max-time 10 "$BASE_URL/")"
grep -q 'id="root"' <<<"$root_html" || fail "GET / did not return the app shell (no #root in the body)"
echo "  ok   / serves the built index"

echo ""
echo "==> A path with no file behind it falls back to the shell"
# What SPA fallback means, and the half of static mode a 200 on / does not cover: the server has no
# file at this path and must answer with the app rather than a 404.
status="$(http_status "$BASE_URL/rewards")"
[[ "$status" == "200" ]] || fail "GET /rewards returned $status, expected the SPA fallback to serve 200"
grep -q 'id="root"' <<<"$(curl -s --connect-timeout 3 --max-time 10 "$BASE_URL/rewards")" \
  || fail "GET /rewards answered 200 without the app shell"
echo "  ok   /rewards falls back to the shell"

echo ""
echo "==> The bundle the shell references is served, as JavaScript"
# Read the path out of the built index rather than guessing the hash, so a wrong base path fails
# here instead of showing up as a blank page nobody's test noticed.
asset="$(sed -n 's/.*<script[^>]*src="\([^"]*\.js\)".*/\1/p' "$INDEX_BUILT" | head -1)"
[[ -n "$asset" ]] || fail "no <script src> in the built index.html"
status="$(http_status "$BASE_URL${asset}")"
[[ "$status" == "200" ]] || fail "GET $asset returned $status, expected 200"
ctype="$(http_header content-type "$BASE_URL${asset}")"
grep -qi 'javascript' <<<"$ctype" || fail "$asset served as '${ctype:-no content-type}', not JavaScript"
echo "  ok   $asset served as $ctype"

echo ""
echo "==> The anon key reached the bundle"
# A key that never made it into the build is the failure that looks exactly like a working app until
# the first request: the page renders, and every call is a 401.
grep -rqE 'eyJ[A-Za-z0-9_-]{6,}\.' "$EXAMPLE_DIR/dist/assets" \
  || fail "no JWT in the built assets — VITE_SUPATYPE_ANON_KEY was not injected at build time"
echo "  ok   a signed key is baked into the bundle"

echo ""
echo "==> That key is accepted by the API this build is served from"
# Both tables are owner-read, so anon sees an empty array. 200 with [] is the assertion: the key
# verifies and RLS filtered the rows. A bad key is a 401, which is what this catches.
status="$(http_status -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  "$BASE_URL/rest/v1/customer?select=id&limit=1")"
[[ "$status" == "200" ]] || fail "anon REST read returned $status, expected 200"
echo "  ok   anon REST read accepted"

echo ""
echo "PASS: the SPA is built, served, falls back, and talks to its own API"
