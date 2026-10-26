#!/usr/bin/env bash
# Realtime's tier-2 suite (RT-2: packages/realtime/tests/rls-tier2.integration.test.ts) against a
# genuine tier-2 database pushed by the train's engine.
#
# The test skips itself without TIER2_DATABASE_URL, which is how `pnpm turbo run test` runs it,
# so on its own it has never been run by CI. Here the database is built first and the URL given,
# and run-suite.sh counts any skip in the output as a failure.
#
# A candidate that does not carry the suite yet (it lives on integration/release) fails here with
# that said, rather than passing on nothing.
#
# Environment: TRAIN_ENGINE_BIN; runs from the candidate supatype checkout.
set -euo pipefail

TEST=packages/realtime/tests/rls-tier2.integration.test.ts
MAKE_DB=packages/realtime/tests/fixtures/tier2/make-db.sh
CONTAINER=train-realtime-tier2-pg
PORT="${TRAIN_TIER2_PG_PORT:-56460}"

if [[ ! -f "$TEST" || ! -f "$MAKE_DB" ]]; then
  echo "ERROR: $TEST is not in this candidate; the tier-2 realtime suite cannot run" >&2
  exit 1
fi

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
cleanup

out="$(SUPATYPE_CLI="node packages/cli/bin/supatype.js" SUPATYPE_ENGINE="${TRAIN_ENGINE_BIN:?}" \
  bash "$MAKE_DB" "$CONTAINER" "$PORT")"
echo "$out"
url="$(sed -n 's/^TIER2_DATABASE_URL=//p' <<<"$out")"
[[ -n "$url" ]] || { echo "ERROR: make-db.sh printed no TIER2_DATABASE_URL" >&2; exit 1; }

TIER2_DATABASE_URL="$url" pnpm --filter @supatype/realtime exec vitest run "${TEST#packages/realtime/}"
