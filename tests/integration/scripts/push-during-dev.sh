#!/usr/bin/env bash
# `supatype push` while `supatype dev` is running on the same project, on a real stack.
#
# Both drive the same Compose project. Before `.supatype/compose.lock` they did it at the same
# time, and whichever lost the `db` recreate failed with
# `The container name ".../<project>-db-1" is already in use` (field-conformance hit it in CI).
# This runs the collision on purpose, in both directions, and asserts that:
#
#   - every push succeeds, the dev watcher's included, and no compose conflict appears anywhere
#   - the lock actually engaged: at least one side printed that it waited for the other, so a pass
#     is not just two pushes that happened not to overlap
#   - each round's model reached the database, and the schema is fully applied at the end
#   - nothing is left holding the lock once everything is idle
#
#   bash tests/integration/scripts/push-during-dev.sh
#
# Set SUPATYPE_KONG_PORT to move it off 18474, SUPATYPE_E2E_KEEP=1 to leave the stack up.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PROJECT_DIR="${PUSHLOCK_PROJECT_DIR:-${TMPDIR:-/tmp}/supatype-pushlock-$$}"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18474}"
BASE_URL="http://127.0.0.1:${KONG_PORT}"
COMPOSE_PROJECT="supatype-pushlock"
SCHEMA="$PROJECT_DIR/schema/index.ts"
LOCK_FILE="$PROJECT_DIR/.supatype/compose.lock"

# With a service-role key in the environment `push` goes through the server's API rather than
# compose, and would not exercise the race at all.
unset SERVICE_ROLE_KEY SUPATYPE_SERVICE_ROLE_KEY

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

fail() { echo "  FAIL $*" >&2; exit 1; }

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first" >&2
  exit 1
fi

echo "==> Removing anything left by a previous run"
docker rm -f $(docker ps -aq --filter "name=${COMPOSE_PROJECT}-" 2>/dev/null) >/dev/null 2>&1 || true
docker volume rm -f $(docker volume ls -q --filter "name=${COMPOSE_PROJECT}" 2>/dev/null) >/dev/null 2>&1 || true

echo "==> Scaffolding"
rm -rf "$PROJECT_DIR"
mkdir -p "$PROJECT_DIR"
(cd "$PROJECT_DIR" && node "$CLI_BIN" init pushlock --defaults --no-install --no-admin >/dev/null)
if [[ -d "$PROJECT_DIR/pushlock" ]]; then
  shopt -s dotglob
  mv "$PROJECT_DIR/pushlock"/* "$PROJECT_DIR/"
  rmdir "$PROJECT_DIR/pushlock"
  shopt -u dotglob
fi
grep -q 'UUID' "$SCHEMA" && grep -q 'Public' "$SCHEMA" \
  || fail "the scaffolded schema no longer imports UUID and Public, which the probe models use"

echo "==> Starting dev (watching)"
sed -i "s/^SUPATYPE_KONG_PORT=.*/SUPATYPE_KONG_PORT=${KONG_PORT}/" "$PROJECT_DIR/.env" 2>/dev/null || true
DEV_LOG="$PROJECT_DIR/dev.log"
: > "$DEV_LOG"
(cd "$PROJECT_DIR" && node "$CLI_BIN" dev) > >(tee -a "$DEV_LOG") 2>&1 &
DEV_PID=$!

for _ in $(seq 1 150); do
  if grep -q "Watching .* for changes" "$DEV_LOG"; then break; fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then fail "dev exited during startup"; fi
  sleep 2
done
grep -q "Watching .* for changes" "$DEV_LOG" || fail "dev never reached its watcher"
[[ ! -e "$LOCK_FILE" ]] || fail "dev still holds $LOCK_FILE after startup: $(cat "$LOCK_FILE")"
echo "  ok   dev is up and has released the lock"

# ── helpers ──────────────────────────────────────────────────────────────────

PUSH_DONE_RE='\[supatype\] (Applied [0-9]+ operation\(s\)|Schema up to date|Schema applied)'
PUSH_FAILED_RE='\[supatype\] (Schema push failed|docker compose failed)'
CONFLICT_RE='is already in use|docker compose failed'
count() { grep -cE "$1" "$2" || true; }

add_model() {
  local name="$1"
  cat >> "$SCHEMA" <<TS

export type ${name} = Model<{
  id: UUID
  note: string
}, {
  access: { read: Public }
}>
TS
}

# Model names are PascalCase; the table is their snake_case.
table_exists() {
  local table="$1"
  docker exec -e PGPASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "$PROJECT_DIR/.env" | cut -d= -f2-)" \
    "${COMPOSE_PROJECT}-db-1" \
    psql -U "$(grep -E '^POSTGRES_USER=' "$PROJECT_DIR/.env" | cut -d= -f2-)" \
         -d "$(grep -E '^POSTGRES_DB=' "$PROJECT_DIR/.env" | cut -d= -f2-)" \
    -tAc "SELECT to_regclass('public.${table}') IS NOT NULL" 2>/dev/null | grep -qx t
}

# Wait for the watcher to log one more push outcome than `before`, and require it to be a success.
wait_watcher() {
  local done_before="$1" failed_before="$2" label="$3"
  for _ in $(seq 1 120); do
    if (( $(count "$PUSH_FAILED_RE" "$DEV_LOG") > failed_before )); then fail "$label: the dev watcher's push failed"; fi
    if (( $(count "$PUSH_DONE_RE" "$DEV_LOG") > done_before )); then return 0; fi
    sleep 1
  done
  fail "$label: the dev watcher never finished its push"
}

WAITS=0

# ── round: push starts while the watcher is pushing ──────────────────────────
#
# The edit starts the watcher (300ms debounce, then it takes the lock at once); `push` needs a
# second or so to load config and the schema, so it reaches the lock while the watcher holds it.
push_into_watcher() {
  local n="$1" model="PushLockProbe${n}" table="push_lock_probe${n}"
  echo ""
  echo "==> round ${n}: push while the dev watcher is pushing"
  local done_before failed_before out
  done_before="$(count "$PUSH_DONE_RE" "$DEV_LOG")"
  failed_before="$(count "$PUSH_FAILED_RE" "$DEV_LOG")"
  out="$PROJECT_DIR/push-${n}.log"

  add_model "$model"
  local status=0
  (cd "$PROJECT_DIR" && node "$CLI_BIN" push --yes) > "$out" 2>&1 || status=$?
  cat "$out" | sed 's/^/    push| /'

  [[ "$status" == "0" ]] || fail "round ${n}: push exited ${status}"
  if grep -qE "$CONFLICT_RE" "$out"; then fail "round ${n}: push hit a compose conflict"; fi
  echo "  ok   push succeeded"
  wait_watcher "$done_before" "$failed_before" "round ${n}"
  echo "  ok   the watcher's push succeeded"
  if grep -q "Waiting for supatype dev" "$out"; then
    WAITS=$((WAITS + 1))
    echo "  ok   push waited for the watcher"
  fi
  table_exists "$table" || fail "round ${n}: ${table} is not in the database"
  echo "  ok   ${table} exists"
}

# ── round: the watcher fires while push is pushing ───────────────────────────
#
# `push` takes the lock as soon as it reaches compose and holds it through `up -d` and the gateway
# checks, so an edit a couple of seconds in lands while it holds it.
watcher_into_push() {
  local n="$1" model="PushLockProbe${n}" table="push_lock_probe${n}"
  echo ""
  echo "==> round ${n}: the dev watcher fires while push is pushing"
  local done_before failed_before waits_before out
  done_before="$(count "$PUSH_DONE_RE" "$DEV_LOG")"
  failed_before="$(count "$PUSH_FAILED_RE" "$DEV_LOG")"
  waits_before="$(count "Waiting for supatype push" "$DEV_LOG")"
  out="$PROJECT_DIR/push-${n}.log"

  (cd "$PROJECT_DIR" && node "$CLI_BIN" push --yes) > "$out" 2>&1 &
  local push_pid=$!
  for _ in $(seq 1 100); do
    [[ -e "$LOCK_FILE" ]] && grep -q '"supatype push"' "$LOCK_FILE" 2>/dev/null && break
    kill -0 "$push_pid" 2>/dev/null || break
    sleep 0.1
  done
  add_model "$model"

  local status=0
  wait "$push_pid" || status=$?
  cat "$out" | sed 's/^/    push| /'
  [[ "$status" == "0" ]] || fail "round ${n}: push exited ${status}"
  if grep -qE "$CONFLICT_RE" "$out"; then fail "round ${n}: push hit a compose conflict"; fi
  echo "  ok   push succeeded"
  wait_watcher "$done_before" "$failed_before" "round ${n}"
  echo "  ok   the watcher's push succeeded"
  if (( $(count "Waiting for supatype push" "$DEV_LOG") > waits_before )); then
    WAITS=$((WAITS + 1))
    echo "  ok   the watcher waited for push"
  fi
  table_exists "$table" || fail "round ${n}: ${table} is not in the database"
  echo "  ok   ${table} exists"
}

push_into_watcher 1
push_into_watcher 2
watcher_into_push 3
push_into_watcher 4

echo ""
echo "==> after every round"
if grep -qE "$CONFLICT_RE" "$DEV_LOG"; then fail "the dev log shows a compose conflict"; fi
echo "  ok   no compose conflict in the dev log"
(( WAITS > 0 )) || fail "no push ever waited for another: the rounds never overlapped, so this proved nothing"
echo "  ok   the lock engaged in ${WAITS} of 4 rounds"
REMAINING="$(cd "$PROJECT_DIR" && node "$CLI_BIN" diff 2>&1 | tail -3)"
case "$REMAINING" in
  *"No changes"*) echo "  ok   the schema is fully applied" ;;
  *) fail "a diff is still pending: $REMAINING" ;;
esac
[[ ! -e "$LOCK_FILE" ]] || fail "$LOCK_FILE is still held while everything is idle: $(cat "$LOCK_FILE")"
echo "  ok   nothing is left holding the lock"
kill -0 "$DEV_PID" 2>/dev/null || fail "dev is no longer running"
echo "  ok   dev is still running"

echo ""
echo "PASS: push and the dev watcher take turns on the Compose stack"
