#!/usr/bin/env bash
# Auth, storage and realtime, against one running stack.
#
# These three suites each need a live gateway, a real session and seeded rows, and each used to
# have nowhere to run: this script covered auth alone and nothing invoked it, while the storage
# and realtime harnesses were invoked by nothing at all. A test nothing runs is not a test, and
# two of the bugs they now cover reached a release that way.
#
# They share a stack because the stack is the expensive part. Bringing it up three times to ask
# three questions of it would cost three times the minutes to learn the same thing.
#
# What each one covers:
#   auth-flows.ts     MFA and password reset, plus sessions and RLS. The MFA unit test mocks every
#                     response, so it asserts the shape of the requests and never that a server
#                     accepts them. Password reset had nothing: the console mailer omits the body
#                     on purpose and the stored token is a hash, so this runs an SMTP catcher and
#                     reads the real message.
#   storage-api.ts    The gateway, the rules a bucket declares, and an asset column round trip.
#   realtime-rls.ts   Which subscriber receives a row, and whether exact columns survive the trip.
#
# Usage:
#   bash tests/integration/scripts/data-plane-e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$INTEGRATION_DIR/../.." && pwd)"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
BASE_URL="http://127.0.0.1:${KONG_PORT}"
MAILPIT_HTTP="${MAILPIT_HTTP_PORT:-18025}"
MAILPIT_SMTP="${MAILPIT_SMTP_PORT:-11025}"
MAX_WAIT="${DATA_PLANE_MAX_WAIT:-${AUTH_FLOWS_MAX_WAIT:-300}}"

# Built from this checkout rather than pulled. Both suites assert behaviour that only exists in
# the working tree until a release goes out, so running them against the published tag would test
# the last release and report it as this change passing.
STORAGE_IMAGE="${SUPATYPE_STORAGE_IMAGE:-supatype/storage:ci-dev}"
REALTIME_IMAGE="${SUPATYPE_REALTIME_IMAGE:-supatype/realtime:ci-dev}"

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

# Set a key in the project's `.env`, which is where `supatype dev` reads pinned images and the
# gateway port from.
set_env_key() {
  local key="$1" value="$2"
  touch "$INTEGRATION_DIR/.env"
  if grep -q "^${key}=" "$INTEGRATION_DIR/.env"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$INTEGRATION_DIR/.env"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$INTEGRATION_DIR/.env"
  fi
}

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

echo "==> Building storage and realtime from this checkout"
# The two Dockerfiles do not take the same context. Storage copies a `dist/` that `pnpm build`
# produced, from its own directory; realtime builds from source with the workspace root as context.
if [[ ! -d "$ROOT_DIR/packages/storage/dist" ]]; then
  echo "ERROR: packages/storage/dist is missing, run 'pnpm build' first"
  exit 1
fi
docker build -q -t "$STORAGE_IMAGE" "$ROOT_DIR/packages/storage" >/dev/null
docker build -q -t "$REALTIME_IMAGE" -f "$ROOT_DIR/packages/realtime/Dockerfile" "$ROOT_DIR" >/dev/null

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
# Pin the gateway port into the project's .env before starting, so the stack and this script
# cannot disagree about it.
#
# `.env` is not tracked, so it carries whatever a previous run on this machine left behind. It
# said 18477 here while the script waited on 18473, and the only symptom was five minutes of
# "Still waiting" followed by a timeout that named neither port. CI never saw it, because CI has
# no leftover file. The conformance script pins it for the same reason.
set_env_key "SUPATYPE_KONG_PORT" "$KONG_PORT"
set_env_key "SUPATYPE_STORAGE_IMAGE" "$STORAGE_IMAGE"
set_env_key "SUPATYPE_REALTIME_IMAGE" "$REALTIME_IMAGE"

(cd "$INTEGRATION_DIR" && node "$CLI_BIN" dev) &
DEV_PID=$!

ready() { http_ok "$BASE_URL/auth/v1/health"; }
if ! wait_until "$MAX_WAIT" "$BASE_URL/auth/v1/health" ready; then
  echo "ERROR: the stack never became ready"
  exit 1
fi

ANON_KEY="$(sed -n 's/^ANON_KEY=//p' "$INTEGRATION_DIR/.env" | tr -d '"\r' | head -1)"
# Needed to seed the rows the owner check is made against. Asking whether one user can read
# another user's row is worthless unless the other user's row demonstrably exists.
SERVICE_ROLE_KEY="$(sed -n 's/^SERVICE_ROLE_KEY=//p' "$INTEGRATION_DIR/.env" | tr -d '"\r' | head -1)"
if [[ -z "$ANON_KEY" || -z "$SERVICE_ROLE_KEY" ]]; then
  echo "ERROR: no ANON_KEY or SERVICE_ROLE_KEY in $INTEGRATION_DIR/.env"
  exit 1
fi

cd "$INTEGRATION_DIR"
export SUPATYPE_URL="$BASE_URL"
export MAILPIT_URL="http://127.0.0.1:${MAILPIT_HTTP}"
export ANON_KEY SERVICE_ROLE_KEY

# Each suite runs even when an earlier one failed, and the script fails at the end. Stopping at the
# first failure would hide whether a change broke one thing or three, which is the question worth
# answering when the stack is already up and the remaining suites cost seconds.
FAILED=()
run_suite() {
  local label="$1" script="$2"
  echo ""
  echo "==> $label"
  if npx tsx "$script"; then return 0; fi
  FAILED+=("$label")
  return 0
}

run_suite "auth: MFA, password reset, sessions and RLS" scripts/auth-flows.ts
run_suite "storage: the gateway, bucket rules and an asset column" scripts/storage-api.ts
run_suite "realtime: who receives a row, and what it carries" scripts/realtime-rls.ts

echo ""
if (( ${#FAILED[@]} > 0 )); then
  echo "FAILED: ${#FAILED[@]} suite(s)"
  for suite in "${FAILED[@]}"; do echo "  - $suite"; done
  exit 1
fi
echo "PASSED: auth, storage and realtime all hold against a live stack"
