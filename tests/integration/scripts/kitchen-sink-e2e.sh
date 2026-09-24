#!/usr/bin/env bash
# The kitchen sink, against a running stack: what it claims to cover, covered.
#
# Two halves. `verify.ts` asserts the things a browser cannot distinguish — a socket that delivers
# from one that merely opens, an access rule that filters from a query that matched nothing, a
# transform that re-encodes from a CDN echoing the original. Then the app-mode walk asserts the
# other half of the example's premise: `app` is a single setting, the two front ends take turns,
# and `supatype app` is what moves between them.
#
# Usage:
#   bash tests/integration/scripts/kitchen-sink-e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EXAMPLE_DIR="$ROOT_DIR/examples/kitchen-sink"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
# IPv4 explicitly: `localhost` resolves to ::1 first on some hosts, where Docker's IPv6 forwarder
# may accept and then reset.
BASE_URL="${KITCHEN_SINK_E2E_URL:-http://127.0.0.1:${KONG_PORT}}"
MAX_WAIT="${KITCHEN_SINK_E2E_MAX_WAIT:-300}"

source "$SCRIPT_DIR/lib/http-wait.sh"
source "$SCRIPT_DIR/lib/example-keys.sh"

DEV_PID=""
ENV_EXISTED="no"
[[ -f "$EXAMPLE_DIR/.env" ]] && ENV_EXISTED="yes"

cleanup() {
  echo ""
  echo "==> teardown"
  if [[ -n "$DEV_PID" ]]; then kill "$DEV_PID" 2>/dev/null || true; fi
  (cd "$EXAMPLE_DIR" && docker compose -p supatype-kitchen-sink down -v --remove-orphans) >/dev/null 2>&1 || true
  # The mode walk rewrites the committed config, which is what `supatype app` does. Put it back so
  # a failure does not leave the example configured for whichever mode it died in.
  git -C "$ROOT_DIR" checkout -- examples/kitchen-sink/supatype.config.ts 2>/dev/null || true
  if [[ "$ENV_EXISTED" == "no" ]]; then rm -f "$EXAMPLE_DIR/.env"; fi
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

fail() { echo "  FAIL $*" >&2; exit 1; }

start_stack() {
  (cd "$EXAMPLE_DIR" && node "$CLI_BIN" dev) &
  DEV_PID=$!
  ready() { http_ok "$BASE_URL/auth/v1/health"; }
  if ! wait_until "$MAX_WAIT" "$BASE_URL/auth/v1/health" ready; then
    echo "ERROR: the stack never became ready"
    exit 1
  fi
}

stop_stack() {
  if [[ -n "$DEV_PID" ]]; then kill "$DEV_PID" 2>/dev/null || true; fi
  DEV_PID=""
  (cd "$EXAMPLE_DIR" && docker compose -p supatype-kitchen-sink down --remove-orphans) >/dev/null 2>&1 || true
}

echo "==> Minting keys"
# Before the SPA build: Vite bakes VITE_SUPATYPE_ANON_KEY in at build time, so a key minted after it
# ships an empty string to every caller.
mint_keys "$EXAMPLE_DIR" "$CLI_BIN"

echo "==> Building the SPA"
(cd "$ROOT_DIR" && VITE_SUPATYPE_ANON_KEY="$ANON_KEY" pnpm --filter @supatype/example-kitchen-sink-app build)
[[ -f "$EXAMPLE_DIR/apps/app/dist/index.html" ]] || fail "the SPA build produced no dist/index.html"

echo ""
echo "==> Bringing the stack up (static mode: the SPA is what / serves)"
# Opt the functions worker into a database URL, so the path that was broken is the one exercised.
# Set before the stack starts, because compose reads it when the container is created. The in-
# network address, not a published host port: the worker resolves `db`, not `localhost`.
#
# The owner DSN is deliberate here and only here. This is a disposable CI stack asserting the wiring
# works; a real project should point this at a role it restricted, since a function holding this
# bypasses access rules, field masking and model hooks.
export SUPATYPE_FUNCTIONS_DB_URL="postgresql://supatype_admin:$(grep -m1 '^POSTGRES_PASSWORD=' "$EXAMPLE_DIR/.env" | cut -d= -f2-)@db:5432/kitchen-sink"
start_stack

echo ""
echo "==> Seeding"
(cd "$EXAMPLE_DIR" && npx tsx seed.ts)

echo ""
echo "==> What a browser cannot assert"
(cd "$EXAMPLE_DIR" && SUPATYPE_URL="$BASE_URL" ANON_KEY="$ANON_KEY" \
  EXPECT_FUNCTION_DB_URL=1 npx tsx verify.ts)

echo ""
echo "==> What a browser can assert"
# The half `verify.ts` cannot reach. It drives the API and says nothing about whether any of it
# arrives on a screen: the app was rewritten from a five-tab demo harness into a conference app and
# the whole change was visible only in a screenshot, which is not a test.
#
# Skipped rather than failed when Playwright's browser is not installed, because this script is
# also run by hand on machines that have never downloaded one, and a missing browser is not a
# regression in the example.
if (cd "$ROOT_DIR/tests/e2e" && npx playwright install --dry-run chromium >/dev/null 2>&1); then
  (cd "$ROOT_DIR/tests/e2e" && E2E_BASE_URL="$BASE_URL" npx playwright test specs/kitchen-sink-app.spec.ts) \
    || fail "the attendee app's browser tests did not pass"
  echo "  ok   the attendee app renders what the schema says it should"
else
  echo "  skip Playwright's chromium is not installed; run 'npx playwright install chromium'"
fi

echo ""
echo "==> app.mode walk: static"
status="$(http_status "$BASE_URL/")"
[[ "$status" == "200" ]] || fail "GET / returned $status in static mode, expected the SPA"
grep -q 'id="root"' <<<"$(curl -s --connect-timeout 3 --max-time 10 "$BASE_URL/")" \
  || fail "GET / answered 200 without the app shell"
# The half a 200 on / does not cover: no file lives here, and the server must answer with the app
# rather than a 404.
status="$(http_status "$BASE_URL/ticket")"
[[ "$status" == "200" ]] || fail "GET /ticket returned $status, expected the SPA fallback"
echo "  ok   the SPA is served, and a path with no file falls back to it"

# `proxy` is deliberately not in this walk yet. It needs `next dev` running beside the stack and a
# `host.docker.internal` that resolves on a Linux runner — the same pair that gates blog-e2e. Adding
# it here before that is settled would make this job fail for a reason that has nothing to do with
# the example. The mode itself is exercised by `pnpm mode:marketing` locally.
echo ""
echo "==> app.mode walk: none"
stop_stack
(cd "$EXAMPLE_DIR" && node "$CLI_BIN" app remove >/dev/null)
start_stack
status="$(http_status "$BASE_URL/")"
[[ "$status" == "404" ]] || fail "GET / returned $status with app.mode=none, expected 404"
# The API is still there: `none` turns off the root route, not the deployment.
http_ok "$BASE_URL/auth/v1/health" || fail "the API stopped answering with app.mode=none"
echo "  ok   / is 404 and the API still answers"

echo ""
echo "==> app.mode walk: back to static"
stop_stack
(cd "$EXAMPLE_DIR" && node "$CLI_BIN" app add --static ./apps/app/dist >/dev/null)
start_stack
status="$(http_status "$BASE_URL/")"
[[ "$status" == "200" ]] || fail "GET / returned $status after switching back, expected the SPA"
echo "  ok   the switch is reversible"

echo ""
echo "PASS: the kitchen sink covers what it says it covers"
