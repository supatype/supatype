#!/usr/bin/env bash
# Integration test runner.
#
# Usage:
#   ./scripts/integration-test.sh [--skip-build]
#
# Environment variables (all optional — override auto-detection):
#   SUPATYPE_ENGINE        Path to local engine binary
#   SUPATYPE_SERVER        Path to local server binary
#   SUPATYPE_POSTGRES_DIR  Path to local Postgres installation directory
#   SUPATYPE_ANON_KEY      Anon key for tests (default: integration-anon-key)
#   SUPATYPE_URL           Base URL for tests (default: http://localhost:54399)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$INTEGRATION_DIR/../.." && pwd)"

SKIP_BUILD="${1:-}"
SERVER_PID=""
SUPATYPE_PID=""

cleanup() {
  echo ""
  echo "==> Teardown"
  if [[ -n "$SUPATYPE_PID" ]]; then
    kill "$SUPATYPE_PID" 2>/dev/null || true
    wait "$SUPATYPE_PID" 2>/dev/null || true
  fi
  echo "  Done."
}
trap cleanup EXIT INT TERM

# ── Step 1: Build all components (unless --skip-build) ────────────────────────

if [[ "$SKIP_BUILD" != "--skip-build" ]]; then
  echo "==> Building packages"
  cd "$ROOT_DIR"
  pnpm build

  if [[ -d "$ROOT_DIR/../supatype-schema-engine" ]]; then
    echo "==> Building schema engine (Rust)"
    cd "$ROOT_DIR/../supatype-schema-engine"
    cargo build --release --quiet
    SUPATYPE_ENGINE="${SUPATYPE_ENGINE:-$ROOT_DIR/../supatype-schema-engine/target/release/supatype-engine}"
  fi

  if [[ -d "$ROOT_DIR/../supatype-auth" ]]; then
    echo "==> Building supatype-server (Go)"
    cd "$ROOT_DIR/../supatype-auth"
    go build -o /tmp/supatype-server-local ./cmd/ 2>/dev/null || true
    SUPATYPE_SERVER="${SUPATYPE_SERVER:-/tmp/supatype-server-local}"
  fi

  cd "$INTEGRATION_DIR"
fi

# ── Step 2: Write supatype.local.config.ts (binary overrides) ─────────────────

echo "==> Configuring integration project"

node "$SCRIPT_DIR/write-local-config.mjs" "$INTEGRATION_DIR/supatype.local.config.ts"

# ── Step 3: Start supatype dev ────────────────────────────────────────────────

echo "==> Starting supatype dev (port 54399)"
cd "$INTEGRATION_DIR"

CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN — run 'pnpm build' first"
  exit 1
fi

node "$CLI_BIN" dev &
SUPATYPE_PID=$!

# ── Step 4: Wait for health ───────────────────────────────────────────────────

BASE_URL="${SUPATYPE_URL:-http://localhost:54399}"
MAX_WAIT=60
echo "==> Waiting for $BASE_URL to be ready (up to ${MAX_WAIT}s)..."

for i in $(seq 1 "$MAX_WAIT"); do
  if curl -sf "$BASE_URL/auth/v1/health" > /dev/null 2>&1; then
    echo "  Ready after ${i}s"
    break
  fi
  if [[ "$i" -eq "$MAX_WAIT" ]]; then
    echo "  ERROR: Server did not become ready within ${MAX_WAIT}s"
    exit 1
  fi
  sleep 1
done

# ── Step 5: Run tests ─────────────────────────────────────────────────────────

echo "==> Running integration tests"
cd "$ROOT_DIR"

export SUPATYPE_URL="${SUPATYPE_URL:-http://localhost:54399}"
export SUPATYPE_ANON_KEY="${SUPATYPE_ANON_KEY:-integration-anon-key}"

node --import tsx/esm --test --experimental-test-coverage \
  tests/integration/tests/api.test.ts

echo ""
echo "==> All tests passed."
