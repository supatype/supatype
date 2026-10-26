#!/usr/bin/env bash
# Regenerate the generated files of every example, and of the integration test project, with this
# checkout's CLI.
#
# Usage:
#   bash scripts/regenerate-examples.sh      (or: pnpm generate:examples)
#
# CI runs this and fails if it changes any committed file, so run it after changing the generator
# or moving the engine pin, and commit the result. It needs Docker up: `generate` runs the engine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/packages/cli/bin/supatype.js"

for dir in "$ROOT"/examples/*/ "$ROOT"/tests/integration/; do
  [[ -f "${dir}supatype.config.ts" ]] || continue
  echo "==> ${dir#"$ROOT/"}"
  (cd "$dir" && node "$CLI" generate)
done
