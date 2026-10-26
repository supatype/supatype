#!/usr/bin/env bash
# Prove the expo-auth example's sign-in flows work, against a running stack.
#
# The app is React Native, so it runs here as its Expo web build (`expo export --platform web`),
# which renders the same components through react-native-web, and Playwright drives it:
# email and password, magic link and password reset (the links read from an SMTP catcher), and
# OAuth through PKCE against a stub provider the auth server is pointed at. The node smoke script
# the example already had runs too: it covers the client half (secure-store persistence across a
# relaunch, realtime chat, the profile row) that the screens build on. The native-only pieces
# (Secure Store itself, OS deep links) are unit tested in @supatype/react-native.
#
# Usage:
#   bash tests/integration/scripts/expo-auth-e2e.sh
#
# Beside another run, from another checkout: SUPATYPE_E2E_PROJECT names this run's compose project
# and SMTP catcher, and SUPATYPE_KONG_PORT, EXPO_E2E_WEB_PORT, MAILPIT_HTTP_PORT, MAILPIT_SMTP_PORT
# and OAUTH_STUB_PORT move its ports. See lib/e2e-project.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EXAMPLE_DIR="$ROOT_DIR/examples/expo-auth"
E2E_DIR="$ROOT_DIR/tests/e2e"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
BASE_URL="http://127.0.0.1:${KONG_PORT}"
MAX_WAIT="${EXPO_E2E_MAX_WAIT:-300}"
WEB_PORT="${EXPO_E2E_WEB_PORT:-8089}"
MAILPIT_HTTP="${MAILPIT_HTTP_PORT:-18026}"
MAILPIT_SMTP="${MAILPIT_SMTP_PORT:-11026}"
STUB_PORT="${OAUTH_STUB_PORT:-18998}"
# The app is served from a loopback IP: the auth server accepts a redirect to one without an
# allow-list entry, as it accepts the app's own deep link once the README's allow-list step is done.
APP_URL="http://127.0.0.1:${WEB_PORT}"
CONFIG="$EXAMPLE_DIR/supatype.config.ts"

source "$SCRIPT_DIR/lib/http-wait.sh"
source "$SCRIPT_DIR/lib/example-keys.sh"
source "$SCRIPT_DIR/lib/e2e-project.sh"
source "$SCRIPT_DIR/lib/expo-export.sh"

e2e_project_use "$EXAMPLE_DIR" expo-auth
MAILPIT_NAME="$(e2e_scoped supatype-expo-auth-mailpit)"
# Exported so `supatype dev` binds the port this script waits on, rather than the next free one.
export SUPATYPE_KONG_PORT="$KONG_PORT"

DEV_PID=""
BG_PIDS=()
ENV_EXISTED="no"
[[ -f "$EXAMPLE_DIR/.env" ]] && ENV_EXISTED="yes"

cleanup() {
  echo ""
  echo "==> teardown"
  for pid in "${BG_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  stop_pid_bounded "$DEV_PID"
  e2e_project_down
  docker rm -f "$MAILPIT_NAME" >/dev/null 2>&1 || true
  if [[ -f "$CONFIG.e2e-bak" ]]; then mv -f "$CONFIG.e2e-bak" "$CONFIG"; fi
  if [[ "$ENV_EXISTED" == "no" ]]; then rm -f "$EXAMPLE_DIR/.env"; fi
  e2e_project_release
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

fail() { echo "  FAIL $*" >&2; exit 1; }

# Set a key in the example's .env, which `supatype dev` and the auth server both read.
set_env_key() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$EXAMPLE_DIR/.env"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$EXAMPLE_DIR/.env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$EXAMPLE_DIR/.env"
  fi
}

echo "==> The README's setup: .env from the example, then keys"
[[ "$ENV_EXISTED" == "yes" ]] || cp "$EXAMPLE_DIR/.env.example" "$EXAMPLE_DIR/.env"
mint_keys "$EXAMPLE_DIR" "$CLI_BIN"
STUB_EMAIL="octo-${RANDOM}${RANDOM}@example.com"
STUB_URL="http://host.docker.internal:${STUB_PORT}"
set_env_key SUPATYPE_KONG_PORT "$KONG_PORT"
set_env_key PUBLIC_SUPATYPE_URL "$BASE_URL"
set_env_key API_EXTERNAL_URL "$BASE_URL"
set_env_key SITE_URL "$APP_URL"
set_env_key EXPO_PUBLIC_SUPATYPE_URL "$BASE_URL"
set_env_key EXPO_PUBLIC_SUPATYPE_ANON_KEY "$ANON_KEY"
# The auth server loads the project's .env at boot, which is where a provider is configured. The
# stub stands in for GitHub Enterprise: the server sends the browser to <url>/login/oauth/authorize
# and calls <url>/login/oauth/access_token and <url>/api/v3/user itself.
set_env_key SUPATYPE_EXTERNAL_GITHUB_ENABLED true
set_env_key SUPATYPE_EXTERNAL_GITHUB_CLIENT_ID expo-e2e-client
set_env_key SUPATYPE_EXTERNAL_GITHUB_SECRET expo-e2e-secret
set_env_key SUPATYPE_EXTERNAL_GITHUB_URL "$STUB_URL"
set_env_key SUPATYPE_EXTERNAL_GITHUB_REDIRECT_URI "$BASE_URL/auth/v1/callback"

echo "==> SMTP catcher"
docker rm -f "$MAILPIT_NAME" >/dev/null 2>&1 || true
docker run -d --name "$MAILPIT_NAME" -p "${MAILPIT_SMTP}:1025" -p "${MAILPIT_HTTP}:8025" axllent/mailpit:latest >/dev/null
mailpit_ready() { http_ok "http://127.0.0.1:${MAILPIT_HTTP}/api/v1/info"; }
wait_until 60 "mailpit" mailpit_ready || fail "mailpit never came up"
cp "$CONFIG" "$CONFIG.e2e-bak"
node "$SCRIPT_DIR/point-email-at-smtp.mjs" "$CONFIG" "$MAILPIT_SMTP"

echo "==> OAuth stub provider"
OAUTH_STUB_PORT="$STUB_PORT" OAUTH_STUB_EMAIL="$STUB_EMAIL" node "$E2E_DIR/expo-auth/oauth-stub.mjs" &
BG_PIDS+=("$!")
stub_ready() { http_ok "http://127.0.0.1:${STUB_PORT}/calls"; }
wait_until 30 "the OAuth stub" stub_ready || fail "the OAuth stub never answered"

echo "==> Building the app for web"
# EXPO_PUBLIC_* are inlined at build time, so this follows the .env written above. The Metro cache
# is this export's own: a shared one serves another run's URL (lib/expo-export.sh).
expo_web_export "$EXAMPLE_DIR" dist
[[ -f "$EXAMPLE_DIR/dist/index.html" ]] || fail "expo export produced no dist/index.html"
node "$E2E_DIR/expo-auth/spa-server.mjs" "$EXAMPLE_DIR/dist" "$WEB_PORT" &
BG_PIDS+=("$!")

echo "==> Bringing the stack up"
(cd "$EXAMPLE_DIR" && exec node "$CLI_BIN" dev) &
DEV_PID=$!
ready() { dev_started "$EXAMPLE_DIR" && http_ok "$BASE_URL/auth/v1/health" && http_ok "$APP_URL/"; }
if ! wait_until "$MAX_WAIT" "$BASE_URL/auth/v1/health" ready; then
  echo "ERROR: the stack never became ready"
  exit 1
fi

echo ""
echo "==> The client half: persistence, profile, realtime, PKCE helpers (scripts/smoke-native-auth.mts)"
(cd "$EXAMPLE_DIR" && SUPATYPE_URL="$BASE_URL" SUPATYPE_ANON_KEY="$ANON_KEY" npx tsx scripts/smoke-native-auth.mts) \
  || fail "the native auth smoke did not pass"

echo ""
echo "==> The screens: sign-up, sign-in, magic link, password reset, OAuth"
(cd "$E2E_DIR" && EXPO_E2E_APP_URL="$APP_URL" MAILPIT_URL="http://127.0.0.1:${MAILPIT_HTTP}" \
  OAUTH_STUB_URL="http://127.0.0.1:${STUB_PORT}" OAUTH_STUB_EMAIL="$STUB_EMAIL" \
  npx playwright test specs/expo-auth.spec.ts) || fail "the expo-auth web flows did not pass"

echo ""
echo "PASS: expo-auth signs in by password, magic link, reset and OAuth (PKCE)"
