#!/usr/bin/env bash
# Supatype CLI installer — curl | bash
#
# Supported: Linux and macOS (darwin) only.
# Windows: use `npm install -g @supatype/cli` — do not promote this script on Windows
# (Git Bash reports MINGW*; native Windows uses supatype-cli-windows-amd64.exe via self-update).
# See plans/ENGINEERING-STATUS.md §6 "Install platform policy".
#
# Usage:
#   curl -fsSL https://releases.supatype.com/install.sh | bash
#
# macOS alternative: Homebrew — https://github.com/supatype/homebrew
#   brew tap supatype/homebrew
#   brew install supatype
#
# Environment overrides:
#   SUPATYPE_VERSION     — install a specific version (default: latest)
#   SUPATYPE_INSTALL_DIR — install directory (default: ~/.supatype/bin)

set -euo pipefail

VERSION="${SUPATYPE_VERSION:-latest}"
INSTALL_DIR="${SUPATYPE_INSTALL_DIR:-$HOME/.supatype/bin}"
# Overridable so the whole path contract can be exercised against a local server. Every
# break this script has had — the manifest name, the arch token, the artefact shape — was a
# disagreement with the publisher that no test could have caught while the host was fixed.
CDN="${SUPATYPE_CDN:-https://releases.supatype.com/cli}"

# ── Detect platform ────────────────────────────────────────────────────────────

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

# amd64, not x86_64: every other artefact we publish is named for Node's `process.arch`
# mapping, and the CLI asks for `amd64` on all platforms. Publishing under the uname
# spelling is what left Intel macOS with a postgres archive no client ever requested.
case "$ARCH" in
  x86_64|amd64)  ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    echo "Error: unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

case "$OS" in
  linux|darwin) ;;
  *)
    echo "Error: unsupported OS: $OS" >&2
    exit 1
    ;;
esac

# ── Resolve "latest" ───────────────────────────────────────────────────────────

# cli/latest.json is the manifest the release workflow writes and `supatype self-update`
# reads. sed rather than jq: this runs on a machine that has nothing installed yet.
if [[ "$VERSION" == "latest" ]]; then
  VERSION="$(curl -fsSL "$CDN/latest.json" |
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [[ -z "$VERSION" ]]; then
    echo "Error: could not resolve latest version from $CDN/latest.json" >&2
    exit 1
  fi
fi

echo "Installing supatype v${VERSION} (${OS}/${ARCH})..."

# ── Download and verify ────────────────────────────────────────────────────────

# The artefact is the executable itself, not an archive — pkg emits one file and that is
# what the CDN carries, so there is nothing to unpack.
BINARY="supatype-cli-${OS}-${ARCH}"
URL="$CDN/v${VERSION}/${BINARY}"
SHA_URL="$CDN/v${VERSION}/checksums.sha256"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

curl -fsSL "$URL" -o "$tmpdir/$BINARY"

# One checksums file covers every platform; take the line for ours. `sha256sum` writes the
# name as `*name` in binary mode, so match both spellings.
expected="$(curl -fsSL "$SHA_URL" |
  awk -v want="$BINARY" '{ sub(/^\*/, "", $2); if ($2 == want) print $1 }')"
if [[ -z "$expected" ]]; then
  echo "Error: no checksum for $BINARY in $SHA_URL" >&2
  exit 1
fi

# sha256sum on Linux, shasum on macOS
if command -v sha256sum &>/dev/null; then
  actual="$(sha256sum "$tmpdir/$BINARY" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmpdir/$BINARY" | awk '{print $1}')"
fi

if [[ "$expected" != "$actual" ]]; then
  echo "Error: checksum mismatch — download may be corrupted." >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  exit 1
fi

# ── Install ────────────────────────────────────────────────────────────────────

mkdir -p "$INSTALL_DIR"
# Move into place only after the checksum passes, so an interrupted run never leaves a
# half-written `supatype` on PATH.
mv "$tmpdir/$BINARY" "$INSTALL_DIR/supatype"
chmod +x "$INSTALL_DIR/supatype"

# ── PATH setup ─────────────────────────────────────────────────────────────────

add_to_path() {
  local rc="$1"
  local marker='.supatype/bin'
  local line='export PATH="$HOME/.supatype/bin:$PATH"'
  if [[ -f "$rc" ]] && ! grep -qF "$marker" "$rc"; then
    printf '\n# Supatype CLI\n%s\n' "$line" >> "$rc"
    echo "  Added PATH entry to $rc"
  fi
}

add_to_path "$HOME/.bashrc"
add_to_path "$HOME/.zshrc"
add_to_path "$HOME/.profile"

# ── Done ───────────────────────────────────────────────────────────────────────

echo ""
echo "supatype v${VERSION} installed to $INSTALL_DIR/supatype"
echo ""
echo "Run the following (or open a new terminal):"
echo '  export PATH="$HOME/.supatype/bin:$PATH"'
echo ""
echo "Then verify with:"
echo "  supatype --version"
