#!/usr/bin/env bash
# The kitchen sink, against a running stack: what it claims to cover, covered.
#
# Two halves. `verify.ts` asserts the things a browser cannot distinguish: a socket that delivers
# from one that merely opens, an access rule that filters from a query that matched nothing, a
# transform that re-encodes from a CDN echoing the original. Then the app-mode walk asserts the
# other half of the example's premise: `app` is a single setting, the two front ends take turns,
# and `supatype app` is what moves between them. In between, the browser signs in with GitHub
# through a stub provider (lib/oauth-stub.sh) the stack's GitHub provider is pointed at, so the
# whole OAuth round trip runs against the real auth server and the app's own button.
#
# Usage:
#   bash tests/integration/scripts/kitchen-sink-e2e.sh
#
# Beside another run, from another checkout: SUPATYPE_E2E_PROJECT names this run's compose project,
# and SUPATYPE_KONG_PORT, SUPATYPE_DEV_DB_PORT and OAUTH_STUB_PORT move its ports. See
# lib/e2e-project.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EXAMPLE_DIR="$ROOT_DIR/examples/kitchen-sink"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
MAX_WAIT="${KITCHEN_SINK_E2E_MAX_WAIT:-300}"
# Not expo-auth's 18998, so the two suites can run side by side from two checkouts.
STUB_PORT="${OAUTH_STUB_PORT:-18997}"
STUB_EMAIL="ks-octo-${RANDOM}${RANDOM}@example.com"

source "$SCRIPT_DIR/lib/http-wait.sh"
source "$SCRIPT_DIR/lib/example-keys.sh"
source "$SCRIPT_DIR/lib/e2e-project.sh"
source "$SCRIPT_DIR/lib/env-file.sh"
source "$SCRIPT_DIR/lib/oauth-stub.sh"

e2e_project_use "$EXAMPLE_DIR" kitchen-sink

DEV_PID=""
OAUTH_STUB_PID=""
ENV_EXISTED="no"
[[ -f "$EXAMPLE_DIR/.env" ]] && ENV_EXISTED="yes"

# Start where the README starts: `cp .env.example .env`. Without this the stack ran on the CLI's
# fallbacks (database `supatype`, password `postgres`), which is the one configuration in which a
# path that hardcodes those values cannot fail. The `auth.users` grant did exactly that, so Studio's
# relation preview was broken for every project that followed the README, and this job was green.
#
# A developer's own .env is kept aside and put back on exit: this run points its GitHub provider at
# a stub that is gone once the run ends.
if [[ "$ENV_EXISTED" == "no" ]]; then
  cp "$EXAMPLE_DIR/.env.example" "$EXAMPLE_DIR/.env"
else
  cp "$EXAMPLE_DIR/.env" "$EXAMPLE_DIR/.env.e2e-bak"
fi

# The example pins its gateway port in .env so its URLs are true; follow it rather than assuming.
# `|| true`: without the file env_file_value fails, and under `set -euo pipefail` the script would
# stop here instead of falling back to the default port.
KONG_PORT="${SUPATYPE_KONG_PORT:-$(env_file_value "$EXAMPLE_DIR/.env" SUPATYPE_KONG_PORT 2>/dev/null || true)}"
KONG_PORT="${KONG_PORT:-18473}"
# IPv4 explicitly: `localhost` resolves to ::1 first on some hosts, where Docker's IPv6 forwarder
# may accept and then reset.
BASE_URL="${KITCHEN_SINK_E2E_URL:-http://127.0.0.1:${KONG_PORT}}"
# Exported so `supatype dev` binds the port this script waits on, rather than the next free one.
export SUPATYPE_KONG_PORT="$KONG_PORT"

cleanup() {
  echo ""
  echo "==> teardown"
  stop_pid_bounded "$DEV_PID"
  e2e_project_down
  [[ -z "$OAUTH_STUB_PID" ]] || kill "$OAUTH_STUB_PID" 2>/dev/null || true
  # The mode walk rewrites the committed config, which is what `supatype app` does. Put it back so
  # a failure does not leave the example configured for whichever mode it died in.
  git -C "$ROOT_DIR" checkout -- examples/kitchen-sink/supatype.config.ts 2>/dev/null || true
  if [[ "$ENV_EXISTED" == "no" ]]; then rm -f "$EXAMPLE_DIR/.env"; fi
  if [[ -f "$EXAMPLE_DIR/.env.e2e-bak" ]]; then mv -f "$EXAMPLE_DIR/.env.e2e-bak" "$EXAMPLE_DIR/.env"; fi
  e2e_project_release
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

fail() { echo "  FAIL $*" >&2; exit 1; }

start_stack() {
  (cd "$EXAMPLE_DIR" && exec node "$CLI_BIN" dev) &
  DEV_PID=$!
  ready() { dev_started "$EXAMPLE_DIR" && http_ok "$BASE_URL/auth/v1/health"; }
  if ! wait_until "$MAX_WAIT" "$BASE_URL/auth/v1/health" ready; then
    echo "ERROR: the stack never became ready"
    exit 1
  fi
}

stop_stack() {
  stop_pid_bounded "$DEV_PID"
  DEV_PID=""
  e2e_project_down --remove-orphans
}

echo "==> Minting keys"
# Before the SPA build: Vite bakes VITE_SUPATYPE_ANON_KEY in at build time, so a key minted after it
# ships an empty string to every caller.
mint_keys "$EXAMPLE_DIR" "$CLI_BIN"

echo "==> Building the SPA"
(cd "$ROOT_DIR" && VITE_SUPATYPE_ANON_KEY="$ANON_KEY" pnpm --filter @supatype/example-kitchen-sink-app build)
[[ -f "$EXAMPLE_DIR/apps/app/dist/index.html" ]] || fail "the SPA build produced no dist/index.html"

echo ""
# Ask for a published database port, and seed over it.
#
# `seed.ts` connects to Postgres over TCP. In dev the port is published only when something on the
# host needs it, which is normally a host engine build, so on a machine without one there was
# nothing listening and the seed failed with ECONNREFUSED. Naming the port is the request; the
# compose generator publishes it because it was named.
SUPATYPE_DEV_DB_PORT="${SUPATYPE_DEV_DB_PORT:-54329}"
env_file_set "$EXAMPLE_DIR/.env" SUPATYPE_DEV_DB_PORT "$SUPATYPE_DEV_DB_PORT"
export SUPATYPE_DEV_DB_PORT

echo "==> OAuth stub provider"
# Before the stack: the auth server reads its providers from .env when it boots.
oauth_stub_start "$ROOT_DIR" "$STUB_PORT" "$STUB_EMAIL" || fail "the OAuth stub never answered"
oauth_stub_point_github "$EXAMPLE_DIR/.env" "$STUB_PORT" "$BASE_URL"

echo "==> Bringing the stack up (static mode: the SPA is what / serves)"
# Opt the functions worker into a database URL, so the path that was broken is the one exercised.
# Set before the stack starts, because compose reads it when the container is created. The in-
# network address, not a published host port: the worker resolves `db`, not `localhost`.
#
# The owner DSN is deliberate here and only here. This is a disposable CI stack asserting the wiring
# works; a real project should point this at a role it restricted, since a function holding this
# bypasses access rules, field masking and model hooks.
# Read on their own lines and checked: inside `export` or a command's env prefix nothing would
# stop on a missing file or key, and both URLs would carry an empty password.
PG_PASSWORD="$(env_file_value "$EXAMPLE_DIR/.env" POSTGRES_PASSWORD)"
PG_DB="$(env_file_value "$EXAMPLE_DIR/.env" POSTGRES_DB)"
if [[ -z "$PG_PASSWORD" || -z "$PG_DB" ]]; then
  echo "ERROR: no POSTGRES_PASSWORD or POSTGRES_DB in $EXAMPLE_DIR/.env"
  exit 1
fi
export SUPATYPE_FUNCTIONS_DB_URL="postgresql://supatype_admin:${PG_PASSWORD}@db:5432/${PG_DB}"
start_stack

echo ""
echo "==> Seeding"
(cd "$EXAMPLE_DIR" && DATABASE_URL="postgresql://supatype_admin:${PG_PASSWORD}@127.0.0.1:${SUPATYPE_DEV_DB_PORT}/${PG_DB}?sslmode=disable" npx tsx seed.ts)

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
  (cd "$ROOT_DIR/tests/e2e" && E2E_BASE_URL="$BASE_URL" SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
    OAUTH_STUB_URL="http://127.0.0.1:${STUB_PORT}" OAUTH_STUB_EMAIL="$STUB_EMAIL" \
    npx playwright test specs/kitchen-sink-oauth.spec.ts) \
    || fail "signing in with GitHub through the stub provider did not pass"
  echo "  ok   the GitHub button signs in end to end and leaves no tokens in the address bar"
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
# `host.docker.internal` that resolves on a Linux runner, the same pair that gates blog-e2e. Adding
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
