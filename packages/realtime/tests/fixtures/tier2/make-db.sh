#!/usr/bin/env bash
# Builds a database the engine itself pushed, for the integration suites that need the engine's own
# predicates, labels and recorded state rather than hand-written imitations of them.
#
# Tier 2 (the default) is what rls-tier2.integration.test.ts needs: plain postgres:17-alpine (no
# supatype_mask library, so no security labels), with schema.ts pushed by the engine, which therefore
# generates the api views and the can_read_* predicates and gives the API roles nothing on the tables.
# Tier 1 is the same schema on an image that has supatype_mask (POSTGRES_IMAGE, default
# supatype/postgres:latest), with the extension created first so the engine labels the columns.
#
#   SUPATYPE_CLI="node packages/cli/bin/supatype.js" SUPATYPE_ENGINE=/path/to/engine \
#     bash packages/realtime/tests/fixtures/tier2/make-db.sh [container] [port] [tier]
#
# Prints the TIER<n>_DATABASE_URL to export for the tests.
set -euo pipefail

: "${SUPATYPE_CLI:?set SUPATYPE_CLI to the CLI command, e.g. node packages/cli/bin/supatype.js}"
: "${SUPATYPE_ENGINE:?set SUPATYPE_ENGINE to the schema engine binary}"
CONTAINER="${1:-realtime-tier2-pg}"
PORT="${2:-56460}"
TIER="${3:-2}"
HERE=$(cd "$(dirname "$0")" && pwd)
URL="postgresql://supatype_admin:tier2@127.0.0.1:${PORT}/tier2?sslmode=disable"

case "$TIER" in
  1) IMAGE="${POSTGRES_IMAGE:-supatype/postgres:latest}" ;;
  2) IMAGE="postgres:17-alpine" ;;
  *) echo "tier must be 1 or 2, got '$TIER'" >&2; exit 2 ;;
esac

docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_USER=supatype_admin -e POSTGRES_PASSWORD=tier2 -e POSTGRES_DB=tier2 \
  "$IMAGE" > /dev/null
# Every psql goes over TCP with the password: the supatype/postgres image does not trust socket
# logins, and the server initdb starts briefly on the socket alone is not the one to wait for.
psql_db() { docker exec -e PGPASSWORD=tier2 "$CONTAINER" psql -h 127.0.0.1 -U supatype_admin -d tier2 "$@"; }
until_ready=0
until psql_db -Atc 'select 1' >/dev/null 2>&1; do
  until_ready=$((until_ready + 1)); [ "$until_ready" -lt 60 ] || { echo "postgres did not start" >&2; exit 1; }; sleep 1
done

# What the stack's image provides and a bare Postgres does not; the push refuses without them. Each
# is created only if missing, because the supatype/postgres image already has some of them.
psql_db -v ON_ERROR_STOP=1 -Atc "
  do \$\$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role nologin bypassrls;
    end if;
  end \$\$;
  create schema if not exists auth;
  create table if not exists auth.users(id uuid primary key)" > /dev/null

if [ "$TIER" = 1 ]; then
  psql_db -v ON_ERROR_STOP=1 -Atc \
    "create extension if not exists supatype_mask" > /dev/null
fi

PROJECT=$(mktemp -d)
mkdir -p "$PROJECT/schema"
cp "$HERE/schema.ts" "$PROJECT/schema/index.ts"
cat > "$PROJECT/supatype.config.ts" <<CONFIG
import { defineConfig } from "@supatype/cli"

export default defineConfig({
  project: { name: "realtime-tier${TIER}" },
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

psql_db -Atc \
  "select 'tier: ' || (capabilities->'fieldMasking'->>'tier') from _supatype.schema_state"
echo "TIER${TIER}_DATABASE_URL=$URL"
