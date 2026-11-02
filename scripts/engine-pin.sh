#!/usr/bin/env bash
# The engine pin moved into release/images.json beside the server and Postgres pins, and
# scripts/pin.sh now resolves all three. This keeps the old commands working for anything that
# still calls them:
#   bash scripts/engine-pin.sh set <engine tag>          same as: pin.sh set engine <tag>
#   bash scripts/engine-pin.sh image [--release-only]    same as: pin.sh engine-image [--release-only]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${1:-}" in
  image) shift; exec bash "$HERE/pin.sh" engine-image "$@" ;;
  set) shift; exec bash "$HERE/pin.sh" set engine "$@" ;;
  *) sed -n '2,6p' "$0" >&2; exit 2 ;;
esac
