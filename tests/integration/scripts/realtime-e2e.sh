#!/usr/bin/env bash
# Prove a database change reaches a subscriber, against a running stack.
#
# Realtime is on by default, so every integration script already starts the
# service, and none of them ever subscribed. The only thing they proved was that
# the gateway would upgrade a WebSocket, which a broken realtime does too: the
# socket opens, and no row ever arrives.
#
# So this subscribes, writes, and waits with a deadline. The assertion is on
# delivery, which no amount of checking that a container is up can replace.
#
# Usage:
#   bash tests/integration/scripts/realtime-e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EXAMPLE_DIR="$ROOT_DIR/examples/realtime"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
# IPv4 explicitly: `localhost` resolves to ::1 first on some hosts, where
# Docker's IPv6 forwarder may accept and then reset.
BASE_URL="${REALTIME_E2E_URL:-http://127.0.0.1:${KONG_PORT}}"
MAX_WAIT="${REALTIME_E2E_MAX_WAIT:-300}"

source "$SCRIPT_DIR/lib/http-wait.sh"

DEV_PID=""
cleanup() {
  echo ""
  echo "==> teardown"
  if [[ -n "$DEV_PID" ]]; then kill "$DEV_PID" 2>/dev/null || true; fi
  (cd "$EXAMPLE_DIR" && docker compose -p supatype-realtime down -v --remove-orphans) >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

echo "==> Bringing the stack up"
(cd "$EXAMPLE_DIR" && node "$CLI_BIN" dev) &
DEV_PID=$!

ready() { http_ok "$BASE_URL/auth/v1/health"; }
if ! wait_until "$MAX_WAIT" "$BASE_URL/auth/v1/health" ready; then
  echo "ERROR: the stack never became ready"
  exit 1
fi

echo "==> postgres_changes: subscribe, write, wait"
cd "$EXAMPLE_DIR"
SUPATYPE_URL="$BASE_URL" npx tsx verify.ts

echo ""
echo "==> broadcast and presence, between two clients"
# Separate from the change subscription on purpose: neither touches the
# database, so a stack with broken replication still serves them, and a stack
# with a healthy socket can still fail them.
SUPATYPE_URL="$BASE_URL" npx tsx verify-channels.ts
