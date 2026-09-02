#!/usr/bin/env bash
# MFA and password reset, against a running server.
#
# Both were untested. The MFA test mocks every response, so it asserts the shape
# of the requests the client sends and never that a server accepts them. Password
# reset had nothing at all: the console mailer omits the body on purpose, so the
# emailed token was not visible anywhere, and the token stored on the row is a
# hash of it. So this runs an SMTP catcher and reads the real message.
#
# Usage:
#   bash tests/integration/scripts/auth-flows-e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$INTEGRATION_DIR/../.." && pwd)"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
BASE_URL="http://127.0.0.1:${KONG_PORT}"
MAILPIT_HTTP="${MAILPIT_HTTP_PORT:-18025}"
MAILPIT_SMTP="${MAILPIT_SMTP_PORT:-11025}"
MAX_WAIT="${AUTH_FLOWS_MAX_WAIT:-300}"

source "$SCRIPT_DIR/lib/http-wait.sh"

DEV_PID=""
cleanup() {
  echo ""
  echo "==> teardown"
  if [[ -n "$DEV_PID" ]]; then kill "$DEV_PID" 2>/dev/null || true; fi
  docker compose -p supatype-supatype-integration down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f supatype-authflows-mailpit >/dev/null 2>&1 || true
  # Restore the config this script edits so a failure does not leave it changed.
  if [[ -f "$INTEGRATION_DIR/supatype.config.ts.authflows-bak" ]]; then
    mv -f "$INTEGRATION_DIR/supatype.config.ts.authflows-bak" "$INTEGRATION_DIR/supatype.config.ts"
  fi
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

echo "==> SMTP catcher"
docker rm -f supatype-authflows-mailpit >/dev/null 2>&1 || true
docker run -d --name supatype-authflows-mailpit \
  -p "${MAILPIT_SMTP}:1025" -p "${MAILPIT_HTTP}:8025" \
  axllent/mailpit:latest >/dev/null
mailpit_ready() { http_ok "http://127.0.0.1:${MAILPIT_HTTP}/api/v1/info"; }
if ! wait_until 60 "mailpit" mailpit_ready; then
  echo "ERROR: mailpit never came up"
  exit 1
fi

# The server runs in a container, so the catcher is reachable at the host
# gateway rather than at localhost.
echo "==> Pointing the project at it"
cp "$INTEGRATION_DIR/supatype.config.ts" "$INTEGRATION_DIR/supatype.config.ts.authflows-bak"
node "$SCRIPT_DIR/point-email-at-smtp.mjs" "$INTEGRATION_DIR/supatype.config.ts" "$MAILPIT_SMTP"

echo "==> Bringing the stack up"
(cd "$INTEGRATION_DIR" && node "$CLI_BIN" dev) &
DEV_PID=$!

ready() { http_ok "$BASE_URL/auth/v1/health"; }
if ! wait_until "$MAX_WAIT" "$BASE_URL/auth/v1/health" ready; then
  echo "ERROR: the stack never became ready"
  exit 1
fi

ANON_KEY="$(sed -n 's/^ANON_KEY=//p' "$INTEGRATION_DIR/.env" | tr -d '"\r' | head -1)"
if [[ -z "$ANON_KEY" ]]; then
  echo "ERROR: no ANON_KEY in $INTEGRATION_DIR/.env"
  exit 1
fi

echo "==> Running the flows"
cd "$INTEGRATION_DIR"
SUPATYPE_URL="$BASE_URL" \
  MAILPIT_URL="http://127.0.0.1:${MAILPIT_HTTP}" \
  ANON_KEY="$ANON_KEY" \
  npx tsx scripts/auth-flows.ts
