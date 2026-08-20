#!/usr/bin/env bash
#
# Publish-and-install round trip for the standalone CLI, without cutting a tag.
#
# Builds the host target with the same script the release workflow calls, serves the result as
# the CDN layout, installs it with scripts/install.sh, and runs what was installed.
#
# This exists because every break in this path has been the publisher and a consumer
# disagreeing about names, and nothing could catch that: the two only met on a real tag.
# It has drifted on the manifest name (version.txt against latest.json), the arch token
# (x86_64 against amd64), the artefact shape (bare executable against tarball), and the
# compile entry (dist/cli.js, which only exports run()).
#
# Requires: bun, tar, curl, python3. Skips with a clear message if bun is missing.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT="${SUPATYPE_ROUNDTRIP_PORT:-8749}"
VERSION="0.0.0-roundtrip"

if ! command -v bun >/dev/null 2>&1; then
  echo "SKIP: bun is not installed, so the standalone artefacts cannot be built."
  echo "      Install from https://bun.sh, or run this in CI where setup-bun provides it."
  exit 0
fi

case "$(uname -s | tr '[:upper:]' '[:lower:]')" in
  linux)  os=linux ;;
  darwin) os=darwin ;;
  *)
    echo "SKIP: install.sh supports linux and darwin only; this is $(uname -s)."
    exit 0
    ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "SKIP: unsupported architecture $(uname -m)."; exit 0 ;;
esac
libc=""
if [ "$os" = linux ] && compgen -G '/lib/ld-musl-*.so.1' >/dev/null; then libc="-musl"; fi

# Stamping rewrites every package.json and the embedded version constant, exactly as the
# release workflow does, so the test refuses to run over uncommitted changes to those files
# rather than restoring over the top of them. A fresh CI checkout is always clean.
STAMPED_PATHS=(packages/cli/src/cli-version-embedded.ts packages/*/package.json)
if [ -n "$(cd "$ROOT_DIR" && git status --porcelain -- "${STAMPED_PATHS[@]}" 2>/dev/null)" ]; then
  echo "SKIP: uncommitted changes in package.json or cli-version-embedded.ts."
  echo "      This test stamps a version into them and restores it afterwards."
  exit 0
fi

work="$(mktemp -d)"
server_pid=""
cleanup() {
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  ( cd "$ROOT_DIR" && git checkout -- "${STAMPED_PATHS[@]}" 2>/dev/null ) || true
  rm -rf "$work"
}
trap cleanup EXIT

# The version has to be in the source before it is compiled: the binary cannot read a
# package.json at runtime, which is why publishing a label alone would report 0.0.0.
echo "==> stamping v$VERSION, as the release workflow does"
( cd "$ROOT_DIR" && node scripts/set-version.mjs "$VERSION" >/dev/null )

echo "==> building ${os}-${arch}${libc} with the release script"
( cd "$ROOT_DIR" && pnpm --filter @supatype/cli build >/dev/null )
mkdir -p "$work/cdn/cli/v$VERSION"
ONLY="${os}-${arch}${libc}" bash "$ROOT_DIR/packages/cli/scripts/build-release-artifacts.sh" \
  "$VERSION" "$work/cdn/cli/v$VERSION" | sed 's/^/    /'

# latest.json, written the way the workflow writes it, so version resolution is covered too.
printf '{"version":"%s","date":"1970-01-01"}\n' "$VERSION" > "$work/cdn/cli/latest.json"

echo "==> serving the layout on 127.0.0.1:$PORT"
python3 -m http.server "$PORT" --directory "$work/cdn" --bind 127.0.0.1 >/dev/null 2>&1 &
server_pid=$!
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/cli/latest.json" >/dev/null 2>&1 && break
  sleep 0.2
done

echo "==> installing with scripts/install.sh"
SUPATYPE_CDN="http://127.0.0.1:$PORT/cli" \
SUPATYPE_INSTALL_DIR="$work/bin" \
  bash "$ROOT_DIR/scripts/install.sh" | sed 's/^/    /'

echo "==> the installed binary reports the published version"
got="$("$work/bin/supatype" --version)"
if [ "$got" != "$VERSION" ]; then
  echo "FAIL: installed binary reports '$got', expected '$VERSION'." >&2
  echo "      The version stamped at build time and the one published disagree." >&2
  exit 1
fi
echo "    $got"

archive="$work/cdn/cli/v$VERSION/supatype-cli-${os}-${arch}${libc}.tar.gz"

# self-update verifies the signed manifest, which install.sh cannot: signature checking needs
# minisign or an ed25519 implementation, and install.sh runs before anything is on the machine.
# So the shell installer is checksum-only by design and this is where signing is proven.
if command -v minisign >/dev/null 2>&1; then
  echo "==> signing the manifest with a throwaway key, then updating through it"
  minisign -G -W -p "$work/key.pub" -s "$work/key.sec" >/dev/null 2>&1
  ( cd "$work/cdn/cli/v$VERSION" \
      && minisign -S -s "$work/key.sec" -m checksums.sha256 -t "roundtrip" >/dev/null 2>&1 )

  update_env=(
    "SUPATYPE_CDN_BASE=http://127.0.0.1:$PORT"
    "SUPATYPE_RELEASE_PUBLIC_KEY=$(tail -1 "$work/key.pub")"
  )

  # --force, because the installed binary is already the version latest.json advertises; the
  # point here is to exercise download, verification and replacement.
  if ! env "${update_env[@]}" "$work/bin/supatype" self-update --force >"$work/update.log" 2>&1; then
    echo "FAIL: self-update rejected a correctly signed manifest." >&2
    sed 's/^/      /' "$work/update.log" >&2
    exit 1
  fi
  grep -iE "updated to" "$work/update.log" | head -1 | sed 's/^/    /'

  echo "==> a manifest signed by the wrong key is refused"
  minisign -G -W -p "$work/other.pub" -s "$work/other.sec" >/dev/null 2>&1
  ( cd "$work/cdn/cli/v$VERSION" \
      && minisign -S -s "$work/other.sec" -m checksums.sha256 -t "wrong" >/dev/null 2>&1 )
  rm -rf "$HOME/.supatype/cache/cli/$VERSION"
  if env "${update_env[@]}" "$work/bin/supatype" self-update --force >"$work/badsig.log" 2>&1; then
    echo "FAIL: self-update accepted a manifest signed by an untrusted key." >&2
    exit 1
  fi
  # Assert why it failed. Accepting any non-zero exit would pass even if self-update were
  # broken for an unrelated reason, which is how the tampered-archive check first passed
  # against an archive the installer never downloads.
  if ! grep -qiE "key ID mismatch|signature" "$work/badsig.log"; then
    echo "FAIL: self-update failed, but not because of the signature:" >&2
    sed 's/^/      /' "$work/badsig.log" >&2
    exit 1
  fi
  grep -oiE "Minisign key ID mismatch[^.]*" "$work/badsig.log" | head -1 | sed 's/^/    refused: /'

  # Restore the good signature so the checksum case below fails for its own reason.
  ( cd "$work/cdn/cli/v$VERSION" \
      && minisign -S -s "$work/key.sec" -m checksums.sha256 -t "roundtrip" >/dev/null 2>&1 )
else
  echo "==> SKIP signature checks: minisign is not installed"
fi

echo "==> a modified archive is refused"
printf 'tampered' >> "$archive"
if SUPATYPE_CDN="http://127.0.0.1:$PORT/cli" SUPATYPE_INSTALL_DIR="$work/bin2" \
     bash "$ROOT_DIR/scripts/install.sh" >"$work/tamper.log" 2>&1; then
  echo "FAIL: install accepted an archive that does not match its checksum." >&2
  exit 1
fi
grep -i "checksum mismatch" "$work/tamper.log" | head -1 | sed 's/^/    /'

echo "PASS: publish and install agree end to end"
