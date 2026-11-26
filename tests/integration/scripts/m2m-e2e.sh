#!/usr/bin/env bash
# Prove many-to-many links can be written through the link (junction) table over the normal API.
#
# The engine derives a junction's access from its two ends, and the generator emits the junction
# for the client. Neither had been exercised by a request. So this brings a stack up, signs in as
# two users, and asserts what each can do to `lot_tag`: the owner of a lot links, lists and removes;
# a user who cannot update the lot cannot link it; anon cannot write. It also typechecks the
# generated client against `from("lot_tag")`.
#
# Beside another run, from another checkout: SUPATYPE_E2E_PROJECT names this run's compose project,
# and SUPATYPE_KONG_PORT, SUPATYPE_SERVER_PORT and SUPATYPE_SEAWEEDFS_PORT move its ports. See
# lib/e2e-project.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EXAMPLE_DIR="$ROOT_DIR/examples/m2m"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18750}"
BASE_URL="${M2M_E2E_URL:-http://127.0.0.1:${KONG_PORT}}"
MAX_WAIT=180

source "$SCRIPT_DIR/lib/compose-reset.sh"
source "$SCRIPT_DIR/lib/e2e-project.sh"
source "$SCRIPT_DIR/lib/env-file.sh"
e2e_project_use "$EXAMPLE_DIR" m2m
export SUPATYPE_KONG_PORT="$KONG_PORT"

CONFIG="$EXAMPLE_DIR/supatype.config.ts"
cleanup() {
  [[ -f "$CONFIG.bak" ]] && mv "$CONFIG.bak" "$CONFIG"
  e2e_project_down
  e2e_project_release
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

cd "$EXAMPLE_DIR"
# M2M_ENGINE_BIN: a local engine binary to push with, written into the config for this run only.
if [[ -n "${M2M_ENGINE_BIN:-}" ]]; then
  cp "$CONFIG" "$CONFIG.bak"
  M2M_ENGINE_BIN="$M2M_ENGINE_BIN" node -e '
    const fs = require("fs")
    const bin = process.env.M2M_ENGINE_BIN.split(String.fromCharCode(92)).join("/")
    const before = fs.readFileSync(process.argv[1], "utf8")
    const after = before.replace("defineConfig({", `defineConfig({
  overrides: { engine: ${JSON.stringify(bin)} },`)
    if (after === before) { console.error("could not set overrides.engine"); process.exit(1) }
    fs.writeFileSync(process.argv[1], after)
  ' "$CONFIG"
fi
node "$SCRIPT_DIR/ensure-compose-env.mjs" "$EXAMPLE_DIR"

echo "==> Removing anything a previous run left in $E2E_COMPOSE_PROJECT"
remove_compose_project "$E2E_COMPOSE_PROJECT"

echo "==> Bringing the stack up"
node "$CLI_BIN" self-host compose up -d

echo "==> Waiting for $BASE_URL (up to ${MAX_WAIT}s)"
for i in $(seq 1 "$MAX_WAIT"); do
  curl -sf "$BASE_URL/auth/v1/health" >/dev/null 2>&1 && break
  if [[ "$i" -eq "$MAX_WAIT" ]]; then
    echo "ERROR: stack did not become ready within ${MAX_WAIT}s"
    docker compose -p "$E2E_COMPOSE_PROJECT" ps || true
    exit 1
  fi
  sleep 1
done

# Pushed once the gateway answers: a push straight after `up -d` can find the stack not yet reachable.
node "$CLI_BIN" push --yes

echo "==> The generated client types the junction"
node "$CLI_BIN" generate >/dev/null
grep -q "lot_tag:" supatype/generated/database.ts || { echo "FAIL: no lot_tag in the generated types"; exit 1; }
(cd "$ROOT_DIR" && npx tsc -p examples/m2m/tsconfig.json --noEmit)

# Proves the test can fail: M2M_PRE_VERIFY_SQL runs in the database first, for example to drop the
# junction's policies, and the run must then exit non-zero.
if [[ -n "${M2M_PRE_VERIFY_SQL:-}" ]]; then
  echo "==> Sabotage: $M2M_PRE_VERIFY_SQL"
  db="$(docker ps -q --filter "label=com.docker.compose.project=$E2E_COMPOSE_PROJECT" --filter "label=com.docker.compose.service=db" | head -1)"
  docker exec -e PGPASSWORD="$(env_file_value .env POSTGRES_PASSWORD)" "$db"     psql -U "$(env_file_value .env POSTGRES_USER)" -d "$(env_file_value .env POSTGRES_DB)" -v ON_ERROR_STOP=1 -X -c "$M2M_PRE_VERIFY_SQL"
fi

echo "==> Engine that pushed"
docker exec -e PGPASSWORD="$(env_file_value .env POSTGRES_PASSWORD)" "$(docker ps -q --filter "label=com.docker.compose.project=$E2E_COMPOSE_PROJECT" --filter "label=com.docker.compose.service=db" | head -1)"   psql -U "$(env_file_value .env POSTGRES_USER)" -d "$(env_file_value .env POSTGRES_DB)" -X -tAc   "SELECT string_agg(DISTINCT coalesce(engine_version, 'none'), ',') FROM _supatype.migrations"

echo "==> The junction names the engine chose"
db="$(docker ps -q --filter "label=com.docker.compose.project=$E2E_COMPOSE_PROJECT" --filter "label=com.docker.compose.service=db" | head -1)"
docker exec -e PGPASSWORD="$(env_file_value .env POSTGRES_PASSWORD)" "$db"   psql -U "$(env_file_value .env POSTGRES_USER)" -d "$(env_file_value .env POSTGRES_DB)" -X -tAc   "SELECT table_name || '(' || string_agg(column_name, ',' ORDER BY column_name) || ')' FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'lot_%' OR table_name LIKE '%_lot' GROUP BY table_name"

echo "==> Linking, listing and removing"
# `tsx` belongs to tests/integration, so it is run through that package: `npx tsx` from the example
# finds it only when pnpm hoists it, which a strict install does not (exit 127, "tsx: not found").
(cd "$ROOT_DIR" && SUPATYPE_URL="$BASE_URL" SUPATYPE_ANON_KEY="$(cd "$EXAMPLE_DIR" && env_file_value .env ANON_KEY)" \
  pnpm --filter supatype-integration exec tsx "$EXAMPLE_DIR/verify.ts")
