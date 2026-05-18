#!/usr/bin/env bash
# Supatype CLI install (Phase 10.6C5 interim path).
# Until a dedicated CLI binary ships on releases.supatype.com, this script uses npm
# to install the global CLI, which then downloads engine/server/postgres/deno via
# the normal postinstall / supatype update flow.
set -euo pipefail

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm not found. Install Node.js 20+ (https://nodejs.org/) and retry." >&2
  exit 1
fi

echo "Installing @supatype/cli globally via npm..."
npm install -g @supatype/cli
echo ""
echo "Done. Next:"
echo "  supatype init my-app && cd my-app && pnpm install && supatype dev"
