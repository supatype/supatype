#!/usr/bin/env bash
# Phase 10.6 C21 — zero-to-running soak (native, no Docker).
# Requires: published CDN CLI (cli-v*) + realtime-v* (or local overrides).
#
# Usage:
#   bash scripts/c21-native-soak.sh
#   SUPATYPE_INSTALL_URL=https://install.supatype.io bash scripts/c21-native-soak.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${C21_WORKDIR:-$(mktemp -d -t c21-soak-XXXXXX)}"
INSTALL_URL="${SUPATYPE_INSTALL_URL:-https://install.supatype.io}"
MAX_WAIT="${C21_MAX_WAIT_S:-60}"

echo "==> C21 workdir: $WORK"
cd "$WORK"

if [[ "${C21_USE_LOCAL_CLI:-}" == "1" ]]; then
  echo "==> Using local CLI from monorepo (skip curl|sh)"
  CLI="$ROOT/../../packages/cli/dist/bin.js"
  if [[ ! -f "$CLI" ]]; then
    echo "Build CLI first: pnpm --filter @supatype/cli build" >&2
    exit 1
  fi
  SUPATYPE=(node "$CLI")
else
  echo "==> Installing via curl | sh ($INSTALL_URL)"
  curl -fsSL "$INSTALL_URL" | sh
  export PATH="${HOME}/.supatype/bin:${PATH}"
  SUPATYPE=(supatype)
fi

mkdir -p c21-app && cd c21-app
cat > package.json <<'EOF'
{ "name": "c21-soak", "private": true, "type": "module" }
EOF

echo "==> init + dev (native provider)"
# Non-interactive init may need flags — adjust when CLI supports --yes
"${SUPATYPE[@]}" init --help >/dev/null 2>&1 || true

START=$(date +%s)
# Prefer docker-free provider when available
SUPATYPE_PROVIDER=native "${SUPATYPE[@]}" dev --provider native >/tmp/c21-dev.log 2>&1 &
DEV_PID=$!

cleanup() {
  kill "$DEV_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Waiting up to ${MAX_WAIT}s for API health..."
OK=0
for i in $(seq 1 "$MAX_WAIT"); do
  if curl -sf http://127.0.0.1:54321/auth/v1/health >/dev/null 2>&1 \
    || curl -sf http://127.0.0.1:18473/auth/v1/health >/dev/null 2>&1; then
    OK=1
    ELAPSED=$(( $(date +%s) - START ))
    echo "==> API up in ${ELAPSED}s"
    break
  fi
  sleep 1
done

if [[ "$OK" != "1" ]]; then
  echo "C21 FAILED: API not ready within ${MAX_WAIT}s" >&2
  tail -n 80 /tmp/c21-dev.log >&2 || true
  exit 1
fi

echo "==> C21 PASSED"
