#!/usr/bin/env bash
# Put the train's own suites into the candidate supatype checkout.
#
# The masking matrix and the positioning checks live with the train (this checkout). The CLI and
# the workspace packages they drive must be the candidate's, so the suites are copied into the
# candidate tree and run there, resolving @supatype/* from the candidate's workspace. When the
# candidate already carries them (once this lands on main) the copy changes nothing.
#
# Usage: bash scripts/release-train/overlay.sh <harness-root> <candidate-supatype-root>
set -euo pipefail

HARNESS="${1:?harness root}"
CANDIDATE="${2:?candidate supatype root}"

copy_tree() {
  local rel="$1"
  rm -rf "${CANDIDATE:?}/$rel"
  mkdir -p "$(dirname "$CANDIDATE/$rel")"
  cp -R "$HARNESS/$rel" "$CANDIDATE/$rel"
  # Whatever an earlier local run left behind is not part of the suite.
  rm -rf "$CANDIDATE/$rel/.state" "$CANDIDATE/$rel/test-results" "$CANDIDATE/$rel"/*report*.json
  rm -rf "$CANDIDATE/$rel/project/.env" "$CANDIDATE/$rel/project/.supatype" \
    "$CANDIDATE/$rel/project/supatype" "$CANDIDATE/$rel/project/types" "$CANDIDATE/$rel/project"/*.log
}

copy_tree tests/e2e/masking
copy_tree tests/e2e/positioning
for f in tests/integration/scripts/masking-e2e.sh tests/integration/scripts/positioning-e2e.sh; do
  cp "$HARNESS/$f" "$CANDIDATE/$f"
done

# The suites import the client, the CLI's config helper and the schema types from the workspace.
node -e '
  const fs = require("fs")
  const path = process.argv[1]
  const pkg = JSON.parse(fs.readFileSync(path, "utf8"))
  pkg.devDependencies = pkg.devDependencies ?? {}
  for (const dep of ["@supatype/cli", "@supatype/client", "@supatype/types"]) pkg.devDependencies[dep] = "workspace:*"
  pkg.scripts = { ...pkg.scripts, "e2e:masking": "playwright test -c masking/playwright.config.ts" }
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n")
' "$CANDIDATE/tests/e2e/package.json"

(cd "$CANDIDATE" && pnpm install --no-frozen-lockfile --filter supatype-e2e >/dev/null)
echo "overlaid the masking and positioning suites onto $CANDIDATE"
