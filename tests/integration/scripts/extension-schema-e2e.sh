#!/usr/bin/env bash
# A project with PostGIS and pgvector columns, pushed to a fresh stack, and the API straight after.
#
# Extensions used to be created in `public`, where PostGIS and pgvector add about 940 functions.
# PostgREST 14 lists the functions of an exposed schema with a query it plans badly while the
# catalog statistics predate them, which they do for 30 to 60 seconds after the push that created
# the extensions, so `GET /rest/v1/` as anon timed out (500, 57014) in exactly the window an
# end-to-end run starts in. They now go in `extensions`, as Supabase puts them.
#
# Asserts, on a stack nothing has touched before:
#   1. the OpenAPI root answers 200, within a second, from the moment the pushed table is served;
#   then that the declared GiST and HNSW indexes exist, the HNSW one with pgvector's cosine class;
#   2. Geo, GeoPoint and Vector columns write, read and filter through REST and GraphQL;
#   3. no PostGIS, pgvector or unaccent function is an endpoint (`/rest/v1/rpc/st_distance`).
#
#   bash tests/integration/scripts/extension-schema-e2e.sh
#
# SUPATYPE_KONG_PORT moves it off 18473, SUPATYPE_E2E_PROJECT names the compose project (to run
# beside another), SUPATYPE_E2E_KEEP=1 leaves the stack up, and SUPATYPE_EXTENSION_ENGINE points the
# project at an engine binary instead of the released one.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$SCRIPT_DIR/lib/http-wait.sh"
source "$SCRIPT_DIR/lib/env-file.sh"
SUITE_DIR="$ROOT_DIR/tests/integration/extension-schema"
PROJECT_DIR="${EXTENSION_SCHEMA_PROJECT_DIR:-${TMPDIR:-/tmp}/supatype-extension-schema-$$}"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
BASE_URL="http://127.0.0.1:${KONG_PORT}"
PROJECT_NAME="${SUPATYPE_E2E_PROJECT:-extension-schema}"
COMPOSE_PROJECT="supatype-${PROJECT_NAME}"
# How long the OpenAPI root may take. PostgREST answered it in milliseconds once the functions were
# out of the exposed schema; the failure took the anon role's whole 3s statement timeout.
ROOT_BUDGET_SECONDS="1.0"

DEV_PID=""

cleanup() {
  echo ""
  if [[ -n "$DEV_PID" ]]; then kill "$DEV_PID" 2>/dev/null || true; fi
  if [[ "${SUPATYPE_E2E_KEEP:-}" == "1" ]]; then
    echo "==> teardown skipped (SUPATYPE_E2E_KEEP=1); stack left at $BASE_URL"
    return
  fi
  echo "==> teardown"
  (cd "$PROJECT_DIR" && docker compose -p "$COMPOSE_PROJECT" down -v --remove-orphans) >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

fail() { echo "  FAIL $1" >&2; exit 1; }

[[ -f "$CLI_BIN" ]] || fail "CLI not found at $CLI_BIN, run 'pnpm build' first"

echo "==> Removing anything left by a previous run of $COMPOSE_PROJECT"
# A fresh stack is the point: the extensions have to be created by this run's first push.
docker rm -f $(docker ps -aq --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" 2>/dev/null) >/dev/null 2>&1 || true
docker volume rm -f $(docker volume ls -q 2>/dev/null | grep -E "^${COMPOSE_PROJECT}_") >/dev/null 2>&1 || true

echo "==> Scaffolding a project of its own"
rm -rf "$PROJECT_DIR"
mkdir -p "$PROJECT_DIR"
(cd "$PROJECT_DIR" && node "$CLI_BIN" init "$PROJECT_NAME" --defaults --no-install --no-admin >/dev/null)
if [[ -d "$PROJECT_DIR/$PROJECT_NAME" ]]; then
  shopt -s dotglob
  mv "$PROJECT_DIR/$PROJECT_NAME"/* "$PROJECT_DIR/"
  rmdir "$PROJECT_DIR/$PROJECT_NAME"
  shopt -u dotglob
fi
if [[ -n "${SUPATYPE_EXTENSION_ENGINE:-}" ]]; then
  echo "  using engine ${SUPATYPE_EXTENSION_ENGINE}"
  cat > "$PROJECT_DIR/supatype.local.config.ts" <<LOCAL
import { defineConfig } from "@supatype/cli"
export default defineConfig({
  overrides: { engine: "${SUPATYPE_EXTENSION_ENGINE}" },
})
LOCAL
fi
mkdir -p "$PROJECT_DIR/schema"
cp "$SUITE_DIR/schema.ts" "$PROJECT_DIR/schema/index.ts"
sed -i "s/^SUPATYPE_KONG_PORT=.*/SUPATYPE_KONG_PORT=${KONG_PORT}/" "$PROJECT_DIR/.env" 2>/dev/null || true
if [[ -n "${SUPATYPE_DEV_DB_PORT:-}" ]]; then
  echo "SUPATYPE_DEV_DB_PORT=${SUPATYPE_DEV_DB_PORT}" >> "$PROJECT_DIR/.env"
fi

echo "==> Bringing the stack up and pushing"
DEV_LOG="$PROJECT_DIR/extension-schema-dev.log"
: > "$DEV_LOG"
(cd "$PROJECT_DIR" && node "$CLI_BIN" dev) > >(tee -a "$DEV_LOG") 2>&1 &
DEV_PID=$!

PUSH_DONE_RE='\[supatype\] (Applied [0-9]+ operation\(s\)|Schema up to date|Schema applied)'
PUSH_FAILED_RE='\[supatype\] (Schema push failed|docker compose failed)'
pushed() { grep -qE "$PUSH_DONE_RE" "$DEV_LOG"; }
push_failed() { grep -qE "$PUSH_FAILED_RE" "$DEV_LOG"; }
wait_for_first_push() {
  local started=$SECONDS
  while (( SECONDS - started < 300 )); do
    pushed && return 0
    push_failed && fail "the first push failed (see $DEV_LOG)"
    kill -0 "$DEV_PID" 2>/dev/null || fail "dev exited before pushing (see $DEV_LOG)"
    sleep 1
  done
  fail "dev did not push within 300s (see $DEV_LOG)"
}
wait_for_first_push
echo "  pushed after the stack came up"

ANON_KEY="$(env_file_value "$PROJECT_DIR/.env" ANON_KEY)"
[[ -n "$ANON_KEY" ]] || fail "no ANON_KEY in the generated .env"

# One request as anon: "<status> <seconds>", bounded well past the anon statement timeout so a
# timeout shows as the 500 it is rather than as curl giving up.
rest_once() {
  curl -s -o /dev/null -w '%{http_code} %{time_total}' --connect-timeout 3 --max-time 15 \
    -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${ANON_KEY}" "$BASE_URL/rest/v1/$1" 2>/dev/null || true
}
# The table the push made, read for no rows: answers 200 once PostgREST has reloaded its schema
# cache after the push, and costs nothing that depends on the extensions' functions.
TABLE_PATH="place?select=id&limit=0"
within_budget() { awk -v t="$1" -v b="$ROOT_BUDGET_SECONDS" 'BEGIN { exit !(t + 0 < b + 0) }'; }

# Waits until dev has finished starting and PostgREST serves the pushed table: before that the
# gateway may still be wiring its routes or reloading (000, 502, or a request held for seconds) and
# PostgREST reloading its schema cache after the push (503, 404). Neither is the question.
wait_for_table() {
  local started=$SECONDS
  while (( SECONDS - started < 120 )); do
    dev_started "$PROJECT_DIR" && [[ "$(rest_once "$TABLE_PATH")" == 200\ * ]] && return 0
    sleep 0.5
  done
  return 1
}

# Six answers from the OpenAPI root, a second apart, from the moment the table answers: the window
# in which the catalog statistics are still older than the push. Every one must be a 200, and the
# fastest must be within the budget. Not every one: on Docker Desktop, Kong holds an occasional
# request for about four seconds on any route, `/auth/v1/health` included, which is the gateway's,
# not PostgREST's. The failure this guards against is the anon statement timeout, which is a 500
# on every answer until autovacuum analyzes the catalog.
ROOT_ANSWERS=6
root_answers_at_once() {
  local code took attempt fastest="" times=""
  wait_for_table || { echo "  FAIL the pushed table was not served within 120s" >&2; return 1; }
  for (( attempt = 1; attempt <= ROOT_ANSWERS; attempt++ )); do
    read -r code took <<< "$(rest_once "")"
    times="$times ${code}:${took}s"
    if [[ "$code" != "200" ]]; then
      echo "  FAIL GET /rest/v1/ as anon answered $code in ${took}s (answer $attempt after the push)" >&2
      return 1
    fi
    if [[ -z "$fastest" ]] || awk -v a="$took" -v b="$fastest" 'BEGIN { exit !(a + 0 < b + 0) }'; then
      fastest="$took"
    fi
    sleep 1
  done
  echo "  answers:$times"
  within_budget "$fastest" || {
    echo "  FAIL no answer from GET /rest/v1/ came within ${ROOT_BUDGET_SECONDS}s (fastest ${fastest}s)" >&2
    return 1
  }
  echo "  ok   $ROOT_ANSWERS answers of 200, the fastest in ${fastest}s"
}

# Each step runs whatever the one before found, so one run says everything that is wrong.
FAILED=0

echo ""
echo "==> 1. The OpenAPI root answers at once after the push"
root_answers_at_once || FAILED=1

# A query against the project's database, through the container: nothing publishes its port.
db_query() {
  local env="$PROJECT_DIR/.env"
  docker exec -e PGPASSWORD="$(env_file_value "$env" POSTGRES_PASSWORD)" "${COMPOSE_PROJECT}-db-1" \
    psql -U "$(env_file_value "$env" POSTGRES_USER)" -d "$(env_file_value "$env" POSTGRES_DB)" \
    -tAc "$1"
}

echo ""
echo "==> The indexes the schema declares, with the operator class pgvector needs"
INDEXES="$(db_query "SELECT string_agg(indexdef, E'\n' ORDER BY indexname) FROM pg_indexes
                      WHERE schemaname = 'public' AND tablename = 'place'
                        AND (indexdef LIKE '%USING gist%' OR indexdef LIKE '%USING hnsw%')")"
echo "$INDEXES" | sed 's/^/  /'
if [[ "$INDEXES" == *"USING gist (location)"* && "$INDEXES" == *"USING hnsw (embedding "*"vector_cosine_ops)"* ]]; then
  echo "  ok   a GiST index on the point and an HNSW cosine index on the vector"
else
  echo "  FAIL the GiST and HNSW indexes the schema declares are not both there" >&2
  FAILED=1
fi

echo ""
echo "==> 2 and 3. The columns through REST and GraphQL, and no extension endpoint"
(cd "$ROOT_DIR" && SUPATYPE_URL="$BASE_URL" ANON_KEY="$ANON_KEY" \
  pnpm --filter supatype-integration exec tsx "$SUITE_DIR/verify.ts") || FAILED=1

(( FAILED == 0 )) || fail "see the failures above (dev log: $DEV_LOG)"
echo ""
echo "PASS: a fresh stack with PostGIS and pgvector columns answers its OpenAPI root at once"
