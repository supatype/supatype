#!/usr/bin/env bash
# Zero to running, native path (no Docker): a new project through to an API that answers.
# Phase-10.6 row C21 asked for it; the name says what it does.
# Requires: a published CDN CLI (from a v* release) plus realtime-v*, or local overrides.
#
# Usage:
#   bash tests/integration/scripts/zero-to-running-native.sh
#   SUPATYPE_INSTALL_URL=http://127.0.0.1:8749/install.sh bash tests/integration/scripts/zero-to-running-native.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/http-wait.sh"
WORK="${SUPATYPE_ZTR_WORK_ROOT:-$(mktemp -d -t ztr-native-XXXXXX)}"
INSTALL_URL="${SUPATYPE_INSTALL_URL:-https://supatype.com/install.sh}"
MAX_WAIT="${SUPATYPE_ZTR_MAX_WAIT:-60}"

echo "==> workdir: $WORK"
cd "$WORK"

if [[ "${SUPATYPE_ZTR_USE_LOCAL_CLI:-}" == "1" ]]; then
  echo "==> Using local CLI from monorepo (skip curl|sh)"
  CLI="$ROOT/../../packages/cli/bin/supatype.js"
  if [[ ! -f "$CLI" ]]; then
    echo "Build CLI first: pnpm --filter @supatype/cli build" >&2
    exit 1
  fi
  SUPATYPE=(node "$CLI")
else
  echo "==> Installing via curl | sh ($INSTALL_URL)"
  curl -fsSL "$INSTALL_URL" | bash
  export PATH="${HOME}/.supatype/bin:${PATH}"
  SUPATYPE=(supatype)
fi

mkdir -p ztr-native-app && cd ztr-native-app
cat > package.json <<'EOF'
{ "name": "ztr-native", "private": true, "type": "module" }
EOF

echo "==> init + dev (native provider)"
# Non-interactive init may need flags, adjust when CLI supports --yes
"${SUPATYPE[@]}" init --help >/dev/null 2>&1 || true

START=$(date +%s)
# Prefer docker-free provider when available
SUPATYPE_PROVIDER=native "${SUPATYPE[@]}" dev --provider native >/tmp/ztr-native-dev.log 2>&1 &
DEV_PID=$!

cleanup() {
  kill "$DEV_PID" 2>/dev/null || true
}
trap cleanup EXIT

ztr_native_ready() {
  http_ok http://127.0.0.1:54321/auth/v1/health \
    || http_ok http://127.0.0.1:18473/auth/v1/health
}

OK=0
if wait_until "$MAX_WAIT" "native API health" ztr_native_ready; then
  OK=1
  echo "==> API up in $(( $(date +%s) - START ))s"
fi

if [[ "$OK" != "1" ]]; then
  echo "zero-to-running (native) FAILED: API not ready within ${MAX_WAIT}s" >&2
  tail -n 80 /tmp/ztr-native-dev.log >&2 || true
  exit 1
fi

echo "==> zero-to-running (native) PASSED"
