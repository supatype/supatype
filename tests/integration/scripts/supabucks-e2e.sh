#!/usr/bin/env bash
# Prove Supatype serves a built SPA, against a running stack.
#
# `app.mode = "static"` is the deployment most users ship: one command, one origin, the API and the
# page served together. Nothing asserted it. The example builds to ./dist and the config points at
# it, so every way this breaks is silent: a build that emits nothing, a base path that makes every
# asset 404, an anon key that was never injected, a fallback route that returns 404 instead of the
# app shell. Each of those leaves a stack that is up and an app that is blank.
#
# Usage:
#   bash tests/integration/scripts/supabucks-e2e.sh
#
# Beside another run, from another checkout: SUPATYPE_E2E_PROJECT names this run's compose project
# and SUPATYPE_KONG_PORT moves the gateway. See lib/e2e-project.sh.
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
source "$SCRIPT_DIR/lib/e2e-project.sh"

e2e_project_use "$EXAMPLE_DIR" supabucks
# Exported so `supatype dev` binds the port this script waits on, rather than the next free one.
export SUPATYPE_KONG_PORT="$KONG_PORT"

DEV_PID=""
ENV_EXISTED="no"
[[ -f "$EXAMPLE_DIR/.env" ]] && ENV_EXISTED="yes"

cleanup() {
  echo ""
  # `down -v` on the way out means a failing assertion takes its evidence with it. The API answered
  # 401 and by the time anyone could ask it why, the database was gone. Set this to keep the stack
  # up and query it, the way `zero-to-running` already allows.
  if [[ "${SUPATYPE_E2E_KEEP:-}" == "1" ]]; then
    echo "==> teardown skipped (SUPATYPE_E2E_KEEP=1); stack $E2E_COMPOSE_PROJECT left running at $BASE_URL"
    stop_pid_bounded "$DEV_PID"
    e2e_project_release
    return
  fi
  echo "==> teardown"
  stop_pid_bounded "$DEV_PID"
  e2e_project_down
  # The .env this script mints into is not gitignored here, so a failure must not leave a key behind.
  if [[ "$ENV_EXISTED" == "no" ]]; then rm -f "$EXAMPLE_DIR/.env"; fi
  e2e_project_release
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

fail() { echo "  FAIL $*" >&2; exit 1; }

echo "==> Minting keys"
mint_keys "$EXAMPLE_DIR" "$CLI_BIN"

echo "==> Building the SPA, as the README does"
# A plain `vite build`, with no key given: the page reads it from the server's /supatype-env.js
# (checked below). 0.9.1 release test (RB9): passing the key here hid that the README's own build
# had none, and the app the README describes was a blank page. Unset in case the caller's
# environment carries one.
(cd "$EXAMPLE_DIR" && env -u VITE_SUPATYPE_ANON_KEY -u VITE_SUPATYPE_URL npx vite build)

INDEX_BUILT="$EXAMPLE_DIR/dist/index.html"
[[ -f "$INDEX_BUILT" ]] || fail "vite build produced no dist/index.html, so static mode has nothing to serve"

echo "==> Bringing the stack up"
(cd "$EXAMPLE_DIR" && exec node "$CLI_BIN" dev) &
DEV_PID=$!

ready() { dev_started "$EXAMPLE_DIR" && http_ok "$BASE_URL/auth/v1/health"; }
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
# here instead of showing up as a blank page nobody's test noticed. The module script: the page's
# first script is /supatype-env.js, which the server answers, not the build.
asset="$(sed -n 's/.*<script type="module"[^>]*src="\([^"]*\.js\)".*/\1/p' "$INDEX_BUILT" | head -1)"
[[ -n "$asset" ]] || fail "no <script type=\"module\" src> in the built index.html"
status="$(http_status "$BASE_URL${asset}")"
[[ "$status" == "200" ]] || fail "GET $asset returned $status, expected 200"
ctype="$(http_header content-type "$BASE_URL${asset}")"
grep -qi 'javascript' <<<"$ctype" || fail "$asset served as '${ctype:-no content-type}', not JavaScript"
echo "  ok   $asset served as $ctype"

echo ""
echo "==> The page gets its anon key from the stack that serves it"
# A page with no key is the failure that looks like a working build until it loads: before RB9 the
# app threw at start and the page was blank. The build carries none, so the page must load the
# server's script, and the server must answer it with the stack's key.
grep -q '<script src="/supatype-env.js"' "$INDEX_BUILT" \
  || fail "the built index.html does not load /supatype-env.js, so the page has no anon key"
expect_env_script "$BASE_URL" || fail "the SPA has no way to get its anon key"
if grep -rqE 'eyJ[A-Za-z0-9_-]{6,}\.' "$EXAMPLE_DIR/dist/assets"; then
  fail "a JWT is baked into the built assets: a production build must not ship the local stack's key"
fi
echo "  ok   the bundle carries no key of its own"

echo ""
echo "==> The key the page is handed is accepted by the API this build is served from"
# Asserted on the error code, not the status, because both outcomes here are 401.
#
# This used to expect 200 with an empty array, on the assumption that anon holds SELECT and RLS
# filters the rows away. Supatype does not work that way: `read: Owner<"id">` grants SELECT to
# `authenticated` and withholds it from `anon`, since anon can never own a row, and withholding the
# grant is a stronger guarantee than granting it and relying on a policy. So a 200 was never
# reachable and this check could not pass.
#
# The distinction that matters is still available, and is what this section is named for:
#   valid key   -> 42501, Postgres refused the table after the role was applied
#   invalid key -> PGRST301, PostgREST could not decode the JWT at all
# A key that never verifies cannot produce 42501, so this proves the same thing the old assertion
# meant to.
body="$(curl -sS -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
  "$BASE_URL/rest/v1/customer?select=id&limit=1")"
case "$body" in
  *PGRST301*|*JWSError*) fail "the key /supatype-env.js hands the page was rejected by the API: $body" ;;
  *42501*|"[]"|"[]"*)    echo "  ok   anon REST read accepted (key verified, table correctly denied)" ;;
  *)                     fail "unexpected anon REST response: $body" ;;
esac

echo ""
echo "PASS: the SPA is built, served, falls back, and talks to its own API"
