#!/usr/bin/env bash
# Two web exports of the expo-auth example with different EXPO_PUBLIC_SUPATYPE_URL values must each
# carry their own URL.
#
# EXPO_PUBLIC_* values are inlined at build time. Metro's cache lives in the OS temp directory by
# default, shared by every run on the machine, and a cached transform kept the URL of whichever run
# built it first: the second export served the first run's gateway port, so the web app called a
# port nothing listened on. No stack is needed; this only builds.
#
# Usage:
#   bash tests/integration/scripts/expo-export-cache.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
APP_DIR="$ROOT_DIR/examples/expo-auth"

source "$SCRIPT_DIR/lib/expo-export.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# export_with_url <port> - builds into $WORK/<port> with the URL naming that port.
export_with_url() {
  EXPO_PUBLIC_SUPATYPE_URL="http://127.0.0.1:$1" EXPO_PUBLIC_SUPATYPE_ANON_KEY="cache-test-key" \
    expo_web_export "$APP_DIR" "$WORK/$1"
}

# bundle_names <port> - true when the build's bundle carries the URL for that port.
bundle_names() {
  grep -rqF "http://127.0.0.1:$1" "$WORK/$1/_expo/static/js"
}

status=0
for port in 51001 51002; do
  export_with_url "$port"
  if bundle_names "$port"; then
    echo "  ok   the export built for :$port names :$port"
  else
    found="$(grep -rhoE 'http://127\.0\.0\.1:[0-9]+' "$WORK/$port/_expo/static/js" | sort -u | tr '\n' ' ')"
    echo "  FAIL the export built for :$port names ${found:-no URL}" >&2
    status=1
  fi
done
exit "$status"
