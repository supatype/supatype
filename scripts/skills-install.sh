#!/usr/bin/env bash
# Symlink skills/supatype → .claude/skills/supatype for monorepo Claude Code dev.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/skills/supatype"
DEST="$ROOT/.claude/skills/supatype"
mkdir -p "$ROOT/.claude/skills"
if [[ -e "$DEST" || -L "$DEST" ]]; then
  rm -rf "$DEST"
fi
if command -v cygpath >/dev/null 2>&1; then
  # Git Bash on Windows: use cp when symlinks are unreliable
  cp -r "$SRC" "$DEST"
  echo "Copied $SRC → $DEST"
else
  ln -s "$SRC" "$DEST"
  echo "Linked $SRC → $DEST"
fi
