#!/usr/bin/env bash
# Smoke-test self-host Docker images (supatype/postgres, supatype/server, etc.).
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/http-wait.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$INTEGRATION_DIR/../.." && pwd)"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
COMPOSE_DIR="$INTEGRATION_DIR/.supatype/self-host"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
BASE_URL="${COMPOSE_SMOKE_URL:-http://localhost:${KONG_PORT}}"
MAX_WAIT=120

cleanup() {
  if [[ -d "$COMPOSE_DIR" ]]; then
    (cd "$INTEGRATION_DIR" && node "$CLI_BIN" self-host compose down) || true
  fi
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

# Standalone compose requires SERVICE_ROLE_KEY; .env is gitignored so seed it for CI.
node "$SCRIPT_DIR/ensure-compose-env.mjs"

# Defaults match self-host compose (:latest on Docker Hub). Override via SUPATYPE_*_IMAGE to pin a version.
export SUPATYPE_STORAGE_IMAGE="${SUPATYPE_STORAGE_IMAGE:-supatype/storage:latest}"
export SUPATYPE_STUDIO_IMAGE="${SUPATYPE_STUDIO_IMAGE:-supatype/studio:latest}"
export SUPATYPE_SERVER_IMAGE="${SUPATYPE_SERVER_IMAGE:-supatype/server:latest}"
export SUPATYPE_FUNCTIONS_WORKER_IMAGE="${SUPATYPE_FUNCTIONS_WORKER_IMAGE:-supatype/functions-worker:latest}"
export SUPATYPE_CONTROL_PLANE_IMAGE="${SUPATYPE_CONTROL_PLANE_IMAGE:-supatype/control-plane:latest}"

echo "==> Rendering and starting self-host compose"
echo "    storage=${SUPATYPE_STORAGE_IMAGE} server=${SUPATYPE_SERVER_IMAGE} worker=${SUPATYPE_FUNCTIONS_WORKER_IMAGE} control-plane=${SUPATYPE_CONTROL_PLANE_IMAGE}"
cd "$INTEGRATION_DIR"
node "$CLI_BIN" self-host compose up -d

compose_ready() { http_ok "$BASE_URL/auth/v1/health"; }

if ! wait_until "$MAX_WAIT" "$BASE_URL/auth/v1/health" compose_ready; then
  echo "  ERROR: Compose stack did not become ready within ${MAX_WAIT}s"
  docker compose -f "$COMPOSE_DIR/docker-compose.yml" ps || true
  docker logs integration-server-1 2>&1 | tail -20 || true
  exit 1
fi
# Studio's caching and the header-buffer raise, asserted against the running images rather than the
# files that configure them. The unit tests pin the text of packages/studio/nginx.conf; only this
# tier catches the ways that text stops applying: an asset path that moves when VITE_BASE_PATH or
# Vite's assetsDir changes, an add_header reset by a directive added at another level, or a Kong
# buffer smaller than the page's. Every one of those leaves the config saying the right words.
echo "==> Checking Studio caching and header buffers"

smoke_fail() {
  echo "  ERROR: $1" >&2
  exit 1
}

# `|| true` throughout: pipefail would abort the script on a failed request before these could
# report which assertion failed and what came back instead.
shell_cache="$(http_header cache-control "$BASE_URL/studio/" || true)"
case "$shell_cache" in
  *no-cache*) ;;
  *) smoke_fail "the Studio shell must revalidate, or upgrading in place leaves tabs on the previous bundle; cache-control was '${shell_cache:-<absent>}'" ;;
esac

# Taken from the shell rather than hardcoded: the filename is content-hashed and the prefix moves
# with the base path, so a literal here would rot into a test that passes against a 404.
asset_path="$(curl -sf --connect-timeout 3 --max-time 5 "$BASE_URL/studio/" 2>/dev/null \
  | grep -o '/studio/assets/[A-Za-z0-9._-]*\.js' | head -1 || true)"
[[ -n "$asset_path" ]] || smoke_fail "the Studio shell named no hashed asset, so its caching cannot be checked"

asset_status="$(http_status "$BASE_URL$asset_path" || true)"
[[ "$asset_status" == "200" ]] || smoke_fail "the shell names $asset_path but it answered $asset_status, so the asset location no longer matches"

asset_cache="$(http_header cache-control "$BASE_URL$asset_path" || true)"
case "$asset_cache" in
  *immutable*) ;;
  *) smoke_fail "hashed asset $asset_path must be immutable; cache-control was '${asset_cache:-<absent>}'" ;;
esac

# One oversized Cookie line, which is what a developer running several stacks on localhost sends,
# since cookies are not scoped by port. It crosses Kong and then Studio's own nginx, so this covers
# both buffer settings at once and is the only place either is checked against a running server.
big_cookie="smoke=$(head -c 20000 /dev/zero | tr '\0' 'a')"
cookie_status="$(http_status -H "Cookie: $big_cookie" "$BASE_URL/studio/" || true)"
[[ "$cookie_status" == "200" ]] || smoke_fail "a 20KB cookie must survive both hops; Studio answered $cookie_status"

echo "  Studio caching and header buffers OK"

exit 0
