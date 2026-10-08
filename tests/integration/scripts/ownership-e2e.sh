#!/usr/bin/env bash
# The ownership commands against a real database, end to end through the CLI.
#
# Each of these has unit and engine-integration tests and none had run through the CLI against a
# real Postgres: adopting a table on a database Supatype has never touched (which failed outright
# until schema-engine #80), releasing and reclaiming an object, `doctor --strict` and
# `--rebaseline`, and a rollback that has to put the ledger back with the objects.
#
# Needs only Docker and the built CLI. It runs its own Postgres and drives the engine directly
# (`--direct --connection`), so no stack comes up.
#
# Environment:
#   OWNERSHIP_PG_PORT     host port for the throwaway Postgres (default 55441)
#   OWNERSHIP_ENGINE_BIN  a local engine binary to test, written into the project's overrides.engine;
#                         without it the CLI uses the engine it resolves itself
#   SUPATYPE_POSTGRES_IMAGE  Postgres image (default supatype/postgres:latest)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
PG_PORT="${OWNERSHIP_PG_PORT:-55441}"
PG_IMAGE="${SUPATYPE_POSTGRES_IMAGE:-supatype/postgres:latest}"
PG_CONTAINER="supatype-ownership-e2e-pg"
PG_PASSWORD="ownership-e2e"
URL="postgresql://supatype_admin:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/ownership?sslmode=disable"
PROJECT_DIR="${TMPDIR:-/tmp}/supatype-ownership-$$"

failures=0
cleanup() {
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$PROJECT_DIR"
}
trap cleanup EXIT INT TERM

ok() { echo "  ok    $1"; }
fail() { echo "  FAIL  $1"; failures=$((failures + 1)); }
check() { if eval "$2"; then ok "$1"; else fail "$1"; fi; }
sql() {
  docker exec -i -e PGPASSWORD="$PG_PASSWORD" -e PGOPTIONS="--client-min-messages=warning" "$PG_CONTAINER" \
    psql -h 127.0.0.1 -U supatype_admin -d ownership -v ON_ERROR_STOP=1 -qtAc "$1"
}
cli() { (cd "$PROJECT_DIR" && node "$CLI_BIN" "$@" --direct --connection "$URL"); }
# Passes only when the CLI exits with `code` and prints `pattern`: a refusal for the expected
# reason. A bare `! cli ...` also passed on an unknown flag or a lost database connection.
refuses() {
  local code="$1" pattern="$2" out status=0
  shift 2
  out="$(cli "$@" 2>&1)" || status=$?
  if [[ "$status" -ne "$code" ]]; then
    echo "        expected exit $code, got $status:"
    tail -5 <<<"$out" | sed 's/^/        /'
    return 1
  fi
  if ! grep -qF -- "$pattern" <<<"$out"; then
    echo "        exit $code, but the output does not say: $pattern"
    tail -5 <<<"$out" | sed 's/^/        /'
    return 1
  fi
}
status_of() { sql "SELECT status FROM _supatype.managed_objects WHERE kind = '$1' AND parent = '$2' AND name = '$3'"; }

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first" >&2
  exit 1
fi

echo "==> A Postgres of its own on :$PG_PORT"
docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$PG_CONTAINER" -p "127.0.0.1:${PG_PORT}:5432" \
  -e POSTGRES_USER=supatype_admin -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=ownership \
  "$PG_IMAGE" >/dev/null
for _ in $(seq 1 90); do
  sql "SELECT 1" >/dev/null 2>&1 && break
  sleep 2
done
sql "SELECT 1" >/dev/null

echo "==> A project whose schema declares a table the database already has"
mkdir -p "$PROJECT_DIR"
(cd "$PROJECT_DIR" && node "$CLI_BIN" init ownership --defaults --no-install --no-admin >/dev/null)
if [[ -d "$PROJECT_DIR/ownership" ]]; then
  shopt -s dotglob
  mv "$PROJECT_DIR/ownership"/* "$PROJECT_DIR/"
  rmdir "$PROJECT_DIR/ownership"
fi
cat >> "$PROJECT_DIR/schema/index.ts" <<'TS'

/** Exists before Supatype does: adopted, released, reclaimed. */
export type Legacy = Model<{
  id: UUID
  name: string
}, {
  access: {
    read: Public
  }
}>
TS
if [[ -n "${OWNERSHIP_ENGINE_BIN:-}" ]]; then
  OWNERSHIP_ENGINE_BIN="$OWNERSHIP_ENGINE_BIN" node -e '
    const fs = require("fs")
    const path = process.argv[1]
    const bin = process.env.OWNERSHIP_ENGINE_BIN.replace(/\\/g, "/")
    const before = fs.readFileSync(path, "utf8")
    const after = before.replace("defineConfig({", `defineConfig({\n  overrides: { engine: ${JSON.stringify(bin)} },`)
    if (after === before) { console.error("could not set overrides.engine"); process.exit(1) }
    fs.writeFileSync(path, after)
  ' "$PROJECT_DIR/supatype.config.ts"
fi
# The Supatype image has these; a plain Postgres does not, and the access rules refer to them.
sql "CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE)"
sql "CREATE TABLE public.legacy (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)"
sql "INSERT INTO public.legacy (name) VALUES ('kept')"

# The ledger commands ship in engine 0.7.0. Against an older engine the rest of this script would
# only measure that it is old, so say so and stop. An engine named in OWNERSHIP_ENGINE_BIN is one
# someone chose to test, so it always runs.
if [[ -z "${OWNERSHIP_ENGINE_BIN:-}" ]]; then
  cli doctor >/dev/null 2>&1 || true # resolves, and if need be downloads, the CLI's engine
  # `|| true` inside each: with no engine cached, `ls` fails, and under `set -euo pipefail` the
  # assignment would end the script with exit 2 instead of reaching the skip below.
  engine_bin="$(ls -t "$HOME"/.supatype/cache/engine/*/supatype-engine-* 2>/dev/null | head -1 || true)"
  engine_version="$([[ -n "$engine_bin" ]] && "$engine_bin" --version 2>/dev/null | awk '{print $2}' || true)"
  if [[ -z "$engine_version" ]] || [[ "$(printf '%s\n0.7.0\n' "$engine_version" | sort -V | head -1)" != "0.7.0" ]]; then
    if [[ -z "$engine_version" ]]; then
      reason="no cached engine whose version could be read, so none known to have the ledger commands (0.7.0)"
    else
      reason="engine $engine_version predates the ledger commands (0.7.0)"
    fi
    reason="$reason; set OWNERSHIP_ENGINE_BIN to test one"
    # Loud on purpose: this job is green when it skips, and that must not read as a pass.
    echo
    echo "################################################################################"
    echo "SKIPPED, NOT PASSED: no ownership check ran. $reason"
    echo "################################################################################"
    if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
      echo "::warning title=ownership-e2e skipped::No ownership check ran: $reason"
      if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
        echo "### ownership-e2e SKIPPED: no check ran. $reason" >>"$GITHUB_STEP_SUMMARY"
      fi
    fi
    exit 0
  fi
fi

echo "==> Adopt, on a database Supatype has never pushed to"
check "the first push refuses the existing table" 'refuses 1 "Supatype did not create it" push --yes'
check "adopt takes it" 'cli adopt --yes 2>&1 | grep -q "Adopted 1 object"'
check "the push it unblocks applies" 'cli push --yes >/dev/null 2>&1'
check "the table is recorded as adopted" '[[ "$(status_of table "" legacy)" == adopted ]]'
check "the row it held is still there" '[[ "$(sql "SELECT name FROM public.legacy")" == kept ]]'
check "doctor --strict is clean" 'cli doctor --strict >/dev/null 2>&1'

echo "==> Release and reclaim"
policy_count() { sql "SELECT count(*) FROM pg_policies WHERE tablename = 'legacy' AND policyname = 'legacy_select'"; }
check "release names the policy" 'cli adopt --release policy:legacy.legacy_select --yes 2>&1 | grep -q "released 1"'
check "the ledger says released" '[[ "$(status_of policy legacy legacy_select)" == released ]]'
sql "DROP POLICY legacy_select ON public.legacy"
check "a push leaves the released policy alone" 'cli push --yes >/dev/null 2>&1 && [[ "$(policy_count)" == 0 ]]'
check "doctor lists it as released" 'cli doctor 2>&1 | grep -q "Released"'
check "reclaim hands it back" 'cli adopt --reclaim policy:legacy.legacy_select --yes 2>&1 | grep -q "reclaimed 1"'
# Putting back an access rule removed outside Supatype needs consent, reclaimed or not.
check "the next push asks before restoring an access rule" 'refuses 1 "pass --overwrite-drift" push --yes'
check "with consent it restores it" 'cli push --yes --overwrite-drift >/dev/null 2>&1 && [[ "$(policy_count)" == 1 ]]'

echo "==> doctor --strict and --rebaseline"
sql "ALTER POLICY legacy_select ON public.legacy USING (name <> 'hidden')"
check "doctor --strict fails on a hand edit" 'refuses 1 "Drifted (changed outside Supatype)" doctor --strict'
# A rebaseline takes the database's version as Supatype's, so it asks first; a hand edit to an
# access rule is taken only with --overwrite-drift as well.
check "--rebaseline will not run unasked" 'refuses 1 "doctor --rebaseline needs --yes when not interactive" doctor --rebaseline'
check "--rebaseline --yes leaves a hand-edited policy alone" 'cli doctor --rebaseline --yes 2>&1 | grep -qF "pass --overwrite-drift to record these too"'
check "so doctor --strict still fails on it" 'refuses 1 "Drifted (changed outside Supatype)" doctor --strict'
check "--rebaseline --overwrite-drift records it" 'cli doctor --rebaseline --overwrite-drift --yes 2>&1 | grep -q "1 rebaselined"'
check "doctor --strict is clean after" 'cli doctor --strict >/dev/null 2>&1'
check "and a push keeps the hand edit" 'cli push --yes >/dev/null 2>&1 && sql "SELECT qual FROM pg_policies WHERE policyname = '"'"'legacy_select'"'"'" | grep -q hidden'

echo "==> Rollback puts the ledger back"
cp "$PROJECT_DIR/schema/index.ts" "$PROJECT_DIR/schema/index.ts.before"
node -e '
  const fs = require("fs")
  const path = process.argv[1]
  const before = fs.readFileSync(path, "utf8")
  const after = before.replace("  name: string\n}, {\n  access: {\n    read: Public", "  name: string\n  note: string | null\n}, {\n  access: {\n    read: Public")
  if (after === before) { console.error("could not add the note field"); process.exit(1) }
  fs.writeFileSync(path, after)
' "$PROJECT_DIR/schema/index.ts"
note_column() { sql "SELECT count(*) FROM information_schema.columns WHERE table_name = 'legacy' AND column_name = 'note'"; }
check "a push adds the column and its ledger row" 'cli push --yes >/dev/null 2>&1 && [[ "$(note_column)" == 1 && -n "$(status_of column legacy note)" ]]'
cp "$PROJECT_DIR/schema/index.ts" "$PROJECT_DIR/schema/index.ts.with-note"
check "rollback removes both" 'cli rollback --no-sync-schema >/dev/null 2>&1 && [[ "$(note_column)" == 0 && -z "$(status_of column legacy note)" ]]'
check "--no-sync-schema leaves the schema files alone" 'cmp -s "$PROJECT_DIR/schema/index.ts" "$PROJECT_DIR/schema/index.ts.with-note"'
mv "$PROJECT_DIR/schema/index.ts.before" "$PROJECT_DIR/schema/index.ts"
check "doctor --strict is clean with the schema back as it was" 'cli doctor --strict >/dev/null 2>&1'

if [[ "$failures" -gt 0 ]]; then
  echo "FAILED: $failures check(s)"
  exit 1
fi
echo "PASS: adopt, release, reclaim, doctor --strict and --rebaseline, and rollback hold against a real database"
