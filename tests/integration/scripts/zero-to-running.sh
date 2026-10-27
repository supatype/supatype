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
#   SUPATYPE_ZTR_INSTALL   workspace (default) | cdn, cdn uses install.sh (linux/darwin only; not Windows)
#   SUPATYPE_ZTR_VERSION   CLI version when SUPATYPE_ZTR_INSTALL=cdn (default: latest)
#   SUPATYPE_ZTR_WORK_ROOT Parent dir for the temp project (default: mktemp -d)
#   SUPATYPE_ZTR_MAX_WAIT  Health poll timeout seconds (default: 300)
#   SUPATYPE_ZTR_PROJECT   Project name, so compose project supatype-<name> (default:
#                          SUPATYPE_E2E_PROJECT, then ztr-smoke); set it to run beside another run
#   SUPATYPE_KONG_PORT     Gateway port (default: the one init picks)
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
source "$SCRIPT_DIR/lib/http-wait.sh"
source "$SCRIPT_DIR/lib/compose-reset.sh"
source "$SCRIPT_DIR/lib/pinned-image.sh"

PROJECT_NAME="${SUPATYPE_ZTR_PROJECT:-${SUPATYPE_E2E_PROJECT:-ztr-smoke}}"
# `dev` names the stack after the project, normalised as the CLI does.
COMPOSE_PROJECT="$(compose_project_name "$PROJECT_NAME")"
MAX_WAIT="${SUPATYPE_ZTR_MAX_WAIT:-300}"
INSTALL_MODE="${SUPATYPE_ZTR_INSTALL:-workspace}"
WORK_PARENT="${SUPATYPE_ZTR_WORK_ROOT:-}"
CREATED_WORK_ROOT=""
PROJECT_DIR=""
CLI_SHIM_DIR=""

SUPATYPE_PID=""
FAILED=0

# `dev` stops its containers on the way out and keeps the volumes, as it should for a project
# someone works in. This project is thrown away, and a database volume that outlives it is reused
# by the next run under the same name, which then refuses that run's new password.
# Only once this run has started `dev`: before that the project may be another run's.
remove_stack() {
  [[ -n "$SUPATYPE_PID" ]] || return 0
  remove_compose_project "$COMPOSE_PROJECT"
}

cleanup() {
  echo ""
  echo "==> zero-to-running teardown"
  stop_pid_bounded "$SUPATYPE_PID"
  if [[ "$FAILED" == "1" && "${SUPATYPE_ZTR_KEEP_ON_FAILURE:-}" == "1" ]]; then
    echo "  Keeping work dir and stack for debugging: $CREATED_WORK_ROOT"
  else
    remove_stack
    if [[ -n "$CREATED_WORK_ROOT" && -d "$CREATED_WORK_ROOT" ]]; then rm -rf "$CREATED_WORK_ROOT"; fi
  fi
  if [[ -n "$CLI_SHIM_DIR" ]]; then rm -rf "$CLI_SHIM_DIR"; fi
  echo "  Done."
}
trap cleanup EXIT INT TERM

# The workspace CLI behind a `supatype` of this run's own. It used to be written to
# ~/.supatype/bin, which replaced the developer's installed CLI with this checkout's, and let two
# runs from two checkouts each run the other's build.
install_cli_workspace() {
  if [[ ! -f "$CLI_BIN" ]]; then
    echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first" >&2
    exit 1
  fi
  CLI_SHIM_DIR="$(mktemp -d)"
  cat >"$CLI_SHIM_DIR/supatype" <<SHIM
#!/usr/bin/env bash
exec node "$CLI_BIN" "\$@"
SHIM
  chmod +x "$CLI_SHIM_DIR/supatype"
  export PATH="$CLI_SHIM_DIR:$PATH"
}

install_cli_cdn() {
  SUPATYPE_VERSION="${SUPATYPE_ZTR_VERSION:-latest}" \
    bash "$ROOT_DIR/scripts/install.sh"
  export PATH="$HOME/.supatype/bin:$PATH"
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
  # The images the CLI built from this checkout renders: the engine, server and Postgres pinned in
  # release/images.json, and :latest for the images built here, since a checkout that is not a
  # release has none of its own version.
  local postgres server engine
  postgres="${SUPATYPE_POSTGRES_IMAGE:-$(pinned_image postgres)}"
  server="${SUPATYPE_SERVER_IMAGE:-$(pinned_image server)}"
  engine="${SUPATYPE_ENGINE_IMAGE:-$(pinned_image engine)}"
  pull_hub_image "postgres" "$postgres"
  pull_hub_image "server" "$server"
  pull_hub_image "storage" "${SUPATYPE_STORAGE_IMAGE:-supatype/storage:latest}"
  pull_hub_image "functions-worker" "${SUPATYPE_FUNCTIONS_WORKER_IMAGE:-supatype/functions-worker:latest}"
  pull_hub_image "realtime" "${SUPATYPE_REALTIME_IMAGE:-supatype/realtime:latest}"
  pull_hub_image "studio" "${SUPATYPE_STUDIO_IMAGE:-supatype/studio:latest}"
  pull_hub_image "schema-engine" "$engine"
  pull_hub_image "control-plane" "${SUPATYPE_CONTROL_PLANE_IMAGE:-supatype/control-plane:latest}"
}

# The gateway as the CLI binds it: an exported SUPATYPE_KONG_PORT first, then the one init wrote to
# .env. The other way round, an exported port was bound by the stack and never polled.
resolve_base_url() {
  local project_dir="$1"
  local env_file="$project_dir/.env"
  local kport="${SUPATYPE_KONG_PORT:-}"
  if [[ -z "$kport" && -f "$env_file" ]]; then
    kport="$(grep '^SUPATYPE_KONG_PORT=' "$env_file" | cut -d= -f2- || true)"
  fi
  echo "http://localhost:${kport:-18473}"
}

ztr_health_ready() { http_ok "$ZTR_HEALTH_URL"; }

wait_for_health() {
  ZTR_HEALTH_URL="$1/auth/v1/health"
  wait_until "$MAX_WAIT" "$ZTR_HEALTH_URL" ztr_health_ready
}

dump_failure_logs() {
  local project_dir="$1"
  local compose_file="$project_dir/.supatype/self-host/docker-compose.yml"
  if [[ ! -f "$compose_file" ]]; then
    echo "  (no compose file at $compose_file)"
    return 0
  fi
  # The CLI names the compose project `supatype-<name>`; without -p, compose derives it from the
  # directory and finds no containers, so the dump comes out empty.
  local compose=(docker compose -p "$COMPOSE_PROJECT" -f "$compose_file" --project-directory "$project_dir")
  echo "==> Compose ps"
  "${compose[@]}" ps -a || true
  echo "==> Recent server logs"
  "${compose[@]}" logs --tail 80 server 2>&1 || true
  echo "==> Recent db logs"
  "${compose[@]}" logs --tail 40 db 2>&1 || true
}

# Scaffolds the project under $WORK_PARENT with `init` and sets PROJECT_DIR.
init_project() {
  if [[ -z "$WORK_PARENT" ]]; then
    WORK_PARENT="$(mktemp -d)"
  else
    mkdir -p "$WORK_PARENT"
  fi
  CREATED_WORK_ROOT="$WORK_PARENT"

  echo "==> Removing anything a previous run left in $COMPOSE_PROJECT"
  remove_compose_project "$COMPOSE_PROJECT"

  echo "==> supatype init $PROJECT_NAME (docker default, non-interactive)"
  cd "$WORK_PARENT"
  supatype init "$PROJECT_NAME" -y --no-admin

  PROJECT_DIR="$WORK_PARENT/$PROJECT_NAME"
  if [[ ! -f "$PROJECT_DIR/supatype.config.ts" ]]; then
    echo "ERROR: init did not create $PROJECT_DIR/supatype.config.ts" >&2
    exit 1
  fi
  if ! grep -q 'provider: "docker"' "$PROJECT_DIR/supatype.config.ts"; then
    echo "ERROR: expected provider: \"docker\" in supatype.config.ts" >&2
    grep provider "$PROJECT_DIR/supatype.config.ts" || true
    exit 1
  fi
  echo "  Verified docker provider in supatype.config.ts"
}

main() {
  local start_ts
  start_ts="$(date +%s)"

  echo "==> zero to running (install=$INSTALL_MODE)"
  setup_cli
  supatype --version

  prefetch_hub_images
  init_project

  echo "==> supatype dev --stream"
  cd "$PROJECT_DIR"
  supatype dev --stream --no-watch &
  SUPATYPE_PID=$!

  local base_url
  base_url="$(resolve_base_url "$PROJECT_DIR")"
  if ! wait_for_health "$base_url"; then
    FAILED=1
    dump_failure_logs "$PROJECT_DIR"
    exit 1
  fi

  local elapsed=$(( $(date +%s) - start_ts ))
  echo ""
  echo "==> zero to running passed in ${elapsed}s"
  echo "    install=$INSTALL_MODE init=$PROJECT_NAME url=$base_url"
}

main "$@"
