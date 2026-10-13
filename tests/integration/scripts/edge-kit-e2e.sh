#!/usr/bin/env bash
# Prove the edge kit's functions behave as its README says, against a running stack.
#
# The example is the functions showcase: env injection, auth gates, the service-role gate, a
# PostgREST write from Deno and a webhook HMAC check. Its README ended in a manual checklist, and
# nothing ran it. This starts the stack the way the README does, deploys the functions with it,
# and calls each one through the gateway (`/functions/v1/<name>`), anonymous and signed in. The
# assertions themselves are in edge-kit.ts.
#
# Usage:
#   bash tests/integration/scripts/edge-kit-e2e.sh
#
# Beside another run, from another checkout: SUPATYPE_E2E_PROJECT names this run's compose project
# and SUPATYPE_KONG_PORT moves the gateway. See lib/e2e-project.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$INTEGRATION_DIR/../.." && pwd)"
EXAMPLE_DIR="$ROOT_DIR/examples/edge-kit"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
# IPv4 explicitly: `localhost` resolves to ::1 first on some hosts, where Docker's IPv6 forwarder
# may accept and then reset.
BASE_URL="${EDGE_KIT_E2E_URL:-http://127.0.0.1:${KONG_PORT}}"
MAX_WAIT="${EDGE_KIT_E2E_MAX_WAIT:-300}"
FUNCTIONS_ENV="$EXAMPLE_DIR/functions/.env.local"

source "$SCRIPT_DIR/lib/http-wait.sh"
source "$SCRIPT_DIR/lib/example-keys.sh"
source "$SCRIPT_DIR/lib/e2e-project.sh"

e2e_project_use "$EXAMPLE_DIR" edge-kit
# Exported so `supatype dev` binds the port this script waits on, rather than the next free one.
export SUPATYPE_KONG_PORT="$KONG_PORT"

DEV_PID=""
ENV_EXISTED="no"
FUNCTIONS_ENV_EXISTED="no"
[[ -f "$EXAMPLE_DIR/.env" ]] && ENV_EXISTED="yes"
[[ -f "$FUNCTIONS_ENV" ]] && FUNCTIONS_ENV_EXISTED="yes"

cleanup() {
  echo ""
  echo "==> teardown"
  if [[ -n "$DEV_PID" ]]; then kill "$DEV_PID" 2>/dev/null || true; fi
  e2e_project_down
  # Both hold secrets and neither is tracked, so a failure must not leave one behind.
  if [[ "$ENV_EXISTED" == "no" ]]; then rm -f "$EXAMPLE_DIR/.env"; fi
  if [[ "$FUNCTIONS_ENV_EXISTED" == "no" ]]; then rm -f "$FUNCTIONS_ENV"; fi
  e2e_project_release
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

echo "==> Minting keys"
mint_keys "$EXAMPLE_DIR" "$CLI_BIN"

# The README's setup step: the webhook secret the functions read comes from this file.
if [[ "$FUNCTIONS_ENV_EXISTED" == "no" ]]; then
  cp "$EXAMPLE_DIR/functions/.env.local.example" "$FUNCTIONS_ENV"
fi
WEBHOOK_SECRET="$(sed -n 's/^WEBHOOK_SECRET=//p' "$FUNCTIONS_ENV" | tr -d '"\r' | tail -1)"
if [[ -z "$WEBHOOK_SECRET" ]]; then
  echo "ERROR: no WEBHOOK_SECRET in $FUNCTIONS_ENV"
  exit 1
fi

echo "==> Bringing the stack up (this deploys the functions)"
(cd "$EXAMPLE_DIR" && node "$CLI_BIN" dev) &
DEV_PID=$!

ready() { dev_started "$EXAMPLE_DIR" && http_ok "$BASE_URL/auth/v1/health"; }
if ! wait_until "$MAX_WAIT" "$BASE_URL/auth/v1/health" ready; then
  echo "ERROR: the stack never became ready"
  exit 1
fi

# The worker loads the functions after the gateway answers, so the first invoke gets its own wait.
functions_ready() {
  [[ "$(http_status -X POST -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" "$BASE_URL/functions/v1/ping")" == "200" ]]
}
if ! wait_until 120 "the functions worker" functions_ready; then
  echo "ERROR: /functions/v1/ping never answered 200"
  exit 1
fi

cd "$INTEGRATION_DIR"
SUPATYPE_URL="$BASE_URL" ANON_KEY="$ANON_KEY" WEBHOOK_SECRET="$WEBHOOK_SECRET" npx tsx scripts/edge-kit.ts

echo ""
echo "PASS: the edge kit's functions behave as documented"
