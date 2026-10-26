#!/usr/bin/env bash
# Run one release-train suite against the train's artifacts, and judge it.
#
# A suite passes only when all of these hold:
#   - its command exits 0;
#   - its output says nothing was skipped (C17: a skipped suite is a failed suite);
#   - every Supatype container it started ran a train image (provenance.sh);
#   - every push it made was recorded by the train engine (`_supatype.migrations.engine_version`
#     equals the train engine's `--version`, provenance.sh);
#   - the host engine cache holds the train engine and nothing else.
#
# Usage: bash scripts/release-train/run-suite.sh <suite> <results-dir>
#
# Environment (set by the workflow or by release-train.sh):
#   TRAIN_SUPATYPE_DIR  candidate supatype checkout, built, with overlay.sh applied
#   TRAIN_ENGINE_DIR    candidate supatype-schema-engine checkout
#   TRAIN_ENGINE_BIN    the engine binary extracted from the train's engine image
#   TRAIN_HARNESS_DIR   the checkout holding these scripts
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
source "$SCRIPT_DIR/suites.sh"
source "$SCRIPT_DIR/provenance.sh"

SUITE="${1:?suite name}"
RESULTS="${2:?results directory}"
DIR="$RESULTS/$SUITE"
mkdir -p "$DIR"
: "${TRAIN_SUPATYPE_DIR:?}" "${TRAIN_ENGINE_BIN:?}"
export TRAIN_HARNESS_DIR="${TRAIN_HARNESS_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

# Lines that mean a suite, or part of one, did not run. Kept narrow on purpose: "Skipping ... image
# build (already exists)" in integration-test.sh is a build being reused, not a test being skipped.
SKIP_PATTERN='SKIPPED, NOT PASSED|^SKIP:|^[[:space:]]*skip[[:space:]]|[0-9]+ skipped|[0-9]+ did not run|::warning title=[^:]*skipped'

export_train_images
export SUPATYPE_STRICT=1 MASKING_CLI="$TRAIN_SUPATYPE_DIR/packages/cli/bin/supatype.js"
# A compose project of the suite's own (tests/integration/scripts/lib/e2e-project.sh). The runner's
# daemon is the train's alone, so nothing else collides there; a name per suite means a stack one
# suite leaves behind cannot become the next suite's, and the train runs the path that keeps two
# local runs apart.
export SUPATYPE_E2E_PROJECT="train-$SUITE"

reasons=()
command="$(suite_command "$SUITE")" || { echo "unknown suite: $SUITE" >&2; exit 2; }
started=$SECONDS
train_log "suite $SUITE: $command"
start_provenance "$DIR"
# Bounded: a suite whose test process never exits (integration-test.sh's realtime tests hung for
# 40 minutes after a failed DELETE assertion) would otherwise hold the whole train.
limit="${TRAIN_SUITE_TIMEOUT:-2700}"
(cd "$TRAIN_SUPATYPE_DIR" && timeout --kill-after=60 "$limit" bash -c "$command") >"$DIR/output.log" 2>&1
status=$?
[[ "$status" -ne 124 && "$status" -ne 137 ]] || reasons+=("did not finish within ${limit}s")
stop_provenance "$DIR"
elapsed=$((SECONDS - started))

[[ "$status" -eq 0 ]] || reasons+=("exited $status")
if skips="$(grep -E -m3 "$SKIP_PATTERN" "$DIR/output.log")"; then
  reasons+=("output reports a skip: $(tr '\n' ' ' <<<"$skips")")
fi
while IFS= read -r v; do [[ -n "$v" ]] && reasons+=("$v"); done < <(check_images "$DIR"; if suite_checks_ledgers "$SUITE"; then check_ledgers "$DIR"; fi; check_engine_cache)

# On a machine of the train's own (the CI runner, the local runner container: TRAIN_ISOLATED=1),
# clear what the suite left behind, so the next suite starts from nothing. Several suites stop
# `supatype dev` by killing the subshell that started it, which leaves the CLI running, and a
# failed teardown leaves containers holding the default ports. Never done on a shared machine.
if [[ "${TRAIN_ISOLATED:-0}" == 1 ]]; then
  pkill -f 'packages/cli/bin/supatype.js' 2>/dev/null || true
  leftover="$(docker ps -aq)"
  if [[ -n "$leftover" ]]; then
    train_log "suite $SUITE left $(wc -w <<<"$leftover") container(s); removing them"
    docker rm -f -v $leftover >/dev/null 2>&1 || true
  fi
  docker volume ls -q | xargs -r docker volume rm >/dev/null 2>&1 || true
  docker network ls -q --filter type=custom | xargs -r docker network rm >/dev/null 2>&1 || true
fi

verdict=pass
[[ ${#reasons[@]} -eq 0 ]] || verdict=fail
node -e '
  const [suite, verdict, seconds, ...reasons] = process.argv.slice(1)
  console.log(JSON.stringify({ suite, verdict, seconds: Number(seconds), reasons }))
' "$SUITE" "$verdict" "$elapsed" "${reasons[@]}" >"$DIR/result.json"
train_log "suite $SUITE: $verdict in ${elapsed}s${reasons:+ (${reasons[*]})}"
tail -25 "$DIR/output.log" | sed 's/^/    /'
[[ "$verdict" == pass ]]
