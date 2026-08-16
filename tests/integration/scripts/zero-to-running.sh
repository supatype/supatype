#!/usr/bin/env bash
# Zero to running: a new project from nothing to an API that answers, on the docker-default init
# path. Phase-10.6 row C21 asked for it; the name says what it does.
#
# Simulates: install CLI → supatype init → supatype dev → healthy API.
#
# Usage:
#   bash tests/integration/scripts/zero-to-running.sh
#
# Environment:
#   SUPATYPE_ZTR_INSTALL   workspace (default) | cdn  — cdn uses install.sh (linux/darwin only; not Windows)
#   SUPATYPE_ZTR_VERSION   CLI version when SUPATYPE_ZTR_INSTALL=cdn (default: latest)
#   SUPATYPE_ZTR_WORK_ROOT Parent dir for the temp project (default: mktemp -d)
#   SUPATYPE_ZTR_MAX_WAIT  Health poll timeout seconds (default: 300)
#   SUPATYPE_RELEASE_PUBLIC_KEY  Required for init binary prefetch (CDN engine)
#   SUPATYPE_*_IMAGE       Optional Docker Hub pins (default :latest)
#
# CI (integration.yml):
#   - workspace matrix: ubuntu-22.04 + macos-14 (Colima for Docker on macOS)
#   - CDN job: ubuntu-22.04 on schedule / main push / workflow_dispatch

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"

PROJECT_NAME="${SUPATYPE_ZTR_PROJECT:-ztr-smoke}"
MAX_WAIT="${SUPATYPE_ZTR_MAX_WAIT:-300}"
INSTALL_MODE="${SUPATYPE_ZTR_INSTALL:-workspace}"
WORK_PARENT="${SUPATYPE_ZTR_WORK_ROOT:-}"
CREATED_WORK_ROOT=""

SUPATYPE_PID=""
FAILED=0

cleanup() {
  echo ""
  echo "==> zero-to-running teardown"
  if [[ -n "$SUPATYPE_PID" ]]; then
    kill "$SUPATYPE_PID" 2>/dev/null || true
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
  if [[ -n "$CREATED_WORK_ROOT" && -d "$CREATED_WORK_ROOT" ]]; then
    if [[ "$FAILED" == "1" && "${SUPATYPE_ZTR_KEEP_ON_FAILURE:-}" == "1" ]]; then
      echo "  Keeping work dir for debugging: $CREATED_WORK_ROOT"
    else
      rm -rf "$CREATED_WORK_ROOT"
    fi
  fi
  echo "  Done."
}
trap cleanup EXIT INT TERM

install_cli_workspace() {
  if [[ ! -f "$CLI_BIN" ]]; then
    echo "ERROR: CLI not found at $CLI_BIN — run 'pnpm build' first" >&2
    exit 1
  fi
  mkdir -p "$HOME/.supatype/bin"
  cat >"$HOME/.supatype/bin/supatype" <<EOF
#!/usr/bin/env bash
exec node "$CLI_BIN" "\$@"
EOF
  chmod +x "$HOME/.supatype/bin/supatype"
}

install_cli_cdn() {
  SUPATYPE_VERSION="${SUPATYPE_ZTR_VERSION:-latest}" \
    bash "$ROOT_DIR/scripts/install.sh"
}

setup_cli() {
  case "$INSTALL_MODE" in
    workspace) install_cli_workspace ;;
    cdn) install_cli_cdn ;;
    *)
      echo "ERROR: unknown SUPATYPE_ZTR_INSTALL=$INSTALL_MODE (use workspace or cdn)" >&2
      exit 1
      ;;
  esac
  export PATH="$HOME/.supatype/bin:$PATH"
}

pull_hub_image() {
  local label="$1"
  local tag="$2"
  if docker image inspect "$tag" >/dev/null 2>&1; then
    echo "  Using cached $label ($tag)"
    return 0
  fi
  echo "  Pulling $label ($tag)..."
  docker pull "$tag"
}

prefetch_hub_images() {
  echo "==> Prefetching Docker Hub images (first run can take several minutes)..."
  pull_hub_image "postgres" "${SUPATYPE_POSTGRES_IMAGE:-supatype/postgres:latest}"
  pull_hub_image "server" "${SUPATYPE_SERVER_IMAGE:-supatype/server:latest}"
  pull_hub_image "storage" "${SUPATYPE_STORAGE_IMAGE:-supatype/storage:latest}"
  pull_hub_image "functions-worker" "${SUPATYPE_FUNCTIONS_WORKER_IMAGE:-supatype/functions-worker:latest}"
  pull_hub_image "realtime" "${SUPATYPE_REALTIME_IMAGE:-supatype/realtime:latest}"
  pull_hub_image "studio" "${SUPATYPE_STUDIO_IMAGE:-supatype/studio:latest}"
  pull_hub_image "schema-engine" "${SUPATYPE_ENGINE_IMAGE:-supatype/schema-engine:latest}"
  pull_hub_image "control-plane" "${SUPATYPE_CONTROL_PLANE_IMAGE:-supatype/control-plane:latest}"
}

resolve_base_url() {
  local project_dir="$1"
  local env_file="$project_dir/.env"
  local kport=""
  if [[ -f "$env_file" ]]; then
    kport="$(grep '^SUPATYPE_KONG_PORT=' "$env_file" | cut -d= -f2- || true)"
  fi
  if [[ -z "$kport" ]]; then
    kport="${SUPATYPE_KONG_PORT:-18473}"
  fi
  echo "http://localhost:${kport}"
}

wait_for_health() {
  local base_url="$1"
  echo "==> Waiting for $base_url/auth/v1/health (up to ${MAX_WAIT}s)..."
  local i
  for i in $(seq 1 "$MAX_WAIT"); do
    if curl -sf "$base_url/auth/v1/health" >/dev/null 2>&1; then
      echo "  API ready after ${i}s"
      return 0
    fi
    if (( i % 30 == 0 )); then
      echo "  Still waiting (${i}s)..."
    fi
    sleep 1
  done
  echo "ERROR: API did not become ready within ${MAX_WAIT}s" >&2
  return 1
}

dump_failure_logs() {
  local project_dir="$1"
  local compose_file="$project_dir/.supatype/self-host/docker-compose.yml"
  if [[ ! -f "$compose_file" ]]; then
    echo "  (no compose file at $compose_file)"
    return 0
  fi
  echo "==> Compose ps"
  docker compose -f "$compose_file" --project-directory "$project_dir" ps -a || true
  echo "==> Recent server logs"
  docker compose -f "$compose_file" --project-directory "$project_dir" logs --tail 40 server 2>&1 || true
  echo "==> Recent db logs"
  docker compose -f "$compose_file" --project-directory "$project_dir" logs --tail 40 db 2>&1 || true
}

main() {
  local start_ts
  start_ts="$(date +%s)"

  echo "==> zero to running (install=$INSTALL_MODE)"
  setup_cli
  supatype --version

  prefetch_hub_images

  if [[ -z "$WORK_PARENT" ]]; then
    WORK_PARENT="$(mktemp -d)"
  else
    mkdir -p "$WORK_PARENT"
  fi
  CREATED_WORK_ROOT="$WORK_PARENT"

  echo "==> supatype init $PROJECT_NAME (docker default, non-interactive)"
  cd "$WORK_PARENT"
  supatype init "$PROJECT_NAME" -y --no-admin

  local project_dir="$WORK_PARENT/$PROJECT_NAME"
  if [[ ! -f "$project_dir/supatype.config.ts" ]]; then
    echo "ERROR: init did not create $project_dir/supatype.config.ts" >&2
    exit 1
  fi
  if ! grep -q 'provider: "docker"' "$project_dir/supatype.config.ts"; then
    echo "ERROR: expected provider: \"docker\" in supatype.config.ts" >&2
    grep provider "$project_dir/supatype.config.ts" || true
    exit 1
  fi
  echo "  Verified docker provider in supatype.config.ts"

  echo "==> supatype dev --stream"
  cd "$project_dir"
  supatype dev --stream --no-watch &
  SUPATYPE_PID=$!

  local base_url
  base_url="$(resolve_base_url "$project_dir")"
  if ! wait_for_health "$base_url"; then
    FAILED=1
    dump_failure_logs "$project_dir"
    exit 1
  fi

  local elapsed=$(( $(date +%s) - start_ts ))
  echo ""
  echo "==> zero to running passed in ${elapsed}s"
  echo "    install=$INSTALL_MODE init=$PROJECT_NAME url=$base_url"
}

main "$@"
