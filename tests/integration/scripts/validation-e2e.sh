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

failures=0

cleanup() {
  if [[ -d "$EXAMPLE_DIR/.supatype/self-host" ]]; then
    (cd "$EXAMPLE_DIR" && node "$CLI_BIN" self-host compose down) >/dev/null 2>&1 || true
  fi
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
    docker compose -p supatype-validation ps || true
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
  if [[ -n "$needle" ]] && ! grep -q "$needle" /tmp/ve2e.json; then
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
expect 400 "MinLength<3> on name" \
  '{"name":"ab","status":"draft"}' 'product_check_'
expect 400 "Between<Int,1,5> on rating" \
  '{"name":"E2E Beta","status":"draft","rating":9}' 'product_rating_bounds'
expect 400 "MaxItems<8> on tags" \
  '{"name":"E2E Gamma","status":"draft","tags":["1","2","3","4","5","6","7","8","9"]}' 'product_tags_bounds'

echo "==> The localized bound, which a scalar expression cannot express"
expect 400 "MaxLength<60> breached in fr only" \
  '{"name":"E2E Delta","status":"draft","headline":{"en":"short","fr":"beaucoup trop long pour tenir dans la limite de soixante caracteres imposee"}}' \
  'product_headline_bounds'
expect 201 "same field, both locales inside the bound" \
  '{"name":"E2E Epsilon","status":"draft","headline":{"en":"short","fr":"court"}}'

echo "==> Mechanism 2: constraints on the model"
expect 400 "published requires a sku" \
  '{"name":"E2E Zeta","status":"published"}' 'product_check_'
expect 400 "Matches on sku" \
  '{"name":"E2E Eta","status":"draft","sku":"nope"}' 'product_check_'
expect 400 "Lte<availableFrom, availableUntil>" \
  '{"name":"E2E Theta","status":"draft","availableFrom":"2027-01-01","availableUntil":"2026-01-01"}' 'product_check_'

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
