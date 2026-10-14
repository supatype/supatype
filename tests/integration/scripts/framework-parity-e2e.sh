#!/usr/bin/env bash
# Prove the Vue, Svelte and Solid apps of the framework-parity example do the same thing, against
# one running stack.
#
# The example's premise is that the diff between the three apps is the idiom and nothing else. A
# typecheck cannot tell whether a binding signs in, lists, inserts, receives a realtime insert and
# calls a function the way the other two do. This builds the three apps, serves each with
# `vite preview` on a port of its own (each forwards the API paths to the gateway, as the dev
# server does), and drives all three through the README's five steps with Playwright.
#
# Usage:
#   bash tests/integration/scripts/framework-parity-e2e.sh
#
# Beside another run, from another checkout: SUPATYPE_E2E_PROJECT names this run's compose project,
# SUPATYPE_KONG_PORT moves the gateway and PARITY_PREVIEW_BASE_PORT the three previews. See
# lib/e2e-project.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EXAMPLE_DIR="$ROOT_DIR/examples/framework-parity"
E2E_DIR="$ROOT_DIR/tests/e2e"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
BASE_URL="${PARITY_E2E_URL:-http://127.0.0.1:${KONG_PORT}}"
MAX_WAIT="${PARITY_E2E_MAX_WAIT:-300}"
# One preview port per framework, in the order vue, svelte, solid.
PREVIEW_BASE_PORT="${PARITY_PREVIEW_BASE_PORT:-4311}"
FRAMEWORKS=(vue svelte solid)

source "$SCRIPT_DIR/lib/http-wait.sh"
source "$SCRIPT_DIR/lib/example-keys.sh"
source "$SCRIPT_DIR/lib/e2e-project.sh"

e2e_project_use "$EXAMPLE_DIR" framework-parity
# Exported so `supatype dev` binds the port this script waits on, rather than the next free one.
export SUPATYPE_KONG_PORT="$KONG_PORT"

DEV_PID=""
PREVIEW_PIDS=()
ENV_EXISTED="no"
[[ -f "$EXAMPLE_DIR/.env" ]] && ENV_EXISTED="yes"

cleanup() {
  echo ""
  echo "==> teardown"
  for pid in "${PREVIEW_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  stop_pid_bounded "$DEV_PID"
  e2e_project_down
  if [[ "$ENV_EXISTED" == "no" ]]; then rm -f "$EXAMPLE_DIR/.env"; fi
  e2e_project_release
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

fail() { echo "  FAIL $*" >&2; exit 1; }
preview_port() { echo $((PREVIEW_BASE_PORT + $1)); }

echo "==> Minting keys"
# Before the builds: Vite bakes VITE_SUPATYPE_ANON_KEY into each bundle.
mint_keys "$EXAMPLE_DIR" "$CLI_BIN"

echo "==> Building the three apps"
for fw in "${FRAMEWORKS[@]}"; do
  (cd "$EXAMPLE_DIR" && VITE_SUPATYPE_ANON_KEY="$ANON_KEY" npx vite build --config "vite.$fw.config.ts" >/dev/null)
  [[ -f "$EXAMPLE_DIR/dist/$fw/index.html" ]] || fail "the $fw build produced no dist/$fw/index.html"
  echo "  ok   dist/$fw"
done

echo "==> Bringing the stack up"
(cd "$EXAMPLE_DIR" && exec node "$CLI_BIN" dev) &
DEV_PID=$!

ready() { dev_started "$EXAMPLE_DIR" && http_ok "$BASE_URL/auth/v1/health"; }
if ! wait_until "$MAX_WAIT" "$BASE_URL/auth/v1/health" ready; then
  echo "ERROR: the stack never became ready"
  exit 1
fi

echo "==> Serving each build with vite preview"
# A preview already answering on one of these ports is another run's, and the checks below would
# pass against it: it forwards to whichever gateway it was started for, and serves that run's build.
for i in "${!FRAMEWORKS[@]}"; do
  port="$(preview_port "$i")"
  [[ "$(http_status "http://127.0.0.1:$port/")" == "000" ]] \
    || fail "port $port already answers; set PARITY_PREVIEW_BASE_PORT to three free ports"
done
for i in "${!FRAMEWORKS[@]}"; do
  fw="${FRAMEWORKS[$i]}"
  port="$(preview_port "$i")"
  # Vite itself, exec'd, so the PID the teardown kills is the server. Through npx it was npx's,
  # and killing that left Vite holding the port after the run: the next run on these ports then
  # passed its checks against this run's build and gateway.
  (cd "$EXAMPLE_DIR" && VITE_SUPATYPE_URL="$BASE_URL" exec node node_modules/vite/bin/vite.js preview \
    --config "vite.$fw.config.ts" --host 127.0.0.1 --port "$port" --strictPort) >/dev/null 2>&1 &
  PREVIEW_PIDS+=("$!")
  export "PARITY_$(tr "[:lower:]" "[:upper:]" <<<"$fw")_URL=http://127.0.0.1:$port/"
done
# Each preview must serve its app and forward the API: a 200 from /auth/v1/health through the
# preview port is the gateway answering, not Vite.
previews_ready() {
  local i
  for i in "${!FRAMEWORKS[@]}"; do
    http_ok "http://127.0.0.1:$(preview_port "$i")/auth/v1/health" || return 1
  done
}
if ! wait_until 60 "the three previews" previews_ready; then
  echo "ERROR: a vite preview never answered"
  exit 1
fi

echo ""
echo "==> Driving all three through the same five steps"
(cd "$E2E_DIR" && PARITY_API_URL="$BASE_URL" ANON_KEY="$ANON_KEY" npx playwright test specs/framework-parity.spec.ts) \
  || fail "the three apps did not behave the same"

echo ""
echo "PASS: Vue, Svelte and Solid sign in, list, add, receive and call alike"
