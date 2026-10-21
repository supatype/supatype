#!/usr/bin/env bash
# shellcheck disable=SC2034 # sourced: the scripts that source this read its arrays.
# Shared names for the release train: which repository each artifact comes from, and what it is
# tagged. Sourced by build.sh, run-suite.sh and the local entry point, so the image names a suite
# is pointed at and the image names the build produces cannot drift apart.

# Every artifact carries this tag. CI and the local script both use `train` unless told otherwise.
TRAIN_TAG="${TRAIN_TAG:-train}"

# The five repositories, as directory names under the source root. CI checks each one out at the
# SHA it was given; the local script makes a detached worktree per repository.
#
# The directory names are the repositories' old names and stay that way on purpose: cloud's
# Dockerfile builds from the parent of `supatype-cloud/` and copies paths under it, the integration
# scripts look for `../supatype-schema-engine` and its siblings, and every local train is started
# with `--worktree supatype-schema-engine=<path>@<sha>` and the like. Only the GitHub name changed,
# so CI maps each directory to its repository with train_github_repo.
TRAIN_REPOS=(supatype-schema-engine supatype supatype-auth supatype-cloud supatype-postgres)

# The GitHub repository (under the owner) a train directory is fetched from. The old names 404 with
# no redirect, so CI must never build a URL from the directory name itself.
train_github_repo() {
  case "$1" in
    supatype-schema-engine) echo schema-engine ;;
    supatype) echo supatype ;;
    supatype-auth) echo server ;;
    supatype-cloud) echo cloud ;;
    supatype-postgres) echo postgres ;;
    *) echo "unknown train repository: $1" >&2; return 1 ;;
  esac
}

# Images the stack runs, by the SUPATYPE_*_IMAGE variable the CLI's compose file reads.
train_image() {
  case "$1" in
    engine) echo "supatype/schema-engine:${TRAIN_TAG}" ;;
    server) echo "supatype/server:${TRAIN_TAG}" ;;
    postgres) echo "supatype/postgres:${TRAIN_TAG}" ;;
    studio) echo "supatype/studio:${TRAIN_TAG}" ;;
    storage) echo "supatype/storage:${TRAIN_TAG}" ;;
    realtime) echo "supatype/realtime:${TRAIN_TAG}" ;;
    functions-worker) echo "supatype/functions-worker:${TRAIN_TAG}" ;;
    control-plane) echo "supatype/control-plane:${TRAIN_TAG}" ;;
    cloud) echo "ghcr.io/supatype/cloud:${TRAIN_TAG}" ;;
    *) echo "unknown component: $1" >&2; return 1 ;;
  esac
}

# TRAIN_SKIP_CLOUD=1 leaves the cloud repository and the cloud image out. CI sets it when it has no
# PRIVATE_REPO_TOKEN to read the private cloud repository with; no self-host suite runs the cloud
# image (suites.sh), so nothing downstream needs it. Unset, as in the local train, cloud is built.
train_skips_cloud() { [[ "${TRAIN_SKIP_CLOUD:-0}" == 1 ]]; }

TRAIN_COMPONENTS=(engine server postgres studio storage realtime functions-worker control-plane)
train_skips_cloud || TRAIN_COMPONENTS+=(cloud)

# Prints the words given, less the cloud repository and the cloud image when cloud is skipped.
train_drop_skipped() {
  local w out=()
  for w in "$@"; do
    if train_skips_cloud && [[ "$w" == cloud || "$w" == supatype-cloud ]]; then continue; fi
    out+=("$w")
  done
  echo "${out[*]}"
}

# Exports the image variables every suite reads, so a stack started by any suite runs the train's
# images and nothing pulled from a registry.
export_train_images() {
  export SUPATYPE_ENGINE_IMAGE SUPATYPE_SERVER_IMAGE SUPATYPE_POSTGRES_IMAGE SUPATYPE_STUDIO_IMAGE
  export SUPATYPE_STORAGE_IMAGE SUPATYPE_REALTIME_IMAGE SUPATYPE_FUNCTIONS_WORKER_IMAGE
  export SUPATYPE_CONTROL_PLANE_IMAGE
  SUPATYPE_ENGINE_IMAGE="$(train_image engine)"
  SUPATYPE_SERVER_IMAGE="$(train_image server)"
  SUPATYPE_POSTGRES_IMAGE="$(train_image postgres)"
  SUPATYPE_STUDIO_IMAGE="$(train_image studio)"
  SUPATYPE_STORAGE_IMAGE="$(train_image storage)"
  SUPATYPE_REALTIME_IMAGE="$(train_image realtime)"
  SUPATYPE_FUNCTIONS_WORKER_IMAGE="$(train_image functions-worker)"
  SUPATYPE_CONTROL_PLANE_IMAGE="$(train_image control-plane)"
}

train_log() { printf '[train %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
train_die() { printf '[train] ERROR: %s\n' "$*" >&2; exit 1; }

# Run a noisy step with its output kept out of the train log. When it fails, print the end of
# that output before stopping, so the log says why and not only that it stopped.
train_quiet() {
  local name="$1" log
  shift
  log="$(mktemp)"
  if ! "$@" >"$log" 2>&1; then
    tail -n 40 "$log" >&2
    rm -f "$log"
    train_die "$name failed (its last 40 lines are above)"
  fi
  rm -f "$log"
}

# Git Bash on Windows rewrites any argument that starts with / into a Windows path, which breaks
# container-side paths. docker_nc turns that off for one docker call; host_path gives that call a
# host path docker.exe understands. Both are no-ops on Linux and macOS.
docker_nc() { MSYS_NO_PATHCONV=1 docker "$@"; }
host_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }
