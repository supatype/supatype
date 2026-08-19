#!/usr/bin/env bash
#
# Compile the standalone CLI for every published target and package it for the CDN.
#
# Usage: build-release-artifacts.sh <version> <output-dir>
#
# Requires a built `dist/` (pnpm --filter @supatype/cli build) and Bun on PATH. Bun cross
# compiles, so one Linux runner produces every target.
#
# Kept as a script rather than inlined in the workflow so it can be run locally: the release
# path had four defects that had never executed, and a workflow-only build cannot be tested
# without cutting a tag.
set -euo pipefail

OUT_DIR="${2:?usage: build-release-artifacts.sh <version> <output-dir>}"

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PKG_VERSION="$(node -p "require('$CLI_DIR/package.json').version")"

# Defaults to the version set-version.mjs already wrote, so the label cannot disagree with the
# version compiled into the binary.
VERSION="${1:-$PKG_VERSION}"

# Publishing v1.2.3 while the binary answers something else is not a cosmetic mismatch:
# self-update compares its own version against cli/latest.json, so a binary that under-reports
# re-downloads itself on every run. Stamping is what set-version.mjs does, and the release
# workflow runs it before this script.
if [ "$VERSION" != "$PKG_VERSION" ]; then
  echo "error: asked to publish v${VERSION}, but packages/cli/package.json says v${PKG_VERSION}." >&2
  echo "       Run 'node scripts/set-version.mjs ${VERSION}' first so the binary reports it." >&2
  exit 1
fi

# Static entry, not bin/supatype.js: see the comment in src/main.ts.
ENTRY="$CLI_DIR/dist/main.js"
if [ ! -f "$ENTRY" ]; then
  echo "error: $ENTRY is missing. Run 'pnpm --filter @supatype/cli build' first." >&2
  exit 1
fi

# name                bun target
ALL_TARGETS=(
  "linux-amd64        bun-linux-x64"
  "linux-arm64        bun-linux-arm64"
  "linux-amd64-musl   bun-linux-x64-musl"
  "linux-arm64-musl   bun-linux-arm64-musl"
  "darwin-amd64       bun-darwin-x64"
  "darwin-arm64       bun-darwin-arm64"
  "windows-amd64      bun-windows-x64"
)

# ONLY=linux-amd64 builds a single target. The round-trip test uses it to exercise the whole
# publish-and-install contract in seconds rather than compiling seven binaries.
TARGETS=()
for entry in "${ALL_TARGETS[@]}"; do
  read -r n _ <<<"$entry"
  if [ -z "${ONLY:-}" ] || [ "$n" = "$ONLY" ]; then TARGETS+=("$entry"); fi
done
if [ ${#TARGETS[@]} -eq 0 ]; then
  echo "error: ONLY='${ONLY:-}' matched no target." >&2
  exit 1
fi

# A leftover archive from a previous run, or from a different version, would otherwise be
# checksummed and published alongside this version's, since the workflow uploads the whole
# directory.
if [ -d "$OUT_DIR" ] && [ -n "$(ls -A "$OUT_DIR" 2>/dev/null)" ]; then
  echo "error: $OUT_DIR is not empty. Remove it first so nothing stale is published." >&2
  exit 1
fi
mkdir -p "$OUT_DIR"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/stage"

echo "==> packaging supatype CLI v${VERSION}"

produced=()
for entry in "${TARGETS[@]}"; do
  read -r name target <<<"$entry"

  # Windows is the only target that needs an .exe suffix and a zip. Everything else is a
  # tarball. Both facts follow from the platform, so neither is a column in the table above.
  case "$name" in
    windows-*) exe="supatype.exe"; archive="supatype-cli-${name}.zip" ;;
    *)         exe="supatype";     archive="supatype-cli-${name}.tar.gz" ;;
  esac

  # The executable inside the archive is always called `supatype`, whatever the archive is
  # named, so install.sh and Homebrew need no per-platform knowledge.
  bun build "$ENTRY" --compile --target="$target" --outfile "$work/stage/$exe" >/dev/null

  case "$archive" in
    *.zip) ( cd "$work/stage" && zip -q "$OUT_DIR/$archive" "$exe" ) ;;
    *)     tar -czf "$OUT_DIR/$archive" -C "$work/stage" "$exe" ;;
  esac
  rm -f "$work/stage/$exe"

  produced+=("$archive")
  printf '    %-22s %s\n' "$name" "$(du -h "$OUT_DIR/$archive" | cut -f1)"
done

# Hashes exactly what this run produced, rather than globbing the directory: publishing a
# checksum for a file this run did not build is the same mistake as a fresh checksum beside a
# stale archive, which is what broke `supatype dev` on macOS after the postgres v17.2.2
# release. Bare names, because that is how install.sh and Homebrew refer to them.
( cd "$OUT_DIR" && sha256sum "${produced[@]}" > checksums.sha256 )

echo "==> checksums.sha256"
sed 's/^/    /' "$OUT_DIR/checksums.sha256"
