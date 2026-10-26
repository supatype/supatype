#!/usr/bin/env bash
# Builds a genuine tier-2 database for rls-tier2.integration.test.ts: plain postgres:17-alpine (no
# supatype_mask library, so no security labels), with schema.ts pushed by the engine, which therefore
# generates the api views and the can_read_* predicates and gives the API roles nothing on the tables.
#
#   SUPATYPE_CLI="node packages/cli/bin/supatype.js" SUPATYPE_ENGINE=/path/to/engine \
#     bash packages/realtime/tests/fixtures/tier2/make-db.sh [container] [port]
#
# Prints the TIER2_DATABASE_URL to export for the test.
set -euo pipefail

: "${SUPATYPE_CLI:?set SUPATYPE_CLI to the CLI command, e.g. node packages/cli/bin/supatype.js}"
: "${SUPATYPE_ENGINE:?set SUPATYPE_ENGINE to the schema engine binary}"
CONTAINER="${1:-realtime-tier2-pg}"
PORT="${2:-56460}"
HERE=$(cd "$(dirname "$0")" && pwd)
URL="postgresql://supatype_admin:tier2@127.0.0.1:${PORT}/tier2?sslmode=disable"

docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_USER=supatype_admin -e POSTGRES_PASSWORD=tier2 -e POSTGRES_DB=tier2 \
  postgres:17-alpine > /dev/null
timeout 60 bash -c "until docker exec $CONTAINER psql -U supatype_admin -d tier2 -Atc 'select 1' >/dev/null 2>&1; do sleep 1; done"

# What the stack's image provides and a bare Postgres does not; the push refuses without them.
docker exec "$CONTAINER" psql -U supatype_admin -d tier2 -v ON_ERROR_STOP=1 -Atc "
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key)" > /dev/null

PROJECT=$(mktemp -d)
mkdir -p "$PROJECT/schema"
cp "$HERE/schema.ts" "$PROJECT/schema/index.ts"
cat > "$PROJECT/supatype.config.ts" <<CONFIG
import { defineConfig } from "@supatype/cli"

export default defineConfig({
  project: { name: "realtime-tier2" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev", port: 18572 },
  app: { mode: "none" },
  schema: { path: "schema/index.ts", pg_schema: "public" },
  overrides: { engine: "${SUPATYPE_ENGINE}" },
})
CONFIG
(cd "$PROJECT" && $SUPATYPE_CLI push --yes --connection "$URL" > "$PROJECT/push.log" 2>&1) \
  || { tail -20 "$PROJECT/push.log"; exit 1; }

docker exec "$CONTAINER" psql -U supatype_admin -d tier2 -Atc \
  "select 'tier: ' || (capabilities->'fieldMasking'->>'tier') from _supatype.schema_state"
echo "TIER2_DATABASE_URL=$URL"
