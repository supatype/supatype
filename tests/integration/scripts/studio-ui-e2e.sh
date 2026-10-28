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
#
# Beside another run, from another checkout: SUPATYPE_E2E_PROJECT names this run's compose project,
# and SUPATYPE_KONG_PORT and SUPATYPE_STUDIO_DEV_PORT move its ports. See lib/e2e-project.sh.
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
source "$SCRIPT_DIR/lib/e2e-project.sh"
source "$SCRIPT_DIR/lib/env-file.sh"

e2e_project_use "$INTEGRATION_DIR" supatype-integration
# Exported so `supatype dev` binds the port this script waits on, rather than the next free one.
export SUPATYPE_KONG_PORT="$KONG_PORT"

DEV_PID=""
cleanup() {
  echo ""
  echo "==> teardown"
  stop_pid_bounded "$DEV_PID"
  e2e_project_down
  e2e_project_release
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

# Studio runs with authorization on, as every deployment does. The server used to have a dev
# switch (STUDIO_OPEN_DEV) that let the Studio proxy answer unauthenticated requests with the
# service role key, and this script turned it off so a Studio that sent no Authorization header
# could not pass. The switch is gone, so there is nothing to turn off.
echo "==> Bringing the stack up"
(cd "$INTEGRATION_DIR" && exec node "$CLI_BIN" dev) &
DEV_PID=$!

ready() { dev_started "$INTEGRATION_DIR" && http_ok "$BASE_URL/auth/v1/health"; }
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

# The function-logs spec invokes a function to make it log, and the gateway wants an apikey for
# that. Read from the .env this project just generated rather than hardcoded: the key is per
# project and regenerated on init.
SUPATYPE_ANON_KEY="$(env_file_value "$INTEGRATION_DIR/.env" ANON_KEY || true)"
if [[ -z "$SUPATYPE_ANON_KEY" ]]; then
  echo "ERROR: no ANON_KEY in $INTEGRATION_DIR/.env; the function-logs spec cannot invoke anything."
  exit 1
fi
export SUPATYPE_ANON_KEY

echo "==> Driving the browser"
cd "$E2E_DIR"
# Named rather than "everything in specs/", because that directory is shared. `kitchen-sink-e2e.sh`
# drives its own stack with its own schema and seed, and an unfiltered run pointed its spec at this
# one: ten failures about a conference app, from the job that tests Studio. The kitchen-sink spec
# landed after the last scheduled run, so the first anyone would have seen of it is the whole
# Studio job going red for a reason that has nothing to do with Studio.
#
# A new spec here has to be added to a script deliberately. That is the point: it forces the
# question of which stack it needs.
E2E_BASE_URL="$BROWSER_URL" npx playwright test \
  specs/studio.spec.ts \
  specs/studio-views.spec.ts \
  specs/studio-create-draft.spec.ts \
  specs/function-logs.spec.ts \
  specs/storage.spec.ts
