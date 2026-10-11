#!/usr/bin/env bash
# Make a machine ready to run the train's suites: the candidate CLI built, the train's own suites
# overlaid, and the CLI's engine resolution pointed at the train's engine.
#
# Runs on the CI runner and inside the local runner container alike. The images must already be
# loaded (`docker image inspect supatype/schema-engine:train` succeeds).
#
# How the CLI is made to use the train's engine, and why it takes two steps:
#   - Host side (doctor, adopt, generate, --connection pushes) the CLI runs the engine binary
#     cached under ~/.supatype/cache/engine/<version>/, where <version> is the CDN's latest. The
#     train's binary is put there under that version, so nothing is downloaded. run-suite.sh then
#     checks the cache holds nothing else.
#   - Docker pushes run `supatype/schema-engine:v<version>`, also from the CDN's latest, and ignore
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
(cd "$TRAIN_SUPATYPE_DIR" && pnpm install --frozen-lockfile && pnpm build) >/dev/null
bash "$SCRIPT_DIR/overlay.sh" "$HARNESS" "$TRAIN_SUPATYPE_DIR"

latest="$(curl -fsS https://releases.supatype.com/engine/latest.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')"
[[ -n "$latest" ]] || train_die "could not read the CDN's latest engine version"
arch="$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')"
cache="$HOME/.supatype/cache/engine/$latest"
mkdir -p "$cache"
install -m 0755 "$TRAIN_ENGINE_BIN" "$cache/supatype-engine-linux-$arch"
docker tag "$(train_image engine)" "supatype/schema-engine:v$latest"
train_log "engine resolution: cache $latest and supatype/schema-engine:v$latest are the train's engine"

if [[ "${TRAIN_INSTALL_BROWSER:-1}" == 1 ]]; then
  (cd "$TRAIN_SUPATYPE_DIR" && pnpm --filter supatype-e2e exec playwright install --with-deps chromium) >/dev/null
fi
train_log "ready"
