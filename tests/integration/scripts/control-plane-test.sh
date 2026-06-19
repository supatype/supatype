#!/usr/bin/env bash
# Control-plane integration tests (Kong → server → /platform/v1).
#
# Usage: ./scripts/control-plane-test.sh
#
# Requires a running `supatype dev` stack with control-plane service.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$INTEGRATION_DIR/../.." && pwd)"

ENV_FILE="$INTEGRATION_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a && source "$ENV_FILE" && set +a
fi

export SUPATYPE_URL="${SUPATYPE_URL:-http://localhost:${SUPATYPE_KONG_PORT:-18473}}"
export SUPATYPE_SERVICE_ROLE_KEY="${SUPATYPE_SERVICE_ROLE_KEY:-${SERVICE_ROLE_KEY:-}}"
export SUPATYPE_PROJECT_REF="${SUPATYPE_PROJECT_REF:-integration-test}"

if [[ -z "$SUPATYPE_SERVICE_ROLE_KEY" ]]; then
  echo "ERROR: SERVICE_ROLE_KEY not set — run supatype dev first or set SUPATYPE_SERVICE_ROLE_KEY"
  exit 1
fi

echo "==> Control-plane tests against $SUPATYPE_URL (project: $SUPATYPE_PROJECT_REF)"

cd "$INTEGRATION_DIR"
pnpm exec node --import tsx/esm --test tests/control-plane.test.ts

echo "==> Control-plane tests passed."
