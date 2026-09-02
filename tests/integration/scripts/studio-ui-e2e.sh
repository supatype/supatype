#!/usr/bin/env bash
# Studio's UI, in a browser, against a running stack.
#
# Everything else here tests Studio's server surface: the bundle is served 200,
# /studio/session answers, /studio-config answers. None of that notices a bundle
# that loads and then throws, an asset referenced at the wrong base path, or a
# sign-in form wired to nothing.
#
# Usage:
#   bash tests/integration/scripts/studio-ui-e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$INTEGRATION_DIR/../.." && pwd)"
E2E_DIR="$ROOT_DIR/tests/e2e"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
# Two URLs for one stack, deliberately.
#
# The health polling uses 127.0.0.1, because `localhost` resolves to ::1 first on
# some hosts where Docker's IPv6 forwarder accepts and then resets.
#
# The browser uses localhost, because Studio is configured with an API URL and
# has to be opened on that same origin. Serve the page from 127.0.0.1 while the
# config says localhost and they are different origins: every credentialed
# request through /studio/proxy is then refused by CORS and each view reads
# "Failed to fetch", which is indistinguishable from a broken view.
BASE_URL="http://127.0.0.1:${KONG_PORT}"
BROWSER_URL="http://localhost:${KONG_PORT}"
MAX_WAIT="${STUDIO_UI_MAX_WAIT:-300}"

# A fresh admin per run: the sign-in test asserts a session is accepted, and
# reusing one hides a password that stopped working.
STUDIO_E2E_EMAIL="studio-ui-$(date +%s)@example.com"
STUDIO_E2E_PASSWORD="StudioUI123!"
export STUDIO_E2E_EMAIL STUDIO_E2E_PASSWORD

source "$SCRIPT_DIR/lib/http-wait.sh"

DEV_PID=""
cleanup() {
  echo ""
  echo "==> teardown"
  if [[ -n "$DEV_PID" ]]; then kill "$DEV_PID" 2>/dev/null || true; fi
  docker compose -p supatype-supatype-integration down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

echo "==> Bringing the stack up"
(cd "$INTEGRATION_DIR" && node "$CLI_BIN" dev) &
DEV_PID=$!

ready() { http_ok "$BASE_URL/auth/v1/health"; }
if ! wait_until "$MAX_WAIT" "$BASE_URL/auth/v1/health" ready; then
  echo "ERROR: the stack never became ready"
  exit 1
fi

studio_ready() { http_ok "$BASE_URL/studio/"; }
if ! wait_until 120 "$BASE_URL/studio/" studio_ready; then
  echo "ERROR: Studio never answered"
  exit 1
fi

# Studio reads its model and database views from the admin config the engine
# writes on push. Without it every view is the "No schema has been pushed yet"
# screen, and the specs fail for a reason that has nothing to do with the UI.
echo "==> Making sure the schema is pushed"
if [[ ! -f "$INTEGRATION_DIR/.supatype/admin-config.json" ]]; then
  (cd "$INTEGRATION_DIR" && node "$CLI_BIN" push --yes)
fi
if [[ ! -f "$INTEGRATION_DIR/.supatype/admin-config.json" ]]; then
  echo "ERROR: no .supatype/admin-config.json after push."
  echo "       The host engine must be downloadable: set SUPATYPE_RELEASE_PUBLIC_KEY,"
  echo "       or SUPATYPE_ALLOW_UNVERIFIED_DOWNLOADS=1 locally."
  exit 1
fi

echo "==> Creating the Studio admin"
(cd "$INTEGRATION_DIR" && node "$CLI_BIN" admin create-user \
  --email "$STUDIO_E2E_EMAIL" --password "$STUDIO_E2E_PASSWORD" --role admin)

echo "==> Driving the browser"
cd "$E2E_DIR"
E2E_BASE_URL="$BROWSER_URL" npx playwright test
