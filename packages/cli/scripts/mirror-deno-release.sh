#!/usr/bin/env bash
# mirror-deno-release.sh — Download official Deno release zips and rename to Supatype CDN layout.
#
# Output binaries (cwd or $OUT_DIR):
#   deno-linux-amd64, deno-linux-arm64, deno-darwin-amd64, deno-darwin-arm64, deno-windows-amd64.exe
#
# Version is read from packages/cli/releases/deno/VERSION (same file as release-pins.ts).

set -euo pipefail

CLI_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION_FILE="${CLI_ROOT}/releases/deno/VERSION"
OUT_DIR="${1:-${CLI_ROOT}/.deno-mirror-staging}"

if [[ ! -f "${VERSION_FILE}" ]]; then
  echo "Missing ${VERSION_FILE}" >&2
  exit 1
fi

VERSION="$(tr -d '[:space:]' < "${VERSION_FILE}")"
if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "Invalid Deno version in ${VERSION_FILE}: ${VERSION}" >&2
  exit 1
fi

TAG="v${VERSION}"
BASE_URL="https://github.com/denoland/deno/releases/download/${TAG}"

mkdir -p "${OUT_DIR}"
cd "${OUT_DIR}"

# supatype_name|upstream_zip|output_suffix (empty or .exe)
PLATFORMS=(
  "linux-amd64|deno-x86_64-unknown-linux-gnu.zip|"
  "linux-arm64|deno-aarch64-unknown-linux-gnu.zip|"
  "darwin-amd64|deno-x86_64-apple-darwin.zip|"
  "darwin-arm64|deno-aarch64-apple-darwin.zip|"
  "windows-amd64|deno-x86_64-pc-windows-msvc.zip|.exe"
)

echo "Mirroring Deno ${TAG} into ${OUT_DIR}"

for entry in "${PLATFORMS[@]}"; do
  IFS='|' read -r name zip suffix <<< "${entry}"
  out_name="deno-${name}${suffix}"
  tmp_zip="$(mktemp "${TMPDIR:-/tmp}/deno-mirror.XXXXXX.zip")"
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/deno-mirror.XXXXXX")"

  echo "  ${zip} -> ${out_name}"
  curl -fsSL "${BASE_URL}/${zip}" -o "${tmp_zip}"
  unzip -qo "${tmp_zip}" -d "${tmp_dir}"

  bin_src=""
  if [[ "${suffix}" == ".exe" ]]; then
    bin_src="$(find "${tmp_dir}" -name 'deno.exe' -type f | head -n 1)"
  else
    bin_src="$(find "${tmp_dir}" -name 'deno' -type f ! -name '*.exe' | head -n 1)"
  fi

  if [[ -z "${bin_src}" || ! -f "${bin_src}" ]]; then
    echo "::error::Could not find deno binary inside ${zip}" >&2
    rm -rf "${tmp_zip}" "${tmp_dir}"
    exit 1
  fi

  cp "${bin_src}" "${out_name}"
  if [[ "${suffix}" != ".exe" ]]; then
    chmod +x "${out_name}"
  fi

  rm -rf "${tmp_zip}" "${tmp_dir}"
done

sha256sum deno-* > checksums.sha256
echo "checksums.sha256:"
cat checksums.sha256
