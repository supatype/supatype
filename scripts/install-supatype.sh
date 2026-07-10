#!/usr/bin/env bash
# Supatype CLI install — downloads standalone binary from releases.supatype.com
set -euo pipefail

CDN_BASE="${SUPATYPE_CDN_BASE:-https://releases.supatype.com}"
INSTALL_DIR="${SUPATYPE_INSTALL_DIR:-${HOME}/.local/bin}"
VERSION="${SUPATYPE_VERSION:-}"

detect_platform() {
  local os arch
  case "$(uname -s)" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *) echo "error: unsupported OS $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "error: unsupported arch $(uname -m)" >&2; exit 1 ;;
  esac
  echo "${os}-${arch}"
}

main() {
  if ! command -v curl >/dev/null 2>&1; then
    echo "error: curl not found" >&2
    exit 1
  fi

  local platform os arch
  platform="$(detect_platform)"
  os="${platform%-*}"
  arch="${platform#*-}"

  if [[ -z "${VERSION}" ]]; then
    VERSION="$(curl -fsSL "${CDN_BASE}/cli/latest.json" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  fi
  if [[ -z "${VERSION}" ]]; then
    echo "error: could not resolve CLI version from ${CDN_BASE}/cli/latest.json" >&2
    exit 1
  fi

  mkdir -p "${INSTALL_DIR}"
  local dest="${INSTALL_DIR}/supatype"
  local url="${CDN_BASE}/cli/v${VERSION}/supatype-cli-${os}-${arch}"
  echo "Installing supatype CLI v${VERSION} (${platform}) to ${dest}..."
  curl -fsSL "${url}" -o "${dest}"
  chmod +x "${dest}"

  echo ""
  echo "Done. Ensure ${INSTALL_DIR} is on your PATH, then:"
  echo "  supatype init my-app && cd my-app && pnpm install && supatype dev"
}

main "$@"
