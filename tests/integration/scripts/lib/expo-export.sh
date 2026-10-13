#!/usr/bin/env bash
#
# A web export of an Expo app with a Metro cache of its own. Source it:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/expo-export.sh"
#
# Metro keeps its transform cache in `<os temp dir>/metro-cache`, one directory for every build on
# the machine, and a cached transform does not change when an EXPO_PUBLIC_* value does. Two runs
# against two stacks therefore shared one cache, and the second export inlined the first run's
# EXPO_PUBLIC_SUPATYPE_URL: the web app called a gateway port that nothing listened on. Pointing
# the temp directory at a fresh one for the export gives each build an empty cache, and removing it
# afterwards leaves nothing for a later run to read.

# expo_web_export <app-dir> <out-dir> - `expo export --platform web` into <out-dir>, with a Metro
# cache that lives only for this export.
expo_web_export() {
  local app_dir="$1" out_dir="$2" cache_dir status=0
  cache_dir="$(mktemp -d)"
  local native_cache="$cache_dir"
  # Node reads TEMP and TMP on Windows and TMPDIR elsewhere; Windows needs the path in its own form.
  if command -v cygpath >/dev/null 2>&1; then native_cache="$(cygpath -m "$cache_dir")"; fi
  (cd "$app_dir" && CI=1 TMPDIR="$native_cache" TEMP="$native_cache" TMP="$native_cache" \
    npx expo export --platform web --output-dir "$out_dir" >/dev/null) || status=$?
  rm -rf "$cache_dir"
  return "$status"
}
