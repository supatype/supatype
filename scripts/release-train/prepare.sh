#!/usr/bin/env bash
# Make a machine ready to run the train's suites: the candidate CLI built, the train's own suites
# overlaid, and the CLI's engine resolution pointed at the train's engine.
#
# Runs on the CI runner and inside the local runner container alike. The images must already be
# loaded (`docker image inspect supatype/schema-engine:train` succeeds).
#
# How the CLI is made to use the train's engine, and why it takes two steps:
#   - Host side (doctor, adopt, generate, --connection pushes) the CLI runs the engine binary
#     cached under ~/.supatype/cache/engine/<version>/, where <version> is the candidate's pinned
#     engine release (release/images.json), or the CDN's latest for a candidate from before the
#     pins. The train's binary is put there under that version, so nothing is downloaded.
#     run-suite.sh then checks the cache holds nothing else.
#   - Docker pushes run `supatype/schema-engine:v<version>`, the same version, and ignore
#     SUPATYPE_ENGINE_IMAGE (fixed by supatype #115, which the candidate does not carry yet). So the
#     train's engine image is tagged with that name as well, on this machine's daemon only. The
#     provenance check matches by image ID, so a pull that replaced the tag would fail the suite.
#   TODO(#115): drop the second tag once the candidate's push honours SUPATYPE_ENGINE_IMAGE.
#
# Environment: TRAIN_SUPATYPE_DIR, TRAIN_ENGINE_BIN, TRAIN_HARNESS_DIR.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
: "${TRAIN_SUPATYPE_DIR:?}" "${TRAIN_ENGINE_BIN:?}"
HARNESS="${TRAIN_HARNESS_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

source "$SCRIPT_DIR/provenance.sh"
for c in "${TRAIN_COMPONENTS[@]}"; do
  docker image inspect "$(train_image "$c")" >/dev/null 2>&1 || train_die "image $(train_image "$c") is not loaded"
done
record_train_image_ids

train_log "build the candidate CLI and workspace"
# Large downloads drop on a weak connection, so retry them patiently. TRAIN_NETWORK_CONCURRENCY
# lowers how many download at once when the connection keeps resetting.
pnpm_net=(--fetch-retries 8 --fetch-timeout 300000 --network-concurrency "${TRAIN_NETWORK_CONCURRENCY:-16}")
train_quiet "pnpm install" pnpm --dir "$TRAIN_SUPATYPE_DIR" install --frozen-lockfile "${pnpm_net[@]}"
train_quiet "pnpm build" pnpm --dir "$TRAIN_SUPATYPE_DIR" build
bash "$SCRIPT_DIR/overlay.sh" "$HARNESS" "$TRAIN_SUPATYPE_DIR"

# The engine version the candidate CLI resolves when nothing names one: its pin, or for a candidate
# from before release/images.json existed, the CDN's latest.
candidate_engine_version() {
  local tag
  if [[ -f "$TRAIN_SUPATYPE_DIR/release/images.json" ]]; then
    tag="$(node "$TRAIN_SUPATYPE_DIR/scripts/release-images.mjs" get engine tag)"
    printf '%s\n' "${tag#v}"
    return
  fi
  curl -fsS --retry 6 --retry-all-errors --retry-delay 10 https://releases.supatype.com/engine/latest.json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'
}

version="$(candidate_engine_version)"
[[ -n "$version" ]] || train_die "could not read the engine version the candidate CLI resolves"
arch="$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')"
cache="$HOME/.supatype/cache/engine/$version"
mkdir -p "$cache"
install -m 0755 "$TRAIN_ENGINE_BIN" "$cache/supatype-engine-linux-$arch"
docker tag "$(train_image engine)" "supatype/schema-engine:v$version"
train_log "engine resolution: cache $version and supatype/schema-engine:v$version are the train's engine"

if [[ "${TRAIN_INSTALL_BROWSER:-1}" == 1 ]]; then
  train_quiet "browser install" pnpm --dir "$TRAIN_SUPATYPE_DIR" --filter supatype-e2e exec playwright install --with-deps chromium
fi
train_log "ready"
