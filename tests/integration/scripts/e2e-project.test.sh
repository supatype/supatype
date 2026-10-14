#!/usr/bin/env bash
# The project-naming helper every live-stack script uses (lib/e2e-project.sh), without a stack.
#
# Two runs of one suite, from two checkouts, shared one compose project: the second `supatype dev`
# took over the first run's containers and the first run's `down -v` removed the second's. This
# checks the pieces that keep them apart: the name an override gives the CLI (SUPATYPE_PROJECT_NAME,
# with no file written), the developer's own local config untouched, one run per directory, and a
# project another directory runs
# refused rather than taken over. Needs `pnpm build` (it asks the built CLI for the merged config)
# and Docker (it starts one idle container with compose labels).
#
# Usage:
#   bash tests/integration/scripts/e2e-project.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CONFIG_JS="$ROOT_DIR/packages/cli/dist/config.js"
WORK="$(mktemp -d)"
FOREIGN="e2e-project-test-$$"
failures=0

cleanup() {
  docker rm -f "$FOREIGN" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "  ok   $1"; }
fail() { echo "  FAIL $1" >&2; failures=$((failures + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

# A project directory with the config shape the examples use.
new_project() {
  local dir="$WORK/$1"
  mkdir -p "$dir"
  cat >"$dir/supatype.config.ts" <<TS
export default {
  project: { name: "$2" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 54399 },
  app: { mode: "none" },
  schema: { path: "schema/index.ts" },
}
TS
  printf '%s' "$dir"
}

# The project name and overrides.engine the CLI loads for <dir>, merged as `supatype dev` merges.
cli_config() {
  (cd "$1" && node --input-type=module -e "
    const { loadConfig } = await import(process.argv[1])
    const c = loadConfig(process.cwd())
    console.log([c.project.name, c.overrides?.engine ?? '-'].join(' '))
  " "file:///$(cd "$(dirname "$CONFIG_JS")" && pwd -W 2>/dev/null || pwd)/config.js")
}

# Each case runs in a subshell, so the helper's state starts clean.
echo "==> no override: the config's name, nothing written"
(
  failures=0
  dir="$(new_project plain example-a)"
  unset SUPATYPE_E2E_PROJECT
  source "$SCRIPT_DIR/lib/e2e-project.sh"
  e2e_project_use "$dir" example-a
  check "compose project is supatype-example-a" '[[ "$E2E_COMPOSE_PROJECT" == supatype-example-a ]]'
  check "no local config written" '[[ ! -e "$dir/supatype.local.config.ts" ]]'
  check "the CLI loads example-a" '[[ "$(cli_config "$dir")" == "example-a -" ]]'
  e2e_project_release
  check "the lock is released" '[[ ! -e "$dir/.supatype/.e2e-run.lock.d" ]]'
  exit "$failures"
) || failures=$((failures + $?))

echo "==> override: the CLI runs the project under the run's name"
(
  failures=0
  dir="$(new_project renamed example-b)"
  export SUPATYPE_E2E_PROJECT="run-b2"
  source "$SCRIPT_DIR/lib/e2e-project.sh"
  e2e_project_use "$dir" example-b
  check "compose project is supatype-run-b2" '[[ "$E2E_COMPOSE_PROJECT" == supatype-run-b2 ]]'
  check "the CLI loads run-b2" '[[ "$(cli_config "$dir")" == "run-b2 -" ]]'
  check "container names carry the run" '[[ "$(e2e_scoped mailpit)" == mailpit-run-b2 ]]'
  check "and no local config is written for it" '[[ ! -e "$dir/supatype.local.config.ts" ]]'
  e2e_project_release
  check "the run's name is gone again" '[[ -z "${SUPATYPE_PROJECT_NAME:-}" ]]'
  check "the CLI loads example-b again" '[[ "$(cli_config "$dir")" == "example-b -" ]]'
  exit "$failures"
) || failures=$((failures + $?))

echo "==> override beside a developer's local config: merged by the CLI, the file never touched"
(
  failures=0
  dir="$(new_project mine example-c)"
  printf 'export default { overrides: { engine: "D:/engines/mine.exe" } }\n' >"$dir/supatype.local.config.ts"
  cp "$dir/supatype.local.config.ts" "$WORK/mine.orig"
  export SUPATYPE_E2E_PROJECT="run-c"
  source "$SCRIPT_DIR/lib/e2e-project.sh"
  e2e_project_use "$dir" example-c
  check "the CLI loads run-c and keeps the engine override" \
    '[[ "$(cli_config "$dir")" == "run-c D:/engines/mine.exe" ]]'
  e2e_project_release
  check "the developer's file is unchanged" 'cmp -s "$dir/supatype.local.config.ts" "$WORK/mine.orig"'
  check "nothing written beside it" '[[ ! -e "$dir/supatype.local.config.e2e-previous.ts" ]]'
  exit "$failures"
) || failures=$((failures + $?))

echo "==> a second run in the same directory is refused, and touches nothing"
(
  failures=0
  dir="$(new_project locked example-d)"
  unset SUPATYPE_E2E_PROJECT
  source "$SCRIPT_DIR/lib/e2e-project.sh"
  e2e_project_use "$dir" example-d
  second="$(bash -c "source '$SCRIPT_DIR/lib/e2e-project.sh'; SUPATYPE_E2E_PROJECT=other e2e_project_use '$dir' example-d" 2>&1)" \
    && fail "the second run was let in" || pass "the second run is refused"
  check "it says why" '[[ "$second" == *"another live-stack run is using"* ]]'
  check "it wrote no override" '[[ ! -e "$dir/supatype.local.config.ts" ]]'
  check "the first run still holds the lock" '[[ -d "$dir/.supatype/.e2e-run.lock.d" ]]'
  e2e_project_release
  exit "$failures"
) || failures=$((failures + $?))

echo "==> a project another directory is running is refused, not taken over"
(
  failures=0
  dir="$(new_project foreign example-e)"
  unset SUPATYPE_E2E_PROJECT
  docker run -d --name "$FOREIGN" \
    --label com.docker.compose.project=supatype-example-e \
    --label "com.docker.compose.project.config_files=/somewhere/else/.supatype/self-host/docker-compose.yml" \
    alpine:3 sleep 300 >/dev/null
  source "$SCRIPT_DIR/lib/e2e-project.sh"
  out="$(e2e_project_use "$dir" example-e 2>&1)" && fail "the run was let in" || pass "the run is refused"
  check "it names the other directory" '[[ "$out" == *"/somewhere/else/"* ]]'
  check "it releases the lock it took" '[[ ! -e "$dir/.supatype/.e2e-run.lock.d" ]]'
  check "the other run's container is untouched" \
    '[[ "$(docker inspect -f "{{.State.Running}}" "$FOREIGN")" == true ]]'
  SUPATYPE_E2E_PROJECT="run-e" e2e_project_use "$dir" example-e
  check "under a name of its own it goes ahead" '[[ "$E2E_COMPOSE_PROJECT" == supatype-run-e ]]'
  e2e_project_release
  exit "$failures"
) || failures=$((failures + $?))

echo "==> a name compose would rewrite is refused"
(
  failures=0
  dir="$(new_project badname example-f)"
  source "$SCRIPT_DIR/lib/e2e-project.sh"
  SUPATYPE_E2E_PROJECT="Run F" e2e_project_use "$dir" example-f 2>/dev/null \
    && fail "'Run F' was accepted" || pass "'Run F' is refused"
  check "and takes no lock" '[[ ! -e "$dir/.supatype/.e2e-run.lock.d" ]]'
  exit "$failures"
) || failures=$((failures + $?))

echo ""
if (( failures > 0 )); then
  echo "FAIL: $failures check(s) failed"
  exit 1
fi
echo "PASS: lib/e2e-project.sh"
