#!/usr/bin/env bash
# Regenerate every example's generated files with this checkout's CLI.
#
# Not tests/integration: `generate` leaves a project's .supatype state behind, and the integration
# job starts that project's stack from the same folder right after.
#
# Usage:
#   bash scripts/regenerate-examples.sh      (or: pnpm generate:examples)
#
# CI runs this and fails if it changes any committed file, so run it after changing the generator
# or moving the engine pin, and commit the result. It needs Docker up: `generate` runs the engine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/packages/cli/bin/supatype.js"

for dir in "$ROOT"/examples/*/; do
  [[ -f "${dir}supatype.config.ts" ]] || continue
  echo "==> ${dir#"$ROOT/"}"
  (cd "$dir" && node "$CLI" generate)
done
