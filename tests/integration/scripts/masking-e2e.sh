#!/usr/bin/env bash
# The masking matrix, both tiers, against a real stack.
#
# Field masking and row visibility are tested on every channel a client reads or writes through
# (REST with its filter, order and count oracles, REST writes, realtime and GraphQL), for anon, two
# users, an admin and service_role. Known open defects are marked expected-fail per test, so the
# run is green today and an unexpected pass turns it red. See tests/e2e/masking/lib/defects.ts.
#
# Tier 1 is the stack as it ships on supatype/postgres (the supatype_mask extension), on a fresh
# database, because T1-N1 only shows on the first push of a fresh stack. Tier 2 is a second fresh
# stack with the extension dropped and the schema pushed again, as verify-scripts/t2 built it.
#
# Usage:
#   bash tests/integration/scripts/masking-e2e.sh            # both tiers
#   MASKING_TIERS=1 bash tests/integration/scripts/masking-e2e.sh
#
# Environment:
#   SUPATYPE_KONG_PORT   gateway port for the stack (default 18476)
#   MASKING_DB_PORT      host port the stack publishes Postgres on (default 54476)
#   MASKING_BYO_PORT     host port for the plain Postgres the T2-N11 case starts (default 55449)
#   MASKING_PROJECT_NAME compose project is supatype-<name> (default masking)
#   MASKING_CLI          the CLI to test (default this checkout's packages/cli/bin/supatype.js)
#   MASKING_ENGINE_BIN   optional local engine binary, written into overrides.engine
#   SUPATYPE_*_IMAGE     images for the stack, as for every other suite
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
E2E_DIR="$ROOT_DIR/tests/e2e"
PROJECT_DIR="$E2E_DIR/masking/project"
export MASKING_CLI="${MASKING_CLI:-$ROOT_DIR/packages/cli/bin/supatype.js}"
export MASKING_PROJECT_NAME="${MASKING_PROJECT_NAME:-masking}"
export SUPATYPE_KONG_PORT="${SUPATYPE_KONG_PORT:-18476}"
export MASKING_BYO_PORT="${MASKING_BYO_PORT:-55449}"
DB_PORT="${MASKING_DB_PORT:-54476}"
COMPOSE_PROJECT="supatype-${MASKING_PROJECT_NAME}"
BASE_URL="http://127.0.0.1:${SUPATYPE_KONG_PORT}"
TIERS="${MASKING_TIERS:-1 2}"

source "$SCRIPT_DIR/lib/http-wait.sh"

DEV_PID=""
stop_stack() {
  if [[ -n "$DEV_PID" ]]; then kill "$DEV_PID" 2>/dev/null || true; wait "$DEV_PID" 2>/dev/null || true; fi
  DEV_PID=""
  docker compose -p "$COMPOSE_PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap stop_stack EXIT INT TERM

[[ -f "$MASKING_CLI" ]] || { echo "ERROR: CLI not found at $MASKING_CLI, run 'pnpm build' first" >&2; exit 1; }

env_value() { grep -E "^$1=" "$PROJECT_DIR/.env" | head -1 | cut -d= -f2-; }
psql_db() {
  docker exec -e PGPASSWORD="$(env_value POSTGRES_PASSWORD)" "${COMPOSE_PROJECT}-db-1" \
    psql -h 127.0.0.1 -U supatype_admin -d "$(env_value POSTGRES_DB)" -X -A -t -q -v ON_ERROR_STOP=1 -c "$1"
}

# A fresh project directory state: no .env, no generated files, so each tier starts from nothing.
reset_project() {
  rm -rf "$PROJECT_DIR/.env" "$PROJECT_DIR/.supatype" "$PROJECT_DIR/supatype" "$PROJECT_DIR/types"
  printf 'SUPATYPE_KONG_PORT=%s\nSUPATYPE_DEV_DB_PORT=%s\n' "$SUPATYPE_KONG_PORT" "$DB_PORT" >"$PROJECT_DIR/.env"
  if [[ -n "${MASKING_ENGINE_BIN:-}" ]]; then
    cp "$PROJECT_DIR/supatype.config.ts" "$PROJECT_DIR/.supatype.config.ts.orig"
    MASKING_ENGINE_BIN="$MASKING_ENGINE_BIN" node -e '
      const fs = require("fs"); const path = process.argv[1]
      const bin = process.env.MASKING_ENGINE_BIN.replace(/\\/g, "/")
      const before = fs.readFileSync(path, "utf8")
      const after = before.replace("defineConfig({", `defineConfig({\n  overrides: { engine: ${JSON.stringify(bin)} },`)
      if (after === before) { console.error("could not set overrides.engine"); process.exit(1) }
      fs.writeFileSync(path, after)' "$PROJECT_DIR/supatype.config.ts"
  fi
}
restore_config() {
  if [[ -f "$PROJECT_DIR/.supatype.config.ts.orig" ]]; then
    mv "$PROJECT_DIR/.supatype.config.ts.orig" "$PROJECT_DIR/supatype.config.ts"
  fi
}

start_stack() {
  local tier="$1" log="$2"
  stop_stack
  reset_project
  (cd "$PROJECT_DIR" && MASKING_TIER="$tier" exec node "$MASKING_CLI" dev --no-watch --stream >"$log" 2>&1) &
  DEV_PID=$!
  dev_ready() { grep -q "Press Ctrl+C" "$log" && http_ok "$BASE_URL/auth/v1/health"; }
  if ! wait_until 600 "tier $tier stack" dev_ready; then
    tail -40 "$log"
    return 1
  fi
}

# Tier 2 as verify-scripts/t2/setup.sh built it: drop the extension, then push so the engine
# generates the api views. The stale-label cleanup T2 did by hand is not done here (T2-N7).
make_tier2() {
  psql_db "DROP EXTENSION IF EXISTS supatype_mask CASCADE"
  local url
  url="$(env_value DATABASE_URL | sed 's/@localhost:/@127.0.0.1:/')"
  (cd "$PROJECT_DIR" && MASKING_TIER=2 node "$MASKING_CLI" push --yes --connection "$url")
}

# The tier the engine recorded, and the engine that recorded it: only a ledger-era engine creates
# _supatype.managed_objects_undo (the train's interim engine marker until F24 versions builds).
check_stack() {
  local tier="$1" want got
  want="$([[ "$tier" == 1 ]] && echo extension || echo views)"
  got="$(psql_db "select capabilities->'fieldMasking'->>'tier' from _supatype.schema_state")"
  [[ "$got" == "$want" ]] || { echo "ERROR: tier $tier stack reports field masking tier '$got', expected '$want'" >&2; return 1; }
  [[ "$(psql_db "select to_regclass('_supatype.managed_objects_undo') is not null")" == t ]] \
    || { echo "ERROR: _supatype.managed_objects_undo is missing: the push did not run a ledger-era engine" >&2; return 1; }
  echo "  tier $tier confirmed: field masking tier '$got', ledger-era engine"
}

# Playwright exits 0 with skipped tests; the train counts a skip as a failure, and so does this.
run_specs() {
  local tier="$1" report="$E2E_DIR/masking/masking-report-tier$1.json" status=0
  (cd "$E2E_DIR" && MASKING_TIER="$tier" MASKING_REPORT="$report" \
    pnpm exec playwright test -c masking/playwright.config.ts) || status=$?
  local skipped
  skipped="$(node -e 'const r = require(process.argv[1]); console.log(r.stats.skipped ?? 0)' "$report" 2>/dev/null || echo unknown)"
  if [[ "$skipped" != 0 ]]; then
    echo "ERROR: tier $tier skipped $skipped test(s); a skip is not a pass" >&2
    status=1
  fi
  return "$status"
}

failures=0
for tier in $TIERS; do
  echo ""
  echo "==> Tier $tier"
  log="$PROJECT_DIR/dev-tier$tier.log"
  if start_stack "$tier" "$log" && { [[ "$tier" == 1 ]] || make_tier2; } && check_stack "$tier"; then
    run_specs "$tier" || failures=$((failures + 1))
  else
    echo "ERROR: tier $tier stack did not come up as tier $tier" >&2
    failures=$((failures + 1))
  fi
  restore_config
  stop_stack
done

if [[ "$failures" -gt 0 ]]; then
  echo "FAILED: $failures tier(s) of the masking matrix"
  exit 1
fi
echo "PASS: the masking matrix holds, in tiers $TIERS, with every open defect still failing as recorded"
