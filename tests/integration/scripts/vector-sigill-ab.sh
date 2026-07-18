#!/usr/bin/env bash
# A/B probe: Hub postgres vs a locally built image for pgvector SIGILL.
#
# Arm A (Hub) must show signal 4 / Illegal instruction.
# Arm B (built with OPTFLAGS="") must run vector DDL + insert successfully.
#
# Usage:
#   bash tests/integration/scripts/vector-sigill-ab.sh
# Env:
#   HUB_IMAGE   (default: supatype/postgres:latest)
#   FIX_IMAGE   (default: supatype/postgres:optflags-test)
#   POSTGRES_SRC (default: ../postgres-src or ../supatype-postgres)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

HUB_IMAGE="${HUB_IMAGE:-supatype/postgres:latest}"
FIX_IMAGE="${FIX_IMAGE:-supatype/postgres:optflags-test}"

resolve_postgres_src() {
  if [[ -n "${POSTGRES_SRC:-}" && -f "${POSTGRES_SRC}/Dockerfile" ]]; then
    echo "$POSTGRES_SRC"
    return
  fi
  for cand in \
    "$ROOT_DIR/../postgres-src" \
    "$ROOT_DIR/postgres-src" \
    "$ROOT_DIR/../supatype-postgres" \
    "$ROOT_DIR/supatype-postgres"; do
    if [[ -f "$cand/Dockerfile" ]]; then
      echo "$cand"
      return
    fi
  done
  return 1
}

wait_ready() {
  local name="$1"
  # pg_isready can pass during initdb before the role password is usable.
  for _ in $(seq 1 120); do
    if docker exec -e PGPASSWORD=postgres "$name" \
      psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-supatype_admin}" -d "${POSTGRES_DB:-supatype}" \
      -c 'SELECT 1' >/dev/null 2>&1; then
      sleep 2
      if docker exec -e PGPASSWORD=postgres "$name" \
        psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-supatype_admin}" -d "${POSTGRES_DB:-supatype}" \
        -c 'SELECT 1' >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "ERROR: $name did not become ready" >&2
  docker logs "$name" 2>&1 | tail -n 80 >&2 || true
  return 1
}

# Returns: 0=ok, 2=sigill, 1=other failure. Prints classification on stdout.
run_vector_probe() {
  local image="$1"
  local name="$2"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" \
    -e POSTGRES_USER=supatype_admin \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=supatype \
    "$image" >/dev/null

  wait_ready "$name"

  set +e
  docker exec -e PGPASSWORD=postgres -i "$name" \
    psql -v ON_ERROR_STOP=1 -U supatype_admin -d supatype <<'SQL' >/tmp/vector-probe-out.txt 2>&1
CREATE EXTENSION IF NOT EXISTS vector;
DROP TABLE IF EXISTS vector_sigill_probe;
CREATE TABLE vector_sigill_probe (
  id bigserial PRIMARY KEY,
  embedding vector(1536)
);
INSERT INTO vector_sigill_probe (embedding)
  VALUES (array_fill(0.1::real, ARRAY[1536])::vector);
SELECT embedding <-> array_fill(0.1::real, ARRAY[1536])::vector AS dist
  FROM vector_sigill_probe;
SQL
  local rc=$?
  set -e

  local logs
  logs="$(docker logs "$name" 2>&1 || true)"
  docker rm -f "$name" >/dev/null 2>&1 || true

  if echo "$logs" | grep -q 'signal 4: Illegal instruction'; then
    echo "SIGILL"
    echo "$logs" | grep -E 'signal 4|Illegal instruction|DETAIL:' | tail -n 20 >&2 || true
    return 2
  fi
  if [[ "$rc" -ne 0 ]]; then
    echo "SQL_FAIL"
    cat /tmp/vector-probe-out.txt >&2 || true
    echo "$logs" | tail -n 40 >&2 || true
    return 1
  fi
  echo "OK"
  return 0
}

echo "==> Arm A: Hub image ($HUB_IMAGE)"
docker pull "$HUB_IMAGE"
set +e
hub_class="$(run_vector_probe "$HUB_IMAGE" "pg-sigill-hub")"
hub_rc=$?
set -e
echo "  Arm A result: $hub_class (rc=$hub_rc)"
if [[ "$hub_rc" -ne 2 ]]; then
  echo "ERROR: Arm A expected SIGILL (signal 4) on this runner; got $hub_class" >&2
  exit 1
fi
echo "  Arm A confirmed SIGILL on Hub image."

PG_SRC="$(resolve_postgres_src)" || {
  echo "ERROR: postgres Dockerfile source not found (set POSTGRES_SRC)" >&2
  exit 1
}
echo "==> Building Arm B from $PG_SRC → $FIX_IMAGE"
docker build -t "$FIX_IMAGE" "$PG_SRC"

echo "==> Arm B: fixed image ($FIX_IMAGE)"
set +e
fix_class="$(run_vector_probe "$FIX_IMAGE" "pg-sigill-fix")"
fix_rc=$?
set -e
echo "  Arm B result: $fix_class (rc=$fix_rc)"
if [[ "$fix_rc" -ne 0 ]]; then
  echo "ERROR: Arm B expected OK; got $fix_class" >&2
  exit 1
fi

# Binary check: fixed .so should not contain AVX-512 zmm opcodes.
echo "==> Checking vector.so for AVX-512 (zmm) opcodes"
docker create --name pg-sigill-extract "$FIX_IMAGE" >/dev/null
docker cp pg-sigill-extract:/usr/lib/postgresql/17/lib/vector.so /tmp/vector-fix.so
docker rm pg-sigill-extract >/dev/null
zmm_count="$(objdump -d /tmp/vector-fix.so | grep -c 'zmm' || true)"
echo "  zmm instruction matches in fixed vector.so: $zmm_count"
if [[ "$zmm_count" -gt 0 ]]; then
  echo "ERROR: fixed vector.so still contains AVX-512 (zmm) opcodes" >&2
  exit 1
fi

echo "==> A/B passed: Hub SIGILL + fixed image OK + no zmm in vector.so"
