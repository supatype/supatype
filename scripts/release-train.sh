#!/usr/bin/env bash
# The release train, locally: build every artifact from the candidate commits, tag them `:train`,
# and run every train suite against them, as .github/workflows/release-train.yml does in CI.
#
# Builds happen on this machine's Docker. The suites run inside a runner container with a Docker
# daemon of its own (scripts/release-train/runner.Dockerfile), so their stacks, compose projects
# and ports cannot meet anything already running here.
#
# Usage:
#   bash scripts/release-train.sh --src <root> [options]
#
# <root> holds one checkout per repository: supatype-schema-engine, supatype, supatype-auth,
# supatype-cloud, supatype-postgres. To create them as detached worktrees first:
#   --worktree <name>=<repository path>@<sha>    (repeat per repository)
#
# Options:
#   --skip-build          use the :train images already built
#   --suites "<a> <b>"    run only these suites (default: all, see scripts/release-train/suites.sh)
#   --results <dir>       where results land (default <root>/.train-out/results)
#   --runner <name>       runner container name (default supatype-train-runner)
#   --keep                leave the runner container and its daemon volume for inspection
#
# Environment: TRAIN_TAG tags every image (default train), on this machine and in the runner;
# TRAIN_RELEASE_PORT is the port the cloud build serves the engine release on (default 18899).
#
# Exit status is 0 only when every suite passed. Results: <dir>/summary.md, and per suite
# <dir>/<suite>/{output.log,result.json,containers.log,ledgers.log}.
set -euo pipefail

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$HARNESS/scripts/release-train/lib.sh"

SRC="" RESULTS="" SUITES="" SKIP_BUILD=0 KEEP=0 RUNNER="supatype-train-runner"
WORKTREES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --src) SRC="$2"; shift 2 ;;
    --worktree) WORKTREES+=("$2"); shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --suites) SUITES="$2"; shift 2 ;;
    --results) RESULTS="$2"; shift 2 ;;
    --runner) RUNNER="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) train_die "unknown option: $1" ;;
  esac
done
[[ -n "$SRC" ]] || train_die "--src <root> is required"
mkdir -p "$SRC"
SRC="$(cd "$SRC" && pwd)"
RESULTS="${RESULTS:-$SRC/.train-out/results}"
VOLUME="${RUNNER}-docker"

# Detached worktrees, checked out with LF endings whatever core.autocrlf says: these files end up
# in Linux images and containers, where a CRLF in a script is a syntax error.
make_worktree() {
  local name="${1%%=*}" rest="${1#*=}"
  local repo="${rest%@*}" sha="${rest##*@}"
  [[ -e "$SRC/$name" ]] && train_die "$SRC/$name exists; remove it or drop --worktree $name"
  git -C "$repo" -c core.autocrlf=false worktree add --detach "$SRC/$name" "$sha" >/dev/null
  (cd "$SRC/$name" && git ls-files -z | xargs -0 rm -f && git -c core.autocrlf=false checkout -- .)
  train_log "worktree $name at $(git -C "$SRC/$name" rev-parse --short HEAD)"
}

record_shas() {
  local r
  for r in "${TRAIN_REPOS[@]}"; do
    printf '%s %s\n' "$r" "$(git -C "$SRC/$r" rev-parse HEAD)"
  done
}

runner() { docker_nc exec -i "$RUNNER" "$@"; }

start_runner() {
  docker build -q -t supatype-train-runner:train -f "$HARNESS/scripts/release-train/runner.Dockerfile" "$HARNESS/scripts/release-train" >/dev/null
  docker rm -f "$RUNNER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  docker_nc run -d --privileged --name "$RUNNER" -v "$VOLUME:/var/lib/docker" supatype-train-runner:train >/dev/null
  local deadline=$((SECONDS + 120))
  until runner docker info >/dev/null 2>&1; do
    (( SECONDS < deadline )) || train_die "the runner's Docker daemon did not start"
    sleep 2
  done
  train_log "runner $RUNNER up"
}

stop_runner() {
  [[ "$KEEP" == 1 ]] && { train_log "kept runner $RUNNER and volume $VOLUME"; return; }
  docker rm -f "$RUNNER" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}

# Tracked and untracked-but-not-ignored files: the tree as it stands, without node_modules,
# build output or anything a previous run generated.
copy_tree() {
  local from="$1" to="$2"
  runner mkdir -p "$to"
  (cd "$from" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | runner tar -xf - -C "$to"
}

load_images() {
  local images=() c
  for c in "${TRAIN_COMPONENTS[@]}"; do images+=("$(train_image "$c")"); done
  train_log "loading ${#images[@]} images into the runner"
  docker save "${images[@]}" | runner docker load >/dev/null
}

run_in_runner() {
  runner bash -c "
    export TRAIN_ISOLATED=1 TRAIN_TAG=$TRAIN_TAG TRAIN_NETWORK_CONCURRENCY=${TRAIN_NETWORK_CONCURRENCY:-16} TRAIN_SUPATYPE_DIR=/work/supatype TRAIN_ENGINE_DIR=/work/supatype-schema-engine
    export TRAIN_ENGINE_BIN=/work/engine/supatype-engine-linux-amd64 TRAIN_HARNESS_DIR=/work/harness
    export SUPATYPE_RELEASE_PUBLIC_KEY=\"\$(grep -o 'RW[A-Za-z0-9+/=]\{40,\}' /work/supatype/scripts/install.sh | head -1)\"
    cd /work/harness
    bash scripts/release-train/prepare.sh && bash scripts/release-train/run-all.sh /work/results $SUITES"
}

for w in "${WORKTREES[@]}"; do make_worktree "$w"; done
for r in "${TRAIN_REPOS[@]}"; do [[ -e "$SRC/$r/.git" ]] || train_die "$SRC/$r is not a checkout"; done
mkdir -p "$RESULTS"
record_shas | tee "$RESULTS/shas.txt"

started=$SECONDS
[[ "$SKIP_BUILD" == 1 ]] || bash "$HARNESS/scripts/release-train/build.sh" --src "$SRC"
train_log "build phase: $((SECONDS - started))s"

trap stop_runner EXIT
start_runner
for r in "${TRAIN_REPOS[@]}"; do copy_tree "$SRC/$r" "/work/$r"; done
copy_tree "$HARNESS" /work/harness
runner mkdir -p /work/engine
docker_nc cp "$(host_path "$SRC/.train-out/supatype-engine-linux-amd64")" "$RUNNER:/work/engine/supatype-engine-linux-amd64"
load_images

status=0
run_in_runner || status=$?
docker_nc cp "$RUNNER:/work/results/." "$(host_path "$RESULTS")/" >/dev/null 2>&1 || true
train_log "train finished in $((SECONDS - started))s, status $status; results in $RESULTS"
exit "$status"
