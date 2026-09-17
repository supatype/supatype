#!/usr/bin/env bash
# Phase 1 of the SeaweedFS migration: stand a backend up and drive packages/storage against it.
#
# MinIO's community edition is archived and its image was withdrawn from Docker Hub, so the S3
# backend has to move. Nothing in the repo exercised packages/storage against any backend at all
# before this, so "it works on MinIO" was an assumption, and so is "it will work on SeaweedFS".
# This script is what turns both into measurements.
#
# It runs against either backend, because a compatibility claim needs a control:
#
#   bash tests/integration/scripts/storage-backend-e2e.sh              # SeaweedFS (default)
#   STORAGE_BACKEND=minio bash tests/integration/scripts/storage-backend-e2e.sh
#
# Usage note: run `pnpm build` first. The driver imports the built packages/storage/dist.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$INTEGRATION_DIR/../.." && pwd)"

source "$SCRIPT_DIR/lib/http-wait.sh"

# Git Bash rewrites any argument that looks like a Unix path before the process sees it, so
# `-dir=/data` reaches the container as `C:/Program Files/Git/data`, which then splits on the space
# and the server dies reporting a folder nobody asked for. Prefixed onto the docker commands
# individually rather than exported: exported, it also stops node resolving its own module paths,
# which fails later and somewhere unrelated. No-ops on Linux and macOS.
NO_PATH_CONV="MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL=*"

# Host side of a bind mount still has to be a path the daemon understands, so convert only that
# half. `cygpath -m` gives the forward-slash form, which avoids the backslash-plus-colon parsing
# that `-v` does not survive. Absent everywhere but Git Bash.
host_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

STORAGE_BACKEND="${STORAGE_BACKEND:-seaweedfs}"
S3_PORT="${STORAGE_S3_PORT:-18333}"
CONTAINER="supatype-storage-backend-test"
ACCESS_KEY="supatype"
SECRET_KEY="supatype-secret"
MAX_WAIT="${STORAGE_BACKEND_MAX_WAIT:-90}"

# Pinned by digest, not by tag. A tag we believed immutable is what disappeared from Docker Hub
# and started this whole migration.
SEAWEEDFS_IMAGE="${SEAWEEDFS_IMAGE:-chrislusf/seaweedfs:4.46}"
MINIO_IMAGE="${MINIO_IMAGE:-quay.io/minio/minio:RELEASE.2024-11-07T00-52-20Z@sha256:ac591851803a79aee64bc37f66d77c56b0a4b6e12d9e5356380f4105510f2332}"

WORK_DIR=""
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then rm -rf "$WORK_DIR"; fi
}
trap cleanup EXIT INT TERM

if [[ ! -f "$ROOT_DIR/packages/storage/dist/s3.js" ]]; then
  echo "ERROR: packages/storage is not built, run 'pnpm build' first" >&2
  exit 1
fi

cleanup
WORK_DIR="$(mktemp -d)"

case "$STORAGE_BACKEND" in
  seaweedfs)
    # Identities come from a config file rather than env vars. The anonymous identity is
    # deliberately absent: a bucket is public because of its policy, never because the server is
    # open, and the driver's control assertion is what proves that distinction holds.
    cat > "$WORK_DIR/s3.json" <<JSON
{
  "identities": [
    {
      "name": "supatype",
      "credentials": [{ "accessKey": "$ACCESS_KEY", "secretKey": "$SECRET_KEY" }],
      "actions": ["Admin", "Read", "List", "Tagging", "Write"]
    }
  ]
}
JSON
    # mktemp -d is 0700 and the mount keeps host permissions, so anything in the container that is
    # not this uid cannot traverse it. Readable, not writable.
    chmod 755 "$WORK_DIR"
    chmod 644 "$WORK_DIR/s3.json"
    echo "==> starting SeaweedFS ($SEAWEEDFS_IMAGE) on :$S3_PORT"
    env $NO_PATH_CONV docker run -d --name "$CONTAINER" \
      -p "$S3_PORT:8333" \
      -v "$(host_path "$WORK_DIR/s3.json"):/etc/seaweedfs/s3.json:ro" \
      "$SEAWEEDFS_IMAGE" \
      server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json >/dev/null
    ;;
  minio)
    echo "==> starting MinIO ($MINIO_IMAGE) on :$S3_PORT"
    env $NO_PATH_CONV docker run -d --name "$CONTAINER" \
      -p "$S3_PORT:9000" \
      -e "MINIO_ROOT_USER=$ACCESS_KEY" \
      -e "MINIO_ROOT_PASSWORD=$SECRET_KEY" \
      "$MINIO_IMAGE" \
      server /data >/dev/null
    ;;
  *)
    echo "ERROR: unknown STORAGE_BACKEND '$STORAGE_BACKEND' (expected seaweedfs or minio)" >&2
    exit 1
    ;;
esac

# An unauthenticated request to the service root answers *something* once the listener is up, which
# is all readiness means here. 403 counts: it is the server refusing, which requires a server.
backend_ready() {
  local code
  code="$(http_status "http://127.0.0.1:${S3_PORT}/")"
  [[ "$code" != "000" ]]
}

if ! wait_until "$MAX_WAIT" "the S3 endpoint" backend_ready; then
  echo "  ERROR: $STORAGE_BACKEND did not answer within ${MAX_WAIT}s" >&2
  docker logs "$CONTAINER" 2>&1 | tail -30 || true
  exit 1
fi

echo "==> driving packages/storage"
cd "$INTEGRATION_DIR"
STORAGE_BACKEND_NAME="$STORAGE_BACKEND" \
S3_ENDPOINT="http://127.0.0.1:${S3_PORT}" \
S3_PUBLIC_URL="http://127.0.0.1:${S3_PORT}" \
S3_ACCESS_KEY="$ACCESS_KEY" \
S3_SECRET_KEY="$SECRET_KEY" \
S3_FORCE_PATH_STYLE=true \
JWT_SECRET="integration-secret-at-least-32-characters-long" \
  npx tsx scripts/storage-backend.ts
