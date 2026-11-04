#!/usr/bin/env bash
# Link skills/supatype to .claude/skills/supatype for monorepo Claude Code dev.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/skills/supatype"
DEST="$ROOT/.claude/skills/supatype"
mkdir -p "$ROOT/.claude/skills"
if [[ -e "$DEST" || -L "$DEST" ]]; then
  rm -rf "$DEST"
fi
if command -v cygpath >/dev/null 2>&1; then
  # Git Bash on Windows: ln -s silently copies, which drifts. A junction needs no admin rights.
  cmd //c "mklink /J $(cygpath -w "$DEST") $(cygpath -w "$SRC")" >/dev/null
else
  ln -s "$SRC" "$DEST"
fi
echo "Linked $DEST to $SRC"
