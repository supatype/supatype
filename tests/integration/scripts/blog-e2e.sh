#!/usr/bin/env bash
# Prove the blog renders on the server, against a running stack.
#
# `@supatype/ssr` is referenced by exactly one example and asserted by none. Typecheck compiles it;
# it cannot tell a Server Component that reached the API from one that threw and fell back to an
# error branch, and both return 200. So this reads the HTML: the marker it looks for is produced by
# the Server Component after `createServerClient` answered, which a client-side fetch would leave
# out of the first response.
#
# Usage:
#   bash tests/integration/scripts/blog-e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
EXAMPLE_DIR="$ROOT_DIR/examples/blog"
CLI_BIN="$ROOT_DIR/packages/cli/bin/supatype.js"
KONG_PORT="${SUPATYPE_KONG_PORT:-18473}"
BASE_URL="${BLOG_E2E_URL:-http://127.0.0.1:${KONG_PORT}}"
MAX_WAIT="${BLOG_E2E_MAX_WAIT:-300}"
# The Next dev server starts after the stack and compiles on first request, so it gets its own
# deadline rather than borrowing the stack's.
APP_WAIT="${BLOG_E2E_APP_WAIT:-180}"

source "$SCRIPT_DIR/lib/http-wait.sh"
source "$SCRIPT_DIR/lib/example-keys.sh"

DEV_PID=""
ENV_EXISTED="no"
LOCAL_ENV_EXISTED="no"
[[ -f "$EXAMPLE_DIR/.env" ]] && ENV_EXISTED="yes"
[[ -f "$EXAMPLE_DIR/.env.local" ]] && LOCAL_ENV_EXISTED="yes"

cleanup() {
  echo ""
  echo "==> teardown"
  if [[ -n "$DEV_PID" ]]; then kill "$DEV_PID" 2>/dev/null || true; fi
  (cd "$EXAMPLE_DIR" && docker compose -p supatype-blog down -v --remove-orphans) >/dev/null 2>&1 || true
  # Both files hold a signed key and neither is gitignored, so a failure must not leave one behind.
  if [[ "$ENV_EXISTED" == "no" ]]; then rm -f "$EXAMPLE_DIR/.env"; fi
  if [[ "$LOCAL_ENV_EXISTED" == "no" ]]; then rm -f "$EXAMPLE_DIR/.env.local"; fi
}
trap cleanup EXIT INT TERM

if [[ ! -f "$CLI_BIN" ]]; then
  echo "ERROR: CLI not found at $CLI_BIN, run 'pnpm build' first"
  exit 1
fi

fail() { echo "  FAIL $*" >&2; exit 1; }

echo "==> Minting keys"
# Before the stack: `supatype dev` starts the Next server itself (app.start = "dev"), and Next reads
# .env.local once at startup. Write it afterwards and the app runs with no key.
mint_keys "$EXAMPLE_DIR" "$CLI_BIN"

cat > "$EXAMPLE_DIR/.env.local" <<ENV
NEXT_PUBLIC_SUPATYPE_URL=${BASE_URL}
NEXT_PUBLIC_SUPATYPE_ANON_KEY=${ANON_KEY}
NEXT_PUBLIC_SUPATYPE_AUTH_COOKIE_PREFIX=st
SUPATYPE_AUTH_COOKIE_PREFIX=st
ENV

echo "==> Bringing the stack up (this starts Next too)"
(cd "$EXAMPLE_DIR" && node "$CLI_BIN" dev) &
DEV_PID=$!

ready() { http_ok "$BASE_URL/auth/v1/health"; }
if ! wait_until "$MAX_WAIT" "$BASE_URL/auth/v1/health" ready; then
  echo "ERROR: the stack never became ready"
  exit 1
fi

app_ready() { [[ "$(http_status "$BASE_URL/")" == "200" ]]; }
if ! wait_until "$APP_WAIT" "the Next app through the gateway" app_ready; then
  echo "ERROR: / never answered 200 — the proxy never reached the app"
  exit 1
fi

echo ""
echo "==> / is rendered by the server, from the API"
home="$(curl -s --connect-timeout 3 --max-time 20 "$BASE_URL/")"
# The error branch renders when createServerClient answers with one. It is a 200 too, which is why
# the status alone proves nothing.
if grep -q 'class="error"' <<<"$home"; then
  echo "$home" | grep -o 'class="error">[^<]*' | head -1 >&2
  fail "the home page rendered its error branch"
fi
# One of these two is written by the Server Component once the query returned: the heading when
# there are posts, the empty state when there are none. Neither appears if the component threw, and
# neither is in the shell a client-only render would send first.
grep -qE 'Recent posts|No posts yet' <<<"$home" \
  || fail "no server-rendered post list in the first response — the Server Component did not reach the API"
echo "  ok   the post list was rendered server-side"

echo ""
echo "==> The client routes are served through the same origin"
for path in /login /signup; do
  status="$(http_status "$BASE_URL$path")"
  [[ "$status" == "200" ]] || fail "GET $path returned $status, expected 200"
done
echo "  ok   /login and /signup answer through the gateway"

echo ""
echo "==> The example's edge function answers"
status="$(http_status -X POST \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"from":"blog-e2e"}' \
  "$BASE_URL/functions/v1/greet")"
[[ "$status" == "200" ]] || fail "POST /functions/v1/greet returned $status, expected 200"
echo "  ok   greet invoked"

echo ""
echo "PASS: the blog renders server-side against its own stack"
