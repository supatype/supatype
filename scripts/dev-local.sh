#!/usr/bin/env bash
# Local dev runner — bypasses pnpm/cmd.exe so Ctrl+C shuts down cleanly.
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTEGRATION="$REPO_ROOT/tests/integration"

# Stop any leftover Postgres from a previous run.
(cd "$INTEGRATION" && pnpm exec tsx run-dev.ts pg stop) 2>/dev/null || true

# @supatype/schema and @supatype/client are imported as compiled dist/ by tsx
# when evaluating the user's schema file.  Start tsc --watch for both so that
# edits to those packages take effect immediately without a manual rebuild.
echo "[dev-local] Starting watch builds for schema + client..."
pnpm --filter @supatype/schema exec tsc --project tsconfig.json --watch --preserveWatchOutput >/dev/null 2>&1 &
SCHEMA_PID=$!
pnpm --filter @supatype/client exec tsc --project tsconfig.json --watch --preserveWatchOutput >/dev/null 2>&1 &
CLIENT_PID=$!

# Kill watch processes whenever this script exits (Ctrl+C, error, or normal exit).
trap 'kill "${SCHEMA_PID-}" "${CLIENT_PID-}" 2>/dev/null; true' EXIT

# Run the dev server in the foreground.  Not exec'd so the EXIT trap fires.
cd "$INTEGRATION"
pnpm exec tsx run-dev.ts dev "$@"
