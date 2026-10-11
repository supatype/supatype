#!/usr/bin/env bash
# The engine's own test suites, against the train's Postgres image.
#
# The engine CI runs these against the published supatype/postgres:17-latest. The train runs them
# against the image built from the candidate supatype-postgres commit, so the engine and the
# database it ships with are tested together. SUPATYPE_FORCE_INTEGRATION_TESTS turns a test that
# cannot reach the database into a failure instead of an early return.
#
# Uses the host's cargo when there is one (CI), and the rust image otherwise (the local runner).
#
# Environment:
#   TRAIN_ENGINE_DIR   the candidate supatype-schema-engine checkout (required)
#   TRAIN_POSTGRES_IMAGE  default the train's postgres image (supatype/postgres:$TRAIN_TAG)
#   TRAIN_ENGINE_PG_PORT  default 55442
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ENGINE_DIR="${TRAIN_ENGINE_DIR:?TRAIN_ENGINE_DIR must name the engine checkout}"
IMAGE="${TRAIN_POSTGRES_IMAGE:-$(train_image postgres)}"
PORT="${TRAIN_ENGINE_PG_PORT:-55442}"
CONTAINER="train-engine-integration-pg"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

cleanup
docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_USER=supatype_admin -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres "$IMAGE" >/dev/null

# Over TCP: the entrypoint's bootstrap server listens on the socket only, so only a TCP answer
# means the bootstrap migrations have finished.
deadline=$((SECONDS + 180))
until docker exec "$CONTAINER" pg_isready -h 127.0.0.1 -U supatype_admin -q 2>/dev/null; do
  (( SECONDS < deadline )) || { docker logs "$CONTAINER" | tail -30; echo "ERROR: Postgres never came up" >&2; exit 1; }
  sleep 2
done

export DATABASE_URL="postgres://supatype_admin:postgres@127.0.0.1:${PORT}/postgres"
export SUPATYPE_FORCE_INTEGRATION_TESTS=1

if command -v cargo >/dev/null 2>&1; then
  (cd "$ENGINE_DIR" && cargo test --tests)
else
  docker run --rm --network host -e DATABASE_URL -e SUPATYPE_FORCE_INTEGRATION_TESTS \
    -v "$ENGINE_DIR:/src" -w /src rust:1-bookworm cargo test --tests
fi
