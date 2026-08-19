#!/usr/bin/env bash
# Supatype CLI installer (curl | bash)
#
# Supported: Linux and macOS (darwin) only.
# Windows: use `npm install -g @supatype/cli`. Do not promote this script on Windows
# (Git Bash reports MINGW*; native Windows uses supatype-cli-windows-amd64.exe via self-update).
# See plans/ENGINEERING-STATUS.md §6 "Install platform policy".
#
# Usage:
#   curl -fsSL https://releases.supatype.com/install.sh | bash
#
# Environment overrides:
#   SUPATYPE_VERSION     install a specific version (default: latest)
#   SUPATYPE_INSTALL_DIR install directory (default: ~/.supatype/bin)
#   SUPATYPE_CDN         base URL, so the path contract can be tested against a local server

set -euo pipefail

VERSION="${SUPATYPE_VERSION:-latest}"
INSTALL_DIR="${SUPATYPE_INSTALL_DIR:-$HOME/.supatype/bin}"
# Overridable so the whole path contract can be exercised against a local server. Every break
# this script has had (the manifest name, the arch token, the artefact shape) was a
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

# Alpine and other musl distributions need their own build. The glibc binary does not fail
# with a useful message there: the loader reports "not found" for the executable itself, which
# reads as a missing file rather than a missing libc.
LIBC=""
if [[ "$OS" == "linux" ]] && compgen -G '/lib/ld-musl-*.so.1' >/dev/null; then
  LIBC="-musl"
fi

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

echo "Installing supatype v${VERSION} (${OS}/${ARCH}${LIBC})..."

# ── Download and verify ────────────────────────────────────────────────────────

# A gzipped tarball holding a single `supatype` executable. The binary is ~120 MB and
# compresses to roughly a third of that, so the archive is worth the extra step.
TARBALL="supatype-cli-${OS}-${ARCH}${LIBC}.tar.gz"
URL="$CDN/v${VERSION}/${TARBALL}"
SHA_URL="$CDN/v${VERSION}/checksums.sha256"

# Staged inside the install directory, not /tmp. The binary is ~120 MB unpacked, and /tmp is
# tmpfs on a good number of Linux distributions and container images, so staging there would
# hold the whole thing in RAM and turn the final move into a 120 MB copy across filesystems
# rather than a rename.
mkdir -p "$INSTALL_DIR"
tmpdir="$(mktemp -d "${INSTALL_DIR%/}/.supatype-install.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

curl -fsSL "$URL" -o "$tmpdir/$TARBALL"

# One checksums file covers every platform; take the line for ours. `sha256sum` writes the
# name as `*name` in binary mode, so match both spellings.
expected="$(curl -fsSL "$SHA_URL" |
  awk -v want="$TARBALL" '{ sub(/^\*/, "", $2); if ($2 == want) print $1 }')"
if [[ -z "$expected" ]]; then
  echo "Error: no checksum for $TARBALL in $SHA_URL" >&2
  exit 1
fi

# sha256sum on Linux, shasum on macOS
if command -v sha256sum &>/dev/null; then
  actual="$(sha256sum "$tmpdir/$TARBALL" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmpdir/$TARBALL" | awk '{print $1}')"
fi

if [[ "$expected" != "$actual" ]]; then
  echo "Error: checksum mismatch, the download may be corrupted." >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  exit 1
fi

# ── Install ────────────────────────────────────────────────────────────────────

# Unpack beside the archive, then move into place only after the checksum has passed and the
# extraction has succeeded, so an interrupted run never leaves a half-written `supatype` on
# PATH. Same filesystem as the staging directory, so this is a rename. The archive always
# holds one file called `supatype`, whatever the archive is named.
tar -xzf "$tmpdir/$TARBALL" -C "$tmpdir"
if [[ ! -f "$tmpdir/supatype" ]]; then
  echo "Error: $TARBALL did not contain a supatype executable." >&2
  exit 1
fi
mv "$tmpdir/supatype" "$INSTALL_DIR/supatype"
chmod +x "$INSTALL_DIR/supatype"

# Run what we just installed. A binary that cannot start should say so here, not the first
# time someone tries to use it. On musl the failure is twenty lines of
# "Error relocating ...: symbol not found", because the build links libstdc++ and libgcc
# dynamically and Alpine ships neither by default.
if ! "$INSTALL_DIR/supatype" --version >/dev/null 2>&1; then
  echo "Error: installed supatype cannot run on this system." >&2
  if [[ -n "$LIBC" ]]; then
    echo "  The musl build needs the C++ runtime. On Alpine:" >&2
    echo "    apk add libstdc++ libgcc" >&2
  else
    echo "  Diagnose with: $INSTALL_DIR/supatype --version" >&2
  fi
  exit 1
fi

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
