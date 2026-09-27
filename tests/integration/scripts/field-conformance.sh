#!/usr/bin/env bash
# Every field kind, against a real database.
#
# Coverage of which kinds exist was already 32 of 41 when this was written, and every engine defect
# found that week was in a *property* of a kind that was already covered: the column `money`
# creates, the type the AST publishes for it, the TypeScript a required relation generates, whether
# an enum's default reaches `Insert`, whether a second push is a no-op, whether a field can be
# removed at all. So this asserts six things per kind rather than merely declaring each one.
#
# Runs the same way locally and in CI. Locally:
#
#   bash tests/integration/scripts/field-conformance.sh
#
# Set SUPATYPE_KONG_PORT to move it off 18473 when something else is already there, and
# SUPATYPE_E2E_KEEP=1 to leave the stack up and query it after a failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CONFORMANCE_DIR="$ROOT_DIR/tests/integration/conformance"
# Scaffolded outside the repo, and unique per run.
#
# Inside it, the directory showed up in `git status`, and a `dev` child process keeping it as its
# working directory made the next run's `rm -rf` fail with "Device or resource busy" before it had
# done anything. A throwaway project belongs in a throwaway place.
PROJECT_DIR="${CONFORMANCE_PROJECT_DIR:-${TMPDIR:-/tmp}/supatype-conformance-$$}"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
BASE_URL="http://127.0.0.1:${KONG_PORT}"
COMPOSE_PROJECT="supatype-conformance"

DEV_PID=""

cleanup() {
  echo ""
  # The dev process first, always, even when the stack is being kept: it holds the project
  # directory open, and the next run's `rm -rf` then fails with "Device or resource busy" before it
  # has done anything. Every sibling script kills it; this one did not.
  if [[ -n "$DEV_PID" ]]; then kill "$DEV_PID" 2>/dev/null || true; fi
  if [[ "${SUPATYPE_E2E_KEEP:-}" == "1" ]]; then
    echo "==> teardown skipped (SUPATYPE_E2E_KEEP=1); stack left at $BASE_URL"
    return
  fi
  echo "==> teardown"
  (cd "$PROJECT_DIR" && docker compose -p "$COMPOSE_PROJECT" down -v --remove-orphans) >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first" >&2
  exit 1
fi

echo "==> Removing anything left by a previous run"
# Before scaffolding, not only after. Each run generates a fresh POSTGRES_PASSWORD, and Postgres
# only applies one on first init, so a database volume that outlived the last run rejects the new
# credentials with "password authentication failed" and `dev` resets and retries until it times
# out. A harness that depends on its own teardown having succeeded is not one you can trust.
docker rm -f $(docker ps -aq --filter "name=${COMPOSE_PROJECT}-" 2>/dev/null) >/dev/null 2>&1 || true
docker volume rm -f $(docker volume ls -q --filter "name=${COMPOSE_PROJECT}" 2>/dev/null) >/dev/null 2>&1 || true

echo "==> Scaffolding a project of its own"
# Its own project, not the shared integration fixture: this pushes a table, drops columns from it
# and pushes again, so sharing a database would make every other suite depend on the order this ran.
rm -rf "$PROJECT_DIR"
mkdir -p "$PROJECT_DIR"
(cd "$PROJECT_DIR" && node "$CLI_BIN" init conformance --defaults --no-install --no-admin >/dev/null)

# Optionally run against a locally built engine rather than the released one.
#
# An engine change cannot otherwise be checked against this suite until after it ships, which is
# the wrong way round: the whole point is to catch a defect before a release carries it. Set
# SUPATYPE_CONFORMANCE_ENGINE to an engine binary to use it.
if [[ -n "${SUPATYPE_CONFORMANCE_ENGINE:-}" ]]; then
  echo "  using engine ${SUPATYPE_CONFORMANCE_ENGINE}"
  cat > "$PROJECT_DIR/supatype.local.config.ts" <<LOCAL
import { defineConfig } from "@supatype/cli"
export default defineConfig({
  overrides: { engine: "${SUPATYPE_CONFORMANCE_ENGINE}" },
})
LOCAL
fi
# `init <name>` nests; flatten so the project root is where the script expects it.
if [[ -d "$PROJECT_DIR/conformance" ]]; then
  shopt -s dotglob
  mv "$PROJECT_DIR/conformance"/* "$PROJECT_DIR/"
  rmdir "$PROJECT_DIR/conformance"
  shopt -u dotglob
fi

echo "==> Asking for generated types"
node "$CONFORMANCE_DIR/enable-types.mjs" "$PROJECT_DIR/supatype.config.ts"

echo "==> Generating a schema with every declarable kind"
(cd "$ROOT_DIR" && npx tsx "$CONFORMANCE_DIR/generate-schema.ts" "$PROJECT_DIR")

echo "==> Bringing the stack up and pushing"
sed -i "s/^SUPATYPE_KONG_PORT=.*/SUPATYPE_KONG_PORT=${KONG_PORT}/" "$PROJECT_DIR/.env" 2>/dev/null || true
# Without `--no-watch`, deliberately, and every sibling e2e script does the same.
#
# `--no-watch` makes `dev` finish once the stack is up, and finishing runs its shutdown handler,
# which is a `compose down`. So the readiness checks below passed against a stack that was already
# being torn down, and assertion 4 was the first step to touch the API, by which point there was
# nothing listening. That is why assertions 4 through 6 had never once run.
(cd "$PROJECT_DIR" && node "$CLI_BIN" dev) &
DEV_PID=$!

echo "==> Waiting for the API (up to 300s)"
for _ in $(seq 1 150); do
  if curl -fsS -o /dev/null "$BASE_URL/auth/v1/health" 2>/dev/null; then break; fi
  sleep 2
done
curl -fsS -o /dev/null "$BASE_URL/auth/v1/health" || { echo "ERROR: the stack never became ready" >&2; exit 1; }

# And the REST route specifically, which is the one the checks use.
#
# `/auth/v1/health` answers before Kong has finished wiring the rest of its routes, so the round
# trip fired into a socket that accepted and then reset: `bytesRead: 0`, which reads as a network
# fault rather than a stack that is still starting. Any status is fine here, including 401: the
# question is whether something is listening, not whether it likes us.
for _ in $(seq 1 60); do
  # A real HTTP status, not merely a successful exit. `curl -s` returns 0 for a connection Kong
  # accepted but has not finished routing, so the loop broke at once and the round trip fired into
  # a socket that reset: `bytesRead: 0`. `%{http_code}` is `000` until something actually answers.
  REST_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL/rest/v1/" 2>/dev/null || echo 000)"
  if [[ "$REST_CODE" != "000" ]]; then break; fi
  sleep 2
done
echo "  REST answering with HTTP ${REST_CODE:-000}"

# A settle, and an honest one: `dev` prints "Services running" while the checks are already
# querying, so Kong is still being configured when the first write lands and the socket resets
# mid-request. A fixed pause is a mitigation, not a fix. The fix is a readiness signal that means
# "the gateway has finished", which `dev` does not currently expose.
sleep 10

ANON_KEY="$(grep -E '^ANON_KEY=' "$PROJECT_DIR/.env" | cut -d= -f2-)"
[[ -n "$ANON_KEY" ]] || { echo "ERROR: no ANON_KEY in the generated .env" >&2; exit 1; }

# The catalogue, read through the container rather than over a published port.
#
# Nothing guarantees Postgres is reachable from the host: the compose file publishes it only when a
# port variable says so, and `docker port` failing inside a `$( )` under `set -o pipefail` killed
# this script before its own error check could run. `docker exec` needs no published port and no
# DATABASE_URL, so it cannot disagree with either.
COLUMNS_JSON="$PROJECT_DIR/.conformance-columns.json"
docker exec -e PGPASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "$PROJECT_DIR/.env" | cut -d= -f2-)"   "${COMPOSE_PROJECT}-db-1"   psql -U "$(grep -E '^POSTGRES_USER=' "$PROJECT_DIR/.env" | cut -d= -f2-)"        -d "$(grep -E '^POSTGRES_DB=' "$PROJECT_DIR/.env" | cut -d= -f2-)"        -tAc "SELECT coalesce(json_agg(row_to_json(c)), '[]'::json) FROM (
               SELECT column_name, data_type, udt_name, is_nullable
                 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'probe_all'
             ) c" > "$COLUMNS_JSON"
[[ -s "$COLUMNS_JSON" ]] || { echo "ERROR: could not read the catalogue from the database" >&2; exit 1; }
echo "  read $(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length)" "$COLUMNS_JSON") columns from probe_all"

echo ""
echo "==> Asserting what each kind does"
(cd "$ROOT_DIR" && \
  CONFORMANCE_PROJECT="$PROJECT_DIR" \
  SUPATYPE_URL="$BASE_URL" \
  ANON_KEY="$ANON_KEY" \
  CONFORMANCE_COLUMNS="$COLUMNS_JSON" \
  SUPATYPE_CLI="$CLI_BIN" \
  npx tsx "$CONFORMANCE_DIR/verify.ts")

# ── 6. and every kind can be taken away again ────────────────────────────────
#
# Its own step because it rewrites the schema and re-runs the CLI. This is the assertion that a
# field can be *removed*: dropping one from a model carrying a draft view used to fail with
# "cannot drop column ... because other objects depend on it", leaving the migration part-applied.
echo ""
echo "==> Every kind can be dropped again"
python3 - "$PROJECT_DIR/schema/index.ts" <<'PY'
import io, re, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
# Keep id and the slug source; drop every probe column.
kept = [l for l in s.split("\n") if not re.match(r"^  probe(?!Text\b)[A-Z]", l)]
io.open(p, "w", encoding="utf-8", newline="\n").write("\n".join(kept))
PY
(cd "$PROJECT_DIR" && node "$CLI_BIN" push --yes >/dev/null)
echo "  ok   every probe column dropped"

REMAINING="$(cd "$PROJECT_DIR" && node "$CLI_BIN" diff 2>&1 | tail -3)"
case "$REMAINING" in
  *"No changes"*) echo "  ok   the push that dropped them is idempotent" ;;
  *) echo "  FAIL dropping left a pending diff: $REMAINING" >&2; exit 1 ;;
esac

echo ""
echo "PASS: every declarable field kind creates, publishes, generates, round trips, settles and drops"
