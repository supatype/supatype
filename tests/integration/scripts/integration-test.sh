#!/usr/bin/env bash
# Integration test runner.
#
# Usage:
#   ./scripts/integration-test.sh [--skip-build] [--skip-docker-build]
#
# Environment variables (all optional — override auto-detection):
#   SUPATYPE_ENGINE        Path to local engine binary
#   SUPATYPE_SERVER        Path to local server binary
#   SUPATYPE_POSTGRES_DIR  Path to local Postgres installation directory
#   SUPATYPE_ANON_KEY      Anon key for tests (default: integration-anon-key)
#   SUPATYPE_URL           Base URL for tests (default: http://localhost:54399)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$INTEGRATION_DIR/../.." && pwd)"

resolve_engine_binary() {
  local base="$ROOT_DIR/../supatype-schema-engine/target/release/supatype-engine"
  if [[ -f "${base}.exe" ]]; then
    echo "${base}.exe"
  elif [[ -f "$base" ]]; then
    echo "$base"
  fi
}

resolve_server_binary() {
  local auth_dir="$ROOT_DIR/../supatype-auth"
  if [[ -f "$auth_dir/supatype-server.exe" ]]; then
    echo "$auth_dir/supatype-server.exe"
  elif [[ -f "$auth_dir/supatype-server" ]]; then
    echo "$auth_dir/supatype-server"
  fi
}

SKIP_BUILD=""
SKIP_DOCKER_BUILD=""
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-docker-build) SKIP_DOCKER_BUILD=1 ;;
  esac
done

docker_build_image() {
  local label="$1"
  local tag="$2"
  shift 2
  if [[ -n "$SKIP_DOCKER_BUILD" ]] && docker image inspect "$tag" >/dev/null 2>&1; then
    echo "==> Skipping $label image build ($tag already exists)"
    return 0
  fi
  echo "==> Building $label image ($tag) — may take several minutes..."
  docker build --progress=plain -t "$tag" "$@"
}

docker_pull_image() {
  local label="$1"
  local tag="$2"
  if docker image inspect "$tag" >/dev/null 2>&1; then
    echo "==> Using cached $label image ($tag)"
    return 0
  fi
  echo "==> Pulling $label image ($tag)..."
  docker pull "$tag"
}

SERVER_PID=""
SUPATYPE_PID=""

cleanup() {
  echo ""
  echo "==> Teardown"
  if [[ -n "$SUPATYPE_PID" ]]; then
    kill "$SUPATYPE_PID" 2>/dev/null || true
    # Compose-down during graceful shutdown can hang in CI — bound the wait.
    for _ in $(seq 1 20); do
      if ! kill -0 "$SUPATYPE_PID" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    if kill -0 "$SUPATYPE_PID" 2>/dev/null; then
      echo "  Force-killing hung supatype dev (pid $SUPATYPE_PID)..."
      kill -9 "$SUPATYPE_PID" 2>/dev/null || true
    fi
    wait "$SUPATYPE_PID" 2>/dev/null || true
  fi
  if declare -F stop_compose_stack >/dev/null 2>&1; then
    stop_compose_stack || true
  fi
  if [[ -n "${INTEGRATION_LOCK_DIR:-}" ]]; then
    rmdir "$INTEGRATION_LOCK_DIR" 2>/dev/null || true
  fi
  echo "  Done."
}
trap cleanup EXIT INT TERM

# ── Step 1: Build all components (unless --skip-build) ────────────────────────

if [[ -z "$SKIP_BUILD" ]]; then
  echo "==> Building packages"
  cd "$ROOT_DIR"
  pnpm build

  if [[ -d "$ROOT_DIR/../supatype-schema-engine" ]]; then
    echo "==> Building schema engine (Rust)"
    cd "$ROOT_DIR/../supatype-schema-engine"
    cargo build --release --quiet
    SUPATYPE_ENGINE="${SUPATYPE_ENGINE:-$(resolve_engine_binary)}"
  fi

  if [[ -d "$ROOT_DIR/../supatype-auth" ]]; then
    echo "==> Building supatype-server (Go)"
    cd "$ROOT_DIR/../supatype-auth"
    if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
      go build -o supatype-server.exe .
      SUPATYPE_SERVER="${SUPATYPE_SERVER:-$(resolve_server_binary)}"
    else
      go build -o /tmp/supatype-server-local .
      SUPATYPE_SERVER="${SUPATYPE_SERVER:-/tmp/supatype-server-local}"
    fi
  fi

  echo "==> Building @supatype/realtime"
  cd "$ROOT_DIR"
  pnpm --filter @supatype/realtime build

  cd "$INTEGRATION_DIR"
fi

# ── Step 2: Write supatype.local.config.ts (binary overrides) ─────────────────

echo "==> Configuring integration project"

export SUPATYPE_ENGINE="${SUPATYPE_ENGINE:-$(resolve_engine_binary)}"
export SUPATYPE_SERVER="${SUPATYPE_SERVER:-$(resolve_server_binary)}"
export SUPATYPE_REALTIME="${SUPATYPE_REALTIME:-$ROOT_DIR/packages/realtime/dist/index.js}"
export SUPATYPE_PROVIDER="${SUPATYPE_PROVIDER:-docker}"

node "$SCRIPT_DIR/write-local-config.mjs" "$INTEGRATION_DIR/supatype.local.config.ts"

# ── Step 3: Docker images + supatype dev ─────────────────────────────────────

# Force docker for integration (Windows Git Bash reports MINGW*, not Darwin).
export SUPATYPE_PROVIDER="${SUPATYPE_PROVIDER:-docker}"
BASE_URL="http://localhost:${SUPATYPE_KONG_PORT:-18473}"
export SUPATYPE_URL="$BASE_URL"

cd "$INTEGRATION_DIR"

# Prevent concurrent runs — overlapping runs share one DB and flake on fixed slugs.
INTEGRATION_LOCK_DIR="$INTEGRATION_DIR/.supatype/.integration-test.lock.d"
mkdir -p "$(dirname "$INTEGRATION_LOCK_DIR")"
if ! mkdir "$INTEGRATION_LOCK_DIR" 2>/dev/null; then
  echo "ERROR: Another integration test is already running."
  echo "  Stop other terminals (Ctrl+C) or remove: $INTEGRATION_LOCK_DIR"
  exit 1
fi

COMPOSE_PROJECT="supatype-supatype-integration"
COMPOSE_FILE="$INTEGRATION_DIR/.supatype/self-host/docker-compose.yml"

stop_compose_stack() {
  if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo "  (no compose file — skip)"
    return 0
  fi
  local args=(compose -p "$COMPOSE_PROJECT" --project-directory "$INTEGRATION_DIR" -f "$COMPOSE_FILE")
  if [[ -f "$INTEGRATION_DIR/.env" ]]; then
    args+=(--env-file "$INTEGRATION_DIR/.env")
  fi
  local running
  running="$(docker "${args[@]}" ps -q 2>/dev/null | wc -l | tr -d '[:space:]')"
  if [[ -z "$running" || "$running" == "0" ]]; then
    echo "  (compose stack not running — skip)"
    return 0
  fi
  echo "  Stopping $running container(s)..."
  if command -v timeout >/dev/null 2>&1; then
    timeout 120 docker "${args[@]}" down --remove-orphans >/dev/null 2>&1 || true
  else
    docker "${args[@]}" down --remove-orphans >/dev/null 2>&1 || true
  fi
  echo "  Compose stack stopped."
}

if [[ "$SUPATYPE_PROVIDER" == "docker" ]]; then
  echo "==> Preparing Docker images for integration (first run can take 15–30 min)..."
  echo "==> Stopping any existing compose stack..."
  stop_compose_stack
  PG_SRC=""
  if [[ -d "$ROOT_DIR/../supatype-postgres" ]]; then
    PG_SRC="$ROOT_DIR/../supatype-postgres"
  elif [[ -d "$ROOT_DIR/supatype-postgres" ]]; then
    PG_SRC="$ROOT_DIR/supatype-postgres"
  fi
  if [[ -n "$PG_SRC" ]]; then
    docker_build_image "postgres" "${SUPATYPE_POSTGRES_IMAGE:-supatype/postgres:ci-dev}" "$PG_SRC"
    export SUPATYPE_POSTGRES_IMAGE="${SUPATYPE_POSTGRES_IMAGE:-supatype/postgres:ci-dev}"
  else
    export SUPATYPE_POSTGRES_IMAGE="${SUPATYPE_POSTGRES_IMAGE:-supatype/postgres:latest}"
    docker_pull_image "postgres" "$SUPATYPE_POSTGRES_IMAGE"
  fi
  ENGINE_SRC=""
  if [[ -d "$ROOT_DIR/../supatype-schema-engine" ]]; then
    ENGINE_SRC="$ROOT_DIR/../supatype-schema-engine"
  elif [[ -d "$ROOT_DIR/supatype-schema-engine" ]]; then
    ENGINE_SRC="$ROOT_DIR/supatype-schema-engine"
  fi
  if [[ -n "$ENGINE_SRC" ]]; then
    docker_build_image "schema-engine" "${SUPATYPE_ENGINE_IMAGE:-supatype/schema-engine:ci-dev}" "$ENGINE_SRC"
    export SUPATYPE_ENGINE_IMAGE="${SUPATYPE_ENGINE_IMAGE:-supatype/schema-engine:ci-dev}"
  else
    export SUPATYPE_ENGINE_IMAGE="${SUPATYPE_ENGINE_IMAGE:-supatype/schema-engine:latest}"
    docker_pull_image "schema-engine" "$SUPATYPE_ENGINE_IMAGE"
  fi
  docker_build_image "realtime" "${SUPATYPE_REALTIME_IMAGE:-supatype/realtime:ci-dev}" \
    -f "$ROOT_DIR/packages/realtime/Dockerfile" "$ROOT_DIR"
  export SUPATYPE_REALTIME_IMAGE="${SUPATYPE_REALTIME_IMAGE:-supatype/realtime:ci-dev}"
  if [[ -d "$ROOT_DIR/../supatype-auth" ]]; then
    docker_build_image "server" "${SUPATYPE_SERVER_IMAGE:-supatype/server:ci-dev}" "$ROOT_DIR/../supatype-auth"
    export SUPATYPE_SERVER_IMAGE="${SUPATYPE_SERVER_IMAGE:-supatype/server:ci-dev}"
  else
    export SUPATYPE_SERVER_IMAGE="${SUPATYPE_SERVER_IMAGE:-supatype/server:latest}"
    docker_pull_image "server" "$SUPATYPE_SERVER_IMAGE"
  fi
  echo "==> Building control-plane image for compose dev"
  if [[ -n "$SKIP_DOCKER_BUILD" ]] && docker image inspect "${SUPATYPE_CONTROL_PLANE_IMAGE:-supatype/control-plane:ci-dev}" >/dev/null 2>&1; then
    echo "==> Skipping control-plane image build (${SUPATYPE_CONTROL_PLANE_IMAGE:-supatype/control-plane:ci-dev} already exists)"
  else
    echo "==> Building control-plane image (${SUPATYPE_CONTROL_PLANE_IMAGE:-supatype/control-plane:ci-dev}) — may take several minutes..."
    docker build --progress=plain \
      --build-arg ENGINE_IMAGE="${SUPATYPE_ENGINE_IMAGE:-supatype/schema-engine:ci-dev}" \
      -t "${SUPATYPE_CONTROL_PLANE_IMAGE:-supatype/control-plane:ci-dev}" \
      -f "$ROOT_DIR/packages/self-host-control/Dockerfile" \
      "$ROOT_DIR/packages/self-host-control"
  fi
  export SUPATYPE_CONTROL_PLANE_IMAGE="${SUPATYPE_CONTROL_PLANE_IMAGE:-supatype/control-plane:ci-dev}"
  node "$SCRIPT_DIR/prepare-docker-env.mjs"
fi

echo "==> Starting supatype dev (provider=${SUPATYPE_PROVIDER}, url=${BASE_URL})"

CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN — run 'pnpm build' first"
  exit 1
fi

node "$CLI_BIN" dev &
SUPATYPE_PID=$!

# ── Step 4: Sync URL + anon key from .env (written by supatype dev / ensure-compose-env) ─

ENV_FILE="$INTEGRATION_DIR/.env"
echo "==> Waiting for supatype dev to write API keys to .env (up to 180s)..."
for wait_i in $(seq 1 180); do
  if [[ -f "$ENV_FILE" ]] && grep -q '^ANON_KEY=.' "$ENV_FILE"; then
    if [[ "$SUPATYPE_PROVIDER" == "docker" ]]; then
      kport="$(grep '^SUPATYPE_KONG_PORT=' "$ENV_FILE" | cut -d= -f2- || true)"
      if [[ -n "$kport" ]]; then
        BASE_URL="http://localhost:${kport}"
        export SUPATYPE_URL="$BASE_URL"
      fi
    fi
    anon="$(grep '^ANON_KEY=' "$ENV_FILE" | cut -d= -f2-)"
    if [[ -n "$anon" ]]; then
      export SUPATYPE_ANON_KEY="$anon"
    fi
    service="$(grep '^SERVICE_ROLE_KEY=' "$ENV_FILE" | cut -d= -f2- || true)"
    if [[ -n "$service" ]]; then
      export SUPATYPE_SERVICE_ROLE_KEY="$service"
    fi
    break
  fi
  if (( wait_i % 15 == 0 )); then
    echo "  Still waiting for .env (${wait_i}s)..."
  fi
  sleep 1
done

# ── Step 5: Wait for health ───────────────────────────────────────────────────

MAX_WAIT=300
echo "==> Waiting for $BASE_URL to be ready (up to ${MAX_WAIT}s)..."

for i in $(seq 1 "$MAX_WAIT"); do
  if curl -sf "$BASE_URL/auth/v1/health" > /dev/null 2>&1 \
    && curl -sf "$BASE_URL/realtime/v1/health" > /dev/null 2>&1; then
    echo "  Ready after ${i}s (auth + realtime)"
    break
  fi
  if [[ "$i" -eq "$MAX_WAIT" ]]; then
    echo "  ERROR: Server did not become ready within ${MAX_WAIT}s"
    exit 1
  fi
  sleep 1
done

# Auth/realtime can pass before the initial schema push and before the pinned
# realtime image recreate finishes. Wait for the session lock (written only after
# full compose bootstrap) plus REST schema + live health checks.
export SUPATYPE_ANON_KEY="${SUPATYPE_ANON_KEY:-integration-anon-key}"
export SUPATYPE_SERVICE_ROLE_KEY="${SUPATYPE_SERVICE_ROLE_KEY:-}"
SCHEMA_WAIT_KEY="${SUPATYPE_SERVICE_ROLE_KEY:-$SUPATYPE_ANON_KEY}"
SESSION_LOCK="$INTEGRATION_DIR/.supatype/dev-session.json"
echo "==> Waiting for full stack ready (dev-session + schema post, up to ${MAX_WAIT}s)..."
for i in $(seq 1 "$MAX_WAIT"); do
  code="000"
  if [[ -f "$SESSION_LOCK" ]]; then
    code="$(
      curl -s -o /dev/null -w "%{http_code}" \
        -H "apikey: ${SCHEMA_WAIT_KEY}" \
        -H "Authorization: Bearer ${SCHEMA_WAIT_KEY}" \
        "$BASE_URL/rest/v1/post?select=id&limit=0" || echo "000"
    )"
  fi
  if [[ -f "$SESSION_LOCK" && "$code" == "200" ]] \
    && curl -sf "$BASE_URL/auth/v1/health" > /dev/null 2>&1 \
    && curl -sf "$BASE_URL/realtime/v1/health" > /dev/null 2>&1; then
    echo "  Stack ready after ${i}s (session + post + auth + realtime)"
    break
  fi
  if [[ "$i" -eq "$MAX_WAIT" ]]; then
    echo "  ERROR: Stack not ready within ${MAX_WAIT}s (session=$([[ -f "$SESSION_LOCK" ]] && echo yes || echo no), last HTTP ${code})"
    exit 1
  fi
  # Recover from a flaky initial compose push (transient DB EOF during migration).
  if (( i % 30 == 0 )); then
    echo "  Still waiting (${i}s, session=$([[ -f "$SESSION_LOCK" ]] && echo yes || echo no), HTTP ${code}) — retrying supatype push..."
    node "$CLI_BIN" push || true
  elif (( i % 15 == 0 )); then
    echo "  Still waiting (${i}s, session=$([[ -f "$SESSION_LOCK" ]] && echo yes || echo no), HTTP ${code})..."
  fi
  sleep 1
done

# ── Step 6: Run tests ─────────────────────────────────────────────────────────

echo "==> Running integration tests"
cd "$INTEGRATION_DIR"

pnpm exec node --import tsx/esm --test \
  tests/api.test.ts \
  tests/realtime.test.ts

echo ""
echo "==> All tests passed."
