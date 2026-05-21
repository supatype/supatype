#!/usr/bin/env bash
# test-cdn-server-linux.sh — verify supatype-server linux/amd64 from CDN inside Docker.
#
# Run from Windows via Git Bash or WSL (requires Docker Desktop):
#   ./scripts/test-cdn-server-linux.sh
#   VERSION=1.0.4 ./scripts/test-cdn-server-linux.sh
#   CDN_BASE=https://releases.supatype.com ./scripts/test-cdn-server-linux.sh
#
# Checks:
#   1. Download checksums.sha256 + supatype-server-linux-amd64
#   2. SHA256 matches manifest
#   3. File type: ELF executable (not HTML, not Go c-archive "!<arch>")
#   4. docker run --platform linux/amd64: file(1) + `version` subcommand
#
set -euo pipefail

CDN_BASE="${CDN_BASE:-https://releases.supatype.com}"
DOCKER_IMAGE="${DOCKER_IMAGE:-debian:bookworm-slim}"
WORKDIR="$(mktemp -d 2>/dev/null || mktemp -d -t supatype-server-test)"
BIN_NAME="supatype-server-linux-amd64"
CONTAINER_BIN="/tmp/supatype-server"

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

need_cmd curl
need_cmd docker
need_cmd sha256sum
need_cmd od

if ! docker info >/dev/null 2>&1; then
  die "Docker is not running. Start Docker Desktop and retry."
fi

file_magic() {
  od -An -tx1 -N 4 "$1" | tr -d ' \n'
}

describe_magic() {
  local magic="$1"
  case "$magic" in
    7f454c46) echo "ELF executable" ;;
    213c6172) echo "Unix ar archive (Go c-archive — NOT runnable; release pipeline bug)" ;;
    3c21646f|3c21444f) echo "HTML/text (likely CDN 404 or error page)" ;;
    4d5a9000) echo "PE/Windows (wrong platform for linux test)" ;;
    *) echo "unknown (magic=${magic})" ;;
  esac
}

resolve_version() {
  if [[ -n "${VERSION:-}" ]]; then
    echo "$VERSION"
    return
  fi
  log "Fetching server/latest.json from ${CDN_BASE}"
  local raw
  raw="$(curl -fsSL "${CDN_BASE}/server/latest.json")"
  VERSION="$(printf '%s' "$raw" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [[ -n "$VERSION" ]] || die "Could not parse version from latest.json"
  echo "$VERSION"
}

VERSION="$(resolve_version)"
BASE="${CDN_BASE}/server/v${VERSION}"
log "Testing ${BASE}/${BIN_NAME}"

log "Downloading checksums.sha256"
curl -fsSL "${BASE}/checksums.sha256" -o "${WORKDIR}/checksums.sha256"
cat "${WORKDIR}/checksums.sha256"

log "Downloading ${BIN_NAME}"
curl -fsSL "${BASE}/${BIN_NAME}" -o "${WORKDIR}/${BIN_NAME}"
chmod +x "${WORKDIR}/${BIN_NAME}" 2>/dev/null || true

log "Verifying SHA256"
EXPECTED="$(awk -v f="$BIN_NAME" '$2 == f { print $1; exit }' "${WORKDIR}/checksums.sha256")"
[[ -n "$EXPECTED" ]] || die "No checksum line for ${BIN_NAME} in checksums.sha256"
ACTUAL="$(sha256sum "${WORKDIR}/${BIN_NAME}" | awk '{ print $1 }')"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  die "Checksum mismatch.\n  expected: ${EXPECTED}\n  actual:   ${ACTUAL}"
fi
printf '  SHA256 OK (matches checksums.sha256 on CDN)\n'

MAGIC="$(file_magic "${WORKDIR}/${BIN_NAME}")"
log "File magic: ${MAGIC} — $(describe_magic "$MAGIC")"

if [[ "$MAGIC" != "7f454c46" ]]; then
  if [[ "$MAGIC" == "213c6172" ]]; then
    log "Archive members:"
    if command -v ar >/dev/null 2>&1; then
      ar t "${WORKDIR}/${BIN_NAME}" || true
    else
      docker run --rm -v "${WORKDIR}:/w:ro" "$DOCKER_IMAGE" ar t "/w/${BIN_NAME}" || true
    fi
    die "CDN object is a static library archive (.a), not a Linux ELF binary.
  Integration/CLI cannot execute this (shell reports 'Syntax error').
  Fix: supatype-auth server-release.yml must upload 'go build -o ...' executables, not -buildmode=c-archive.
  Re-tag and re-publish server v${VERSION} after fixing the workflow."
  fi
  die "Not ELF (magic=${MAGIC}). $(describe_magic "$MAGIC")"
fi

log "Running ELF binary in Docker (${DOCKER_IMAGE}, linux/amd64)"
docker run --rm \
  --platform linux/amd64 \
  -v "${WORKDIR}/${BIN_NAME}:${CONTAINER_BIN}:ro" \
  "$DOCKER_IMAGE" \
  bash -ec "
    set -euo pipefail
    apt-get update -qq && apt-get install -y -qq file >/dev/null
    echo '--- file ---'
    file '${CONTAINER_BIN}'
    echo '--- version ---'
    '${CONTAINER_BIN}' version
  "

log "All checks passed: server v${VERSION} linux/amd64 is a runnable ELF on CDN."
