#!/usr/bin/env bash
#
# Unpack a published CLI archive, run it, and assert it reports the version it was published as.
#
# Usage: smoke-cli-artifact.sh <archive> <expected-version>
#
# The release cross compiles every target from one Linux runner, so "it compiled" is all we know
# until something executes the result. Three defects reached this path that only a running binary
# could reveal: an entry point that bundled one module and exited 0 in silence, a binary that
# reported 0.0.0, and self-update replacing a path inside the embedded filesystem.
set -euo pipefail

ARCHIVE="${1:?usage: smoke-cli-artifact.sh <archive> <expected-version>}"
EXPECTED="${2:?usage: smoke-cli-artifact.sh <archive> <expected-version>}"

if [ ! -f "$ARCHIVE" ]; then
  echo "error: no such archive: $ARCHIVE" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

case "$ARCHIVE" in
  *.zip)
    # GNU tar cannot read a zip. bsdtar can, and it is what macOS and the Windows runner ship,
    # but Git Bash puts MSYS GNU tar first on PATH, so Windows goes through PowerShell instead.
    case "$(uname -s)" in
      MINGW* | MSYS* | CYGWIN*)
        powershell.exe -NoProfile -Command \
          "Expand-Archive -Path '$(cygpath -w "$ARCHIVE")' -DestinationPath '$(cygpath -w "$work")' -Force"
        ;;
      *)
        tar -xf "$ARCHIVE" -C "$work"
        ;;
    esac
    ;;
  *.tar.gz)
    tar -xzf "$ARCHIVE" -C "$work"
    ;;
  *)
    echo "error: unrecognised archive type: $ARCHIVE" >&2
    exit 1
    ;;
esac

exe="$work/supatype"
if [ -f "$work/supatype.exe" ]; then
  exe="$work/supatype.exe"
fi
if [ ! -f "$exe" ]; then
  echo "error: $ARCHIVE did not contain a supatype executable" >&2
  ls -la "$work" >&2
  exit 1
fi
chmod +x "$exe"

got="$("$exe" --version)"
if [ "$got" != "$EXPECTED" ]; then
  echo "error: $(basename "$ARCHIVE") reports '$got', expected '$EXPECTED'." >&2
  echo "       The version stamped at build time and the version published disagree." >&2
  exit 1
fi
echo "    --version: $got"

# --help exercises command registration. A binary built from the wrong entry point starts, exits
# 0 and prints nothing, which no version check would catch.
help="$("$exe" --help)"
case "$help" in
  *"Usage: supatype"*) : ;;
  *)
    echo "error: --help did not render the command list." >&2
    printf '%s\n' "$help" | head -5 >&2
    exit 1
    ;;
esac
echo "    --help:    $(printf '%s\n' "$help" | sed -n '1p')"
echo "    ok: $(basename "$ARCHIVE")"
