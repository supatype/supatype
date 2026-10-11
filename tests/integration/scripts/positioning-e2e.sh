#!/usr/bin/env bash
# The site's promises about `supatype dev`, in a project made by `supatype init`.
#
# Makes a project with `init`, gives it one model with three rows, starts `supatype dev` with the
# schema watcher on, then runs tests/e2e/positioning: a new field must reach the generated types
# (V-N2) and a rename must never empty the column (V-N1). Both were open defects, fixed by H6 and
# H7 (99ba568); a regression of either now fails the run.
#
# Usage:
#   bash tests/integration/scripts/positioning-e2e.sh
#
# Environment:
#   SUPATYPE_KONG_PORT        gateway port (default 18477)
#   POSITIONING_DB_PORT       host port for Postgres (default 54477)
#   POSITIONING_PROJECT_NAME  project and compose name suffix (default positioning)
#   MASKING_CLI               the CLI to test (default this checkout's)
#   MASKING_ENGINE_BIN        optional local engine binary, written into overrides.engine
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
E2E_DIR="$ROOT_DIR/tests/e2e"
NAME="${POSITIONING_PROJECT_NAME:-positioning}"
STATE_DIR="$E2E_DIR/positioning/.state"
# Inside tests/e2e, so the project resolves @supatype/* from the workspace without an install.
PROJECT_DIR="$STATE_DIR/$NAME"
export MASKING_CLI="${MASKING_CLI:-$ROOT_DIR/packages/cli/bin/supatype.js}"
export MASKING_PROJECT_DIR="$PROJECT_DIR"
export MASKING_PROJECT_NAME="$NAME"
export SUPATYPE_KONG_PORT="${SUPATYPE_KONG_PORT:-18477}"
export POSITIONING_DEV_LOG="$STATE_DIR/dev.log"
DB_PORT="${POSITIONING_DB_PORT:-54477}"
COMPOSE_PROJECT="supatype-${NAME}"
BASE_URL="http://127.0.0.1:${SUPATYPE_KONG_PORT}"

source "$SCRIPT_DIR/lib/http-wait.sh"

DEV_PID=""
cleanup() {
  if [[ -n "$DEV_PID" ]]; then kill "$DEV_PID" 2>/dev/null || true; wait "$DEV_PID" 2>/dev/null || true; fi
  docker compose -p "$COMPOSE_PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

[[ -f "$MASKING_CLI" ]] || { echo "ERROR: CLI not found at $MASKING_CLI, run 'pnpm build' first" >&2; exit 1; }
cli() { (cd "$PROJECT_DIR" && node "$MASKING_CLI" "$@"); }

echo "==> A project made by init"
docker compose -p "$COMPOSE_PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
rm -rf "$STATE_DIR"
mkdir -p "$STATE_DIR"
(cd "$STATE_DIR" && node "$MASKING_CLI" init "$NAME" --defaults --no-install --no-admin >/dev/null)
[[ -f "$PROJECT_DIR/supatype.config.ts" ]] || { echo "ERROR: init did not create $PROJECT_DIR" >&2; exit 1; }
cat >"$PROJECT_DIR/schema/index.ts" <<'TS'
import type { Model, Optional, Public, Role, UUID } from "@supatype/types"

/** One model the positioning checks change under `supatype dev`. */
export type Member = Model<{
  id: UUID
  name: string
}, {
  access: {
    read: Public
    create: Role<"service_role">
    update: Role<"service_role">
    delete: Role<"service_role">
  }
}>

/** Keeps the Optional import used before the checks add a field with it. */
export type MaybeText = Optional<string>
TS
sed -i "s/^SUPATYPE_KONG_PORT=.*/SUPATYPE_KONG_PORT=${SUPATYPE_KONG_PORT}/" "$PROJECT_DIR/.env"
grep -q '^SUPATYPE_KONG_PORT=' "$PROJECT_DIR/.env" || echo "SUPATYPE_KONG_PORT=${SUPATYPE_KONG_PORT}" >>"$PROJECT_DIR/.env"
grep -q '^SUPATYPE_DEV_DB_PORT=' "$PROJECT_DIR/.env" || echo "SUPATYPE_DEV_DB_PORT=${DB_PORT}" >>"$PROJECT_DIR/.env"
if [[ -n "${MASKING_ENGINE_BIN:-}" ]]; then
  MASKING_ENGINE_BIN="$MASKING_ENGINE_BIN" node -e '
    const fs = require("fs"); const path = process.argv[1]
    const bin = process.env.MASKING_ENGINE_BIN.replace(/\\/g, "/")
    const before = fs.readFileSync(path, "utf8")
    const after = before.replace("defineConfig({", `defineConfig({\n  overrides: { engine: ${JSON.stringify(bin)} },`)
    if (after === before) { console.error("could not set overrides.engine"); process.exit(1) }
    fs.writeFileSync(path, after)' "$PROJECT_DIR/supatype.config.ts"
fi
cli generate

echo "==> supatype dev, watching the schema"
(cd "$PROJECT_DIR" && exec node "$MASKING_CLI" dev --stream >"$POSITIONING_DEV_LOG" 2>&1) &
DEV_PID=$!
dev_ready() { grep -q "Press Ctrl+C" "$POSITIONING_DEV_LOG" && http_ok "$BASE_URL/auth/v1/health"; }
if ! wait_until 600 "the positioning stack" dev_ready; then
  tail -40 "$POSITIONING_DEV_LOG"
  exit 1
fi

pg() {
  local pw db
  pw="$(grep -E '^POSTGRES_PASSWORD=' "$PROJECT_DIR/.env" | cut -d= -f2-)"
  db="$(grep -E '^POSTGRES_DB=' "$PROJECT_DIR/.env" | cut -d= -f2-)"
  docker exec -e PGPASSWORD="$pw" "${COMPOSE_PROJECT}-db-1" psql -h 127.0.0.1 -U supatype_admin -d "$db" -X -A -t -q -v ON_ERROR_STOP=1 -c "$1"
}
[[ "$(pg "select to_regclass('_supatype.managed_objects_undo') is not null")" == t ]] \
  || { echo "ERROR: _supatype.managed_objects_undo is missing: the push did not run a ledger-era engine" >&2; exit 1; }
pg "insert into public.member (id, name) values (gen_random_uuid(), 'mine'), (gen_random_uuid(), 'theirs'), (gen_random_uuid(), 'ours')"

echo "==> The checks"
status=0
report="$E2E_DIR/positioning/positioning-report.json"
(cd "$E2E_DIR" && POSITIONING_REPORT="$report" pnpm exec playwright test -c positioning/playwright.config.ts) || status=$?
skipped="$(node -e 'const r = require(process.argv[1]); console.log(r.stats.skipped ?? 0)' "$report" 2>/dev/null || echo unknown)"
if [[ "$skipped" != 0 ]]; then
  echo "ERROR: $skipped positioning test(s) skipped; a skip is not a pass" >&2
  status=1
fi
exit "$status"
