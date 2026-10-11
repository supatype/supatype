#!/usr/bin/env bash
# Build the release train's artifacts from one source root.
#
# The source root holds the five repositories, each checked out at its candidate SHA:
#   <src>/supatype-schema-engine  <src>/supatype  <src>/supatype-auth
#   <src>/supatype-cloud          <src>/supatype-postgres
#
# Every image is built from those checkouts with the repository's own Dockerfile and tagged
# `:train` (TRAIN_TAG). Nothing is pulled in place of a build: the point of the train is that what
# is tested is exactly what was built from the named commits.
#
# The engine is built once. Its image is the one the stack runs, the control plane copies its
# binary out of that image, and the binary the CLI runs on the host is extracted from it too
# (written to <out>/supatype-engine-linux-<arch>). The cloud image builds the engine from the same
# engine checkout, so all of them come from one engine commit.
#
# Usage:
#   bash scripts/release-train/build.sh --src <root> [--out <dir>] [component ...]
# Components: engine server postgres studio storage realtime functions-worker control-plane cloud.
# With none named, all are built, engine first.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

SRC=""
OUT=""
WANT=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --src) SRC="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) WANT+=("$1"); shift ;;
  esac
done
[[ -n "$SRC" ]] || train_die "--src <root> is required"
SRC="$(cd "$SRC" && pwd)"
OUT="${OUT:-$SRC/.train-out}"
mkdir -p "$OUT"
[[ ${#WANT[@]} -gt 0 ]] || WANT=("${TRAIN_COMPONENTS[@]}")

require_repo() { [[ -d "$SRC/$1/.git" || -f "$SRC/$1/.git" ]] || train_die "$SRC/$1 is not a checkout"; }

# Studio, realtime and the storage prebuild take the whole supatype checkout as their build
# context, and it has no .dockerignore. An installed checkout sends its node_modules with each of
# them (700 MB, which on Docker Desktop took longer than every build together), and could leak a
# host-built module into an image. The train builds from clean checkouts only.
if [[ -d "$SRC/supatype/node_modules" ]]; then
  train_die "$SRC/supatype has node_modules; build from a clean checkout (git clean -fdx there)"
fi

build_image() {
  local component="$1" context="$2"
  shift 2
  local tag
  tag="$(train_image "$component")"
  train_log "build $component -> $tag"
  docker build --pull=false -t "$tag" "$@" "$context"
}

build_engine() {
  require_repo supatype-schema-engine
  build_image engine "$SRC/supatype-schema-engine"
  extract_engine_binary
}

# The binary the CLI runs on the host, taken out of the image that was just built rather than
# compiled a second time, so the host and the stack run one build of one commit.
extract_engine_binary() {
  local arch id dest
  arch="$(docker image inspect "$(train_image engine)" --format '{{.Architecture}}')"
  dest="$OUT/supatype-engine-linux-${arch}"
  id="$(docker create "$(train_image engine)")"
  docker cp "$id:/usr/local/bin/supatype-engine" "$dest"
  docker rm "$id" >/dev/null
  chmod +x "$dest"
  train_log "engine binary -> $dest"
}

build_server() { require_repo supatype-auth; build_image server "$SRC/supatype-auth"; }
build_postgres() { require_repo supatype-postgres; build_image postgres "$SRC/supatype-postgres"; }

build_studio() {
  require_repo supatype
  build_image studio "$SRC/supatype" -f "$SRC/supatype/packages/studio/Dockerfile"
}

build_realtime() {
  require_repo supatype
  build_image realtime "$SRC/supatype" -f "$SRC/supatype/packages/realtime/Dockerfile"
}

build_functions_worker() {
  require_repo supatype
  build_image functions-worker "$SRC/supatype/packages/functions-worker"
}

# The storage Dockerfile copies a prebuilt dist/, as release.yml builds it first. It is compiled in
# a build stage and only dist/ is exported back, so the checkout gains no node_modules (which would
# be sent with every later build context). A build stage rather than a bind mount: on Docker Desktop
# for Windows a container copying a mounted checkout ran for fifteen minutes without finishing.
build_storage() {
  require_repo supatype
  train_log "prebuild packages/storage/dist"
  rm -rf "$SRC/supatype/packages/storage/dist"
  docker build --pull=false -f - --output "type=local,dest=$SRC/supatype/packages/storage/dist" "$SRC/supatype" <<'DOCKERFILE'
FROM node:22-bookworm AS dist
WORKDIR /w
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile --filter "@supatype/storage..." && pnpm --filter @supatype/storage build
FROM scratch
COPY --from=dist /w/packages/storage/dist /
DOCKERFILE
  build_image storage "$SRC/supatype/packages/storage"
}

# The self-host control plane takes its engine binary from the train's engine image.
build_control_plane() {
  require_repo supatype
  docker image inspect "$(train_image engine)" >/dev/null 2>&1 || train_die "build engine before control-plane"
  build_image control-plane "$SRC/supatype/packages/self-host-control" \
    -f "$SRC/supatype/packages/self-host-control/Dockerfile" \
    --build-arg "ENGINE_IMAGE=$(train_image engine)"
}

# Cloud's Dockerfile builds from the parent of supatype-cloud/ and supatype-schema-engine/, so its
# engine comes from the same engine checkout as everything else. The ignore file keeps the other
# repositories (and any node_modules or target directory) out of the build context.
build_cloud() {
  require_repo supatype-cloud
  require_repo supatype-schema-engine
  cat >"$SRC/.dockerignore" <<'IGNORE'
*
!supatype-cloud
!supatype-schema-engine
**/node_modules
**/target
**/.git
IGNORE
  build_image cloud "$SRC" -f "$SRC/supatype-cloud/Dockerfile"
}

for component in "${WANT[@]}"; do
  case "$component" in
    engine) build_engine ;;
    server) build_server ;;
    postgres) build_postgres ;;
    studio) build_studio ;;
    storage) build_storage ;;
    realtime) build_realtime ;;
    functions-worker) build_functions_worker ;;
    control-plane) build_control_plane ;;
    cloud) build_cloud ;;
    *) train_die "unknown component: $component" ;;
  esac
done
train_log "built: ${WANT[*]}"
