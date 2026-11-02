#!/usr/bin/env bash
# The engine, server or Postgres image a release of this checkout ships (release/images.json, read
# through scripts/pin.sh), for the e2e scripts to run when no SUPATYPE_*_IMAGE names one. Never
# `:latest`: that moves under an unchanged checkout, and a machine with an old copy runs the old one
# without pulling.
#
# Usage: source this file, then `pinned_image <engine|server|postgres>`.

PINNED_IMAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

pinned_image() {
  bash "$PINNED_IMAGE_ROOT/scripts/pin.sh" image "$1"
}
