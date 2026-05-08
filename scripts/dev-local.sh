#!/usr/bin/env bash
# Local dev runner — bypasses pnpm/cmd.exe so Ctrl+C shuts down cleanly.
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTEGRATION="$REPO_ROOT/tests/integration"

# Stop any leftover Postgres from a previous run.
(cd "$INTEGRATION" && pnpm exec tsx run-dev.ts pg stop) 2>/dev/null || true

# @supatype/client is imported as compiled dist/ by tsx while evaluating config
# and generating outputs; keep it in watch mode for fast local iteration.
echo "[dev-local] Starting watch builds for client..."
pnpm --filter @supatype/client exec tsc --project tsconfig.json --watch --preserveWatchOutput >/dev/null 2>&1 &
CLIENT_PID=$!

# Kill watch processes whenever this script exits (Ctrl+C, error, or normal exit).
trap 'kill "${CLIENT_PID-}" 2>/dev/null; true' EXIT

# Run the dev server in the foreground.  Not exec'd so the EXIT trap fires.
cd "$INTEGRATION"
pnpm exec tsx run-dev.ts dev "$@"
