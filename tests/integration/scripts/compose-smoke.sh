#!/usr/bin/env bash
# Smoke-test self-host Docker images (supatype/postgres, supatype/server, etc.).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$INTEGRATION_DIR/../.." && pwd)"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
COMPOSE_DIR="$INTEGRATION_DIR/.supatype/self-host"
BASE_URL="${COMPOSE_SMOKE_URL:-http://localhost:18473}"
MAX_WAIT=120

cleanup() {
  if [[ -d "$COMPOSE_DIR" ]]; then
    (cd "$INTEGRATION_DIR" && node "$CLI_BIN" self-host compose down) || true
  fi
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN — run 'pnpm build' first"
  exit 1
fi

# Pin published Hub tags until the next release.yml run moves :latest (alpha overwrites
# latest while no stable vX.Y.Z tag exists). Override any variable to test :latest after release.
COMPOSE_TAG="${COMPOSE_DOCKER_TAG:-0.1.0-alpha.6}"
export SUPATYPE_STORAGE_IMAGE="${SUPATYPE_STORAGE_IMAGE:-supatype/storage:${COMPOSE_TAG}}"
export SUPATYPE_STUDIO_IMAGE="${SUPATYPE_STUDIO_IMAGE:-supatype/studio:${COMPOSE_TAG}}"
export SUPATYPE_SERVER_IMAGE="${SUPATYPE_SERVER_IMAGE:-supatype/server:v1.0.4-rc.4}"

if [[ -z "${SUPATYPE_FUNCTIONS_WORKER_IMAGE:-}" ]]; then
  echo "==> Building functions-worker image (not published on Docker Hub yet)"
  docker build -t supatype/functions-worker:ci-smoke "$ROOT_DIR/packages/functions-worker"
  export SUPATYPE_FUNCTIONS_WORKER_IMAGE=supatype/functions-worker:ci-smoke
fi

echo "==> Rendering and starting self-host compose"
echo "    storage=${SUPATYPE_STORAGE_IMAGE} server=${SUPATYPE_SERVER_IMAGE} worker=${SUPATYPE_FUNCTIONS_WORKER_IMAGE}"
cd "$INTEGRATION_DIR"
node "$CLI_BIN" self-host compose up -d

echo "==> Waiting for $BASE_URL/auth/v1/health (up to ${MAX_WAIT}s)..."
for i in $(seq 1 "$MAX_WAIT"); do
  if curl -sf "$BASE_URL/auth/v1/health" > /dev/null 2>&1; then
    echo "  Ready after ${i}s"
    exit 0
  fi
  if [[ "$i" -eq "$MAX_WAIT" ]]; then
    echo "  ERROR: Compose stack did not become ready within ${MAX_WAIT}s"
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" ps || true
    exit 1
  fi
  sleep 1
done
