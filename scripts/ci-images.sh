#!/usr/bin/env bash
# Hand the images this repository ships from the `images` job of integration.yml to the live-stack
# jobs that run them.
#
# A CLI built from source is not a release, so when nothing names an image its stack runs Studio,
# storage, realtime, functions-worker and the control plane at :latest (packages/cli/src/
# release-images.ts): the last published release, not the commit under test. A job that ran that
# stack passed or failed for code the commit might not contain. A release of this commit ships the
# five built from it, next to the engine, server and Postgres release/images.json pins, so that is
# what the jobs run. The `images` job builds the five once, as supatype/<name>:ci; each job loads
# them here and names them in SUPATYPE_*_IMAGE, which the stack reads ahead of its defaults.
#
# Usage:
#   bash scripts/ci-images.sh save <dir>   write <dir>/ci-images.tar.zst from the five local images
#   bash scripts/ci-images.sh load <dir>   load <dir>/ci-images.tar.zst and print SUPATYPE_*_IMAGE
#                                          lines for $GITHUB_ENV
#
# `load` prints nothing until every image is loaded and present under its tag, so a job whose load
# fails stops there, rather than going on with its stack back on :latest.
#
# Environment:
#   CI_IMAGE_TAG   the tag the five carry (default ci)
set -euo pipefail

TAG="${CI_IMAGE_TAG:-ci}"
NAMES=(studio storage realtime functions-worker control-plane)
ARCHIVE=ci-images.tar.zst

die() { printf 'ci-images: %s\n' "$*" >&2; exit 1; }

ref() { printf 'supatype/%s:%s\n' "$1" "$TAG"; }

# SUPATYPE_<NAME>_IMAGE, the variable the stack reads for one image.
variable() { printf 'SUPATYPE_%s_IMAGE\n' "$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')"; }

require_images() {
  local name
  for name in "${NAMES[@]}"; do
    docker image inspect "$(ref "$name")" >/dev/null 2>&1 || die "$(ref "$name") is not a local image"
  done
}

cmd_save() {
  local dir="${1:?usage: ci-images.sh save <dir>}" refs=() name
  require_images
  for name in "${NAMES[@]}"; do refs+=("$(ref "$name")"); done
  mkdir -p "$dir"
  docker save "${refs[@]}" | zstd -T0 -3 -q -f -o "$dir/$ARCHIVE"
  printf 'ci-images: saved %s to %s/%s\n' "${refs[*]}" "$dir" "$ARCHIVE" >&2
}

cmd_load() {
  local dir="${1:?usage: ci-images.sh load <dir>}" name lines=""
  [[ -f "$dir/$ARCHIVE" ]] || die "$dir/$ARCHIVE is missing: the images job did not hand this job its images"
  zstd -dc "$dir/$ARCHIVE" | docker load >&2
  require_images
  for name in "${NAMES[@]}"; do lines+="$(variable "$name")=$(ref "$name")"$'\n'; done
  printf '%s' "$lines"
}

case "${1:-}" in
  save) shift; cmd_save "$@" ;;
  load) shift; cmd_load "$@" ;;
  *) sed -n '2,22p' "$0" >&2; exit 2 ;;
esac
