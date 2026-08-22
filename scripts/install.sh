#!/usr/bin/env bash
# Supatype CLI installer (curl | bash)
#
# Supported: Linux and macOS (darwin) only.
# Windows: use `npm install -g @supatype/cli`. Do not promote this script on Windows
# (Git Bash reports MINGW*; native Windows uses supatype-cli-windows-amd64.exe via self-update).
# See plans/ENGINEERING-STATUS.md §6 "Install platform policy".
#
# Usage:
#   curl -fsSL https://supatype.com/install.sh | bash
#
# That URL redirects to this file on GitHub, and it is deliberately not served from the release
# bucket. The script carries the public key the archives are verified against, so putting it
# beside the archives would place the key and the thing it checks under one authority: whoever
# could replace an archive could replace the key, and verification would still pass. GitHub and
# the CDN are two origins, which is what makes the signature check below worth performing.
#
# Environment overrides:
#   SUPATYPE_VERSION     install a specific version (default: latest)
#   SUPATYPE_INSTALL_DIR install directory (default: ~/.supatype/bin)
#   SUPATYPE_CDN         base URL, so the path contract can be tested against a local server
#   SUPATYPE_RELEASE_PUBLIC_KEY  override the embedded key (testing, or a private mirror)

set -euo pipefail

VERSION="${SUPATYPE_VERSION:-latest}"
INSTALL_DIR="${SUPATYPE_INSTALL_DIR:-$HOME/.supatype/bin}"
# Overridable so the whole path contract can be exercised against a local server. Every break
# this script has had (the manifest name, the arch token, the artefact shape) was a
# disagreement with the publisher that no test could have caught while the host was fixed.
CDN="${SUPATYPE_CDN:-https://releases.supatype.com/cli}"

# The minisign public key releases are signed with, in the same form `minisign -p` prints: the
# base64 payload line, without the comment line above it. Committed rather than injected at
# release time, because a key the CDN could rewrite would verify nothing.
#
# Key ID DE133E99689AE71D. Confirmed against the published engine, server, deno and postgres
# manifests on the CDN, with minisign itself and with the verification below.
RELEASE_PUBLIC_KEY="${SUPATYPE_RELEASE_PUBLIC_KEY:-RWQd55pomT4T3t+5FLZZ6+h0DoHrtiuU9RBUHHm9BcFHeGRvW7BXxBCr}"

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


# ── Signature verification ─────────────────────────────────────────────────────

# The checksums file is signed; verifying it means the archive list came from us, where the
# SHA256 alone only means the bytes arrived intact. Someone able to replace both the archive
# and the manifest passes the checksum and fails this.
#
# openssl rather than minisign: a machine running this script has nothing installed yet, and
# openssl is present on virtually every Linux box. Downloading minisign to check our own
# signature would add a third-party binary to the install path without raising the ceiling,
# since the pin would live in this same script.
#
# macOS ships LibreSSL as /usr/bin/openssl, which has neither `pkeyutl -rawin` nor blake2b512,
# so this degrades to checksum-only there rather than failing.
openssl_can_verify() {
  command -v openssl >/dev/null 2>&1 || return 1
  openssl dgst -blake2b512 </dev/null >/dev/null 2>&1 || return 1
  openssl pkeyutl -help 2>&1 | grep -q -- "-rawin" || return 1
}

# minisign formats, as implemented in packages/cli/src/binary-cache.ts:
#   public key: [2 algo]["Ed"] [8 key id] [32 ed25519 key]
#   signature:  [2 algo]["ED" prehashed | "Ed" legacy] [8 key id] [64 signature]
verify_minisign() {
  local file="$1" sigfile="$2" pubkey="$3" work="$4"

  printf '%s' "$pubkey" | openssl base64 -d -A > "$work/pk.bin" 2>/dev/null || return 1
  sed -n '2p' "$sigfile" | tr -d '
' | openssl base64 -d -A > "$work/sig.bin" 2>/dev/null || return 1

  local pk_id sig_id algo
  pk_id="$(dd if="$work/pk.bin" bs=1 skip=2 count=8 2>/dev/null | od -An -tx1 | tr -d ' 
')"
  sig_id="$(dd if="$work/sig.bin" bs=1 skip=2 count=8 2>/dev/null | od -An -tx1 | tr -d ' 
')"
  if [[ "$pk_id" != "$sig_id" ]]; then
    echo "Error: the signature was produced with a different key than the one in this script." >&2
    return 1
  fi

  # Wrap the raw 32 bytes in the fixed SubjectPublicKeyInfo prefix for id-Ed25519, which is
  # what openssl will load. printf rather than xxd: xxd ships with vim on some distributions.
  printf '%s' 'MCowBQYDK2VwAyEA' | openssl base64 -d -A > "$work/pk.der"
  dd if="$work/pk.bin" bs=1 skip=10 count=32 2>/dev/null >> "$work/pk.der"
  dd if="$work/sig.bin" bs=1 skip=10 count=64 2>/dev/null > "$work/sig.raw"

  algo="$(dd if="$work/sig.bin" bs=1 count=2 2>/dev/null)"
  case "$algo" in
    ED) openssl dgst -blake2b512 -binary "$file" > "$work/msg" ;;
    Ed) cp "$file" "$work/msg" ;;
    *)  echo "Error: unsupported minisign algorithm: $algo" >&2; return 1 ;;
  esac

  openssl pkeyutl -verify -pubin -inkey "$work/pk.der" -keyform DER     -rawin -in "$work/msg" -sigfile "$work/sig.raw" >/dev/null 2>&1
}

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

# The manifest is fetched to a file rather than a variable, because the signature is over the
# bytes as published: reformatting it through a shell variable would not verify.
curl -fsSL "$SHA_URL" -o "$tmpdir/checksums.sha256"

if [[ -z "$RELEASE_PUBLIC_KEY" ]]; then
  echo "  Note: no release public key is embedded in this installer, so the download is" >&2
  echo "        checked against its SHA256 only, not verified as coming from us." >&2
elif ! command -v openssl >/dev/null 2>&1; then
  echo "  Note: openssl is not installed, so the download is checked against its SHA256 only," >&2
  echo "        not verified as coming from us. Install openssl and re-run to verify it." >&2
elif ! openssl_can_verify; then
  echo "  Note: this openssl cannot verify ed25519 signatures (macOS ships LibreSSL, which has" >&2
  echo "        neither pkeyutl -rawin nor blake2b512), so the SHA256 is checked but the" >&2
  echo "        signature is not. For a verified install use: npm install -g @supatype/cli" >&2
else
  if ! curl -fsSL "${SHA_URL}.minisig" -o "$tmpdir/checksums.sha256.minisig"; then
    echo "Error: could not fetch ${SHA_URL}.minisig." >&2
    echo "       Every release signs its manifest, so a missing signature means the release is" >&2
    echo "       incomplete or the download was tampered with. Refusing to continue." >&2
    exit 1
  fi
  if ! verify_minisign "$tmpdir/checksums.sha256" "$tmpdir/checksums.sha256.minisig"         "$RELEASE_PUBLIC_KEY" "$tmpdir"; then
    echo "Error: the release manifest failed signature verification. Refusing to continue." >&2
    exit 1
  fi
  echo "  Signature verified."
fi

# One checksums file covers every platform; take the line for ours. `sha256sum` writes the
# name as `*name` in binary mode, so match both spellings.
expected="$(awk -v want="$TARBALL" '{ sub(/^\*/, "", $2); if ($2 == want) print $1 }'   "$tmpdir/checksums.sha256")"
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
