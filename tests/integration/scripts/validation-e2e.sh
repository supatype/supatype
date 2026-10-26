#!/usr/bin/env bash
# Prove the three validation mechanisms actually refuse writes, against a running stack.
#
# Every defect this exists to catch had passing unit tests around it and no test that ran the real
# path: a validator map built and never called, a manifest key the compose push never wrote, an
# introspection filter that dropped real constraints, and a Studio normalizer that discarded every
# rule the engine emitted. Each looked green. The only thing that noticed was sending a request.
#
# So this asserts on refusals, not on generated text. A bound that is silently absent shows up here
# as a request that should have failed and did not, which no amount of string matching can catch.
#
# Beside another run, from another checkout: SUPATYPE_E2E_PROJECT names this run's compose project,
# and SUPATYPE_KONG_PORT, SUPATYPE_SERVER_PORT and SUPATYPE_SEAWEEDFS_PORT move its ports. See
# lib/e2e-project.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EXAMPLE_DIR="$ROOT_DIR/examples/validation"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
# IPv4 explicitly: `localhost` resolves to ::1 first on some hosts, where Docker's IPv6 forwarder
# may accept and then reset. That cost an afternoon once.
BASE_URL="${VALIDATION_E2E_URL:-http://127.0.0.1:${KONG_PORT}}"
API="$BASE_URL/rest/v1/product"
MAX_WAIT=180
EMAIL="e2e@example.com"
PASSWORD="e2e-password-12345"

source "$SCRIPT_DIR/lib/compose-reset.sh"

failures=0

source "$SCRIPT_DIR/lib/e2e-project.sh"
e2e_project_use "$EXAMPLE_DIR" validation
# Exported so compose binds the port this script waits on, whatever an old .env says.
export SUPATYPE_KONG_PORT="$KONG_PORT"

# By project name, with the volumes, which `self-host compose down` keeps (see compose-smoke.sh).
# The assertions insert fixed rows with unique slugs, so a database that outlived the last run
# answers them with 409 and the run fails for no reason.
cleanup() {
  e2e_project_down
  e2e_project_release
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

cd "$EXAMPLE_DIR"

# `.env` is gitignored, so CI has none. The same helper the compose smoke uses, rather than a
# second copy of the secret list: the hand-rolled version here wrote JWT_SECRET and the keys but
# not AUTHENTICATOR_PASSWORD, and compose refuses to interpolate a variable it cannot resolve.
node "$SCRIPT_DIR/ensure-compose-env.mjs" "$EXAMPLE_DIR"

# Only after e2e_project_use, which claims the project and refuses one another directory is running.
echo "==> Removing anything a previous run left in $E2E_COMPOSE_PROJECT"
remove_compose_project "$E2E_COMPOSE_PROJECT"

echo "==> Bringing the stack up"
node "$CLI_BIN" self-host compose up -d
node "$CLI_BIN" push --yes

echo "==> Waiting for $BASE_URL (up to ${MAX_WAIT}s)"
for i in $(seq 1 "$MAX_WAIT"); do
  if curl -sf "$BASE_URL/auth/v1/health" >/dev/null 2>&1; then
    echo "    ready after ${i}s"
    break
  fi
  if [[ "$i" -eq "$MAX_WAIT" ]]; then
    echo "    ERROR: stack did not become ready within ${MAX_WAIT}s"
    docker compose -p "$E2E_COMPOSE_PROJECT" ps || true
    exit 1
  fi
  sleep 1
done

ANON="$(grep -E '^ANON_KEY=' .env | tail -1 | cut -d= -f2-)"

# `create` is LoggedIn, not Public, so an anon key alone cannot write. Signing up is part of the
# path under test: a token that RLS accepts is what makes a refusal below mean "the rule bit"
# rather than "you were not allowed in".
curl -sf -X POST "$BASE_URL/auth/v1/signup" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null 2>&1 || true

TOKEN="$(curl -s -X POST "$BASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).access_token||"")}catch{}})')"

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: could not sign in as $EMAIL; every assertion below would be a false pass"
  exit 1
fi

env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }

# A query against the project's database, through the container: nothing publishes Postgres's port.
db_query() {
  local container
  container="$(docker ps -q --filter "label=com.docker.compose.project=$E2E_COMPOSE_PROJECT" \
    --filter "label=com.docker.compose.service=db" | head -1)"
  docker exec -e PGPASSWORD="$(env_value POSTGRES_PASSWORD)" "$container" \
    psql -U "$(env_value POSTGRES_USER)" -d "$(env_value POSTGRES_DB)" -X -tAc "$1"
}

# What PostgREST's 23514 body says when the named CHECK refuses the row: the whole name, quoted, so
# `product_name_bounds` cannot pass for `product_name_bounds_2` or for another rule on the column.
refused_by() {
  printf 'violates check constraint \\"%s\\"' "$1"
}

# Asserts the status *and* that the body names the rule, so a request refused for an unrelated
# reason (a 401, a 409 on the unique slug) does not read as the bound working.
expect() {
  local want="$1" label="$2" body="$3" needle="${4:-}"
  local out code
  out="$(curl -s -o /tmp/ve2e.json -w '%{http_code}' -X POST "$API" \
    -H "apikey: $ANON" -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -H "Prefer: return=minimal" -d "$body")"
  code="$out"

  if [[ "$code" != "$want" ]]; then
    printf '  FAIL %-46s expected %s, got %s\n' "$label" "$want" "$code"
    head -c 200 /tmp/ve2e.json; echo
    failures=$((failures + 1))
    return
  fi
  if [[ -n "$needle" ]] && ! grep -qF -- "$needle" /tmp/ve2e.json; then
    printf '  FAIL %-46s %s expected, but body did not mention %s\n' "$label" "$want" "$needle"
    head -c 200 /tmp/ve2e.json; echo
    failures=$((failures + 1))
    return
  fi
  printf '  ok   %-46s %s\n' "$label" "$code"
}

echo "==> Mechanism 1: bounds on a field"
expect 201 "a row inside every bound" \
  '{"name":"E2E Alpha","status":"draft","rating":3}'
# Postgres checks a row's CHECK constraints in name order, so a two-letter name meets the field bound
# `product_name_bounds` before the model rule `product_name_min_length` that says the same thing.
# The field bound is what this asserts; the model rule's presence is asserted from the catalogue below.
expect 400 "MinLength<3> on name" \
  '{"name":"ab","status":"draft"}' "$(refused_by product_name_bounds)"
expect 400 "Between<Int,1,5> on rating" \
  '{"name":"E2E Beta","status":"draft","rating":9}' "$(refused_by product_rating_bounds)"
expect 400 "MaxItems<8> on tags" \
  '{"name":"E2E Gamma","status":"draft","tags":["1","2","3","4","5","6","7","8","9"]}' \
  "$(refused_by product_tags_bounds)"

echo "==> The localized bound, which a scalar expression cannot express"
expect 400 "MaxLength<60> breached in fr only" \
  '{"name":"E2E Delta","status":"draft","headline":{"en":"short","fr":"beaucoup trop long pour tenir dans la limite de soixante caracteres imposee"}}' \
  "$(refused_by product_headline_bounds)"
expect 201 "same field, both locales inside the bound" \
  '{"name":"E2E Epsilon","status":"draft","headline":{"en":"short","fr":"court"}}'

echo "==> Mechanism 2: constraints on the model"
# Each rule is named for what it checks, so the refusal tells the writer which rule it broke.
expect 400 "published requires a sku" \
  '{"name":"E2E Zeta","status":"published"}' "$(refused_by product_status_eq_or_sku_not_null)"
expect 400 "Matches on sku" \
  '{"name":"E2E Eta","status":"draft","sku":"nope"}' "$(refused_by product_sku_format)"
expect 400 "Lte<availableFrom, availableUntil>" \
  '{"name":"E2E Theta","status":"draft","availableFrom":"2027-01-01","availableUntil":"2026-01-01"}' \
  "$(refused_by product_availableFrom_lte_availableUntil)"
# 21 one-minute items: inside the validator's 120-minute cap, so only the item count can refuse it.
twenty_one_items="$(printf '{"label":"step","minutes":1},%.0s' $(seq 1 21))"
expect 400 "Lte<ItemCount<setupItems>, 20>" \
  "{\"name\":\"E2E Lambda\",\"status\":\"draft\",\"setupItems\":[${twenty_one_items%,}]}" \
  "$(refused_by product_setupItems_max_items)"

# Every model rule, by its exact name. `product_name_min_length` cannot be reached by a request (see
# above), so the catalogue is the only place its name can be checked. Field bounds end in `_bounds`
# and a field type's own check (the status enum, the slug pattern) in `_check`; the rest are the
# model's rules.
model_rules="$(db_query "SELECT string_agg(conname, ',' ORDER BY conname COLLATE \"C\") FROM pg_constraint
  WHERE conrelid = 'public.product'::regclass AND contype = 'c' AND conname !~ '_(bounds|check)\$'")"
want_rules="product_availableFrom_lte_availableUntil,product_name_min_length,product_setupItems_max_items,product_sku_format,product_status_eq_or_sku_not_null"
if [[ "$model_rules" == "$want_rules" ]]; then
  printf '  ok   %-46s %s\n' "every model rule under its own name" "5"
else
  printf '  FAIL %-46s\n       want %s\n       got  %s\n' "every model rule under its own name" \
    "$want_rules" "$model_rules"
  failures=$((failures + 1))
fi

echo "==> Mechanism 3: the validator, which the database cannot express"
expect 201 "75 minutes, under the cap" \
  '{"name":"E2E Iota","status":"draft","setupItems":[{"label":"prep","minutes":30},{"label":"build","minutes":45}]}'
# The field name is the point: it is what lets a client put the message on the right input, and it
# is the one thing a plain hook cannot give back.
expect 422 "170 minutes, over the cap, naming the field" \
  '{"name":"E2E Kappa","status":"draft","setupItems":[{"label":"prep","minutes":90},{"label":"build","minutes":80}]}' \
  'setupItems'

echo
if [[ "$failures" -gt 0 ]]; then
  echo "FAILED: $failures assertion(s)"
  exit 1
fi
echo "PASSED: every mechanism refused what it should and accepted what it should"
