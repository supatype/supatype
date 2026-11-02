#!/usr/bin/env bash
# Hand the images this repository ships from the `images` job of integration.yml to the live-stack
# jobs that run them.
#
# A CLI built from source is not a release, so when nothing names an image its stack runs Studio,
# storage, realtime, functions-worker and the control plane at :latest (packages/cli/src/
# release-images.ts): the last published release, not the commit under test. A job that ran that
# stack passed or failed for code the commit might not contain. A release of this commit ships the
# five built from it, next to the engine, server and Postgres release/images.json pins, so that is
# what the jobs run. The `images` job builds them once, as supatype/<name>:ci; each job loads them
# here and names them in SUPATYPE_*_IMAGE, which the stack reads ahead of its defaults.
#
# The control plane copies the pinned engine, which needs PRIVATE_REPO_TOKEN while the engine
# repository is private. Fork and Dependabot runs have no secrets, so there the images job builds
# the other four and reports the control plane unavailable; their stacks run the released control
# plane, and say so. Where it was built, a job that cannot load it fails.
#
# Usage:
#   bash scripts/ci-images.sh save <dir>                  write <dir>/ci-images.tar.zst from the
#                                                         four service images
#   bash scripts/ci-images.sh save-control-plane <dir>    write <dir>/ci-control-plane.tar.zst
#   bash scripts/ci-images.sh load <dir> <built|unavailable>
#                                                         load them and print SUPATYPE_*_IMAGE
#                                                         lines for $GITHUB_ENV; the second
#                                                         argument is the images job's
#                                                         control-plane output
#
# `load` prints nothing until every image it needs is loaded and present under its tag, so a job
# whose load fails stops there, rather than going on with its stack back on :latest.
#
# Environment:
#   CI_IMAGE_TAG   the tag the images carry (default ci)
set -euo pipefail

TAG="${CI_IMAGE_TAG:-ci}"
SERVICES=(studio storage realtime functions-worker)
ARCHIVE=ci-images.tar.zst
CONTROL_PLANE_ARCHIVE=ci-control-plane.tar.zst

die() { printf 'ci-images: %s\n' "$*" >&2; exit 1; }

ref() { printf 'supatype/%s:%s\n' "$1" "$TAG"; }

# SUPATYPE_<NAME>_IMAGE, the variable the stack reads for one image.
variable() { printf 'SUPATYPE_%s_IMAGE\n' "$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; }

require_images() {
  local name
  for name in "$@"; do
    docker image inspect "$(ref "$name")" >/dev/null 2>&1 || die "$(ref "$name") is not a local image"
  done
}

# Saves the named images, which must be local, to <dir>/<archive>.
save_images() {
  local dir="$1" archive="$2" refs=() name
  shift 2
  require_images "$@"
  for name in "$@"; do refs+=("$(ref "$name")"); done
  mkdir -p "$dir"
  docker save "${refs[@]}" | zstd -T0 -3 -q -f -o "$dir/$archive"
  printf 'ci-images: saved %s to %s/%s\n' "${refs[*]}" "$dir" "$archive" >&2
}

# Loads <dir>/<archive>, then checks the named images are there.
load_images() {
  local dir="$1" archive="$2"
  shift 2
  [[ -f "$dir/$archive" ]] || die "$dir/$archive is missing: the images job did not hand this job its images"
  zstd -dc "$dir/$archive" | docker load >&2
  require_images "$@"
}

cmd_load() {
  local dir="${1:?usage: ci-images.sh load <dir> <built|unavailable>}" control_plane="${2:-}" names name lines=""
  names=("${SERVICES[@]}")
  load_images "$dir" "$ARCHIVE" "${SERVICES[@]}"
  case "$control_plane" in
    built)
      load_images "$dir" "$CONTROL_PLANE_ARCHIVE" control-plane
      names+=(control-plane)
      ;;
    unavailable)
      printf 'ci-images: no control plane from this checkout; the stack runs the released one\n' >&2
      ;;
    *) die "the images job's control-plane output is '$control_plane', not built or unavailable" ;;
  esac
  for name in "${names[@]}"; do lines+="$(variable "$name")=$(ref "$name")"$'\n'; done
  printf '%s' "$lines"
}

case "${1:-}" in
  save) shift; save_images "${1:?usage: ci-images.sh save <dir>}" "$ARCHIVE" "${SERVICES[@]}" ;;
  save-control-plane) shift; save_images "${1:?usage: ci-images.sh save-control-plane <dir>}" "$CONTROL_PLANE_ARCHIVE" control-plane ;;
  load) shift; cmd_load "$@" ;;
  *) sed -n '2,31p' "$0" >&2; exit 2 ;;
esac
