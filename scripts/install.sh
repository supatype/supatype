#!/usr/bin/env bash
# Supatype CLI installer — curl | bash
#
# Usage:
#   curl -fsSL https://releases.supatype.com/install.sh | bash
#
# Environment overrides:
#   SUPATYPE_VERSION     — install a specific version (default: latest)
#   SUPATYPE_INSTALL_DIR — install directory (default: ~/.supatype/bin)

set -euo pipefail

VERSION="${SUPATYPE_VERSION:-latest}"
INSTALL_DIR="${SUPATYPE_INSTALL_DIR:-$HOME/.supatype/bin}"
CDN="https://releases.supatype.com/cli"

# ── Detect platform ────────────────────────────────────────────────────────────

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64)        ARCH="x86_64" ;;
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

if [[ "$VERSION" == "latest" ]]; then
  VERSION="$(curl -fsSL "$CDN/latest/version.txt")"
  if [[ -z "$VERSION" ]]; then
    echo "Error: could not resolve latest version from $CDN/latest/version.txt" >&2
    exit 1
  fi
fi

echo "Installing supatype v${VERSION} (${OS}/${ARCH})..."

# ── Download and verify ────────────────────────────────────────────────────────

TARBALL="supatype-cli-${OS}-${ARCH}.tar.gz"
URL="$CDN/v${VERSION}/${TARBALL}"
SHA_URL="${URL}.sha256"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

curl -fsSL "$URL" -o "$tmpdir/$TARBALL"

expected="$(curl -fsSL "$SHA_URL" | awk '{print $1}')"
if [[ -z "$expected" ]]; then
  echo "Error: could not fetch checksum from $SHA_URL" >&2
  exit 1
fi

# sha256sum on Linux, shasum on macOS
if command -v sha256sum &>/dev/null; then
  actual="$(sha256sum "$tmpdir/$TARBALL" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmpdir/$TARBALL" | awk '{print $1}')"
fi

if [[ "$expected" != "$actual" ]]; then
  echo "Error: checksum mismatch — download may be corrupted." >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  exit 1
fi

# ── Install ────────────────────────────────────────────────────────────────────

mkdir -p "$INSTALL_DIR"
tar -xzf "$tmpdir/$TARBALL" -C "$INSTALL_DIR"
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
