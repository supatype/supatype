#!/usr/bin/env bash
# Model hooks — prove the generated adapter works inside the real functions worker.
#
# The unit tests compile the generated module with `tsc`. That catches types and syntax and cannot
# catch the thing that actually matters here: whether the **worker** discovers a `hook()`-wrapped
# handler, and whether the verdicts arrive as the HTTP statuses the server will act on. The adapter
# is the seam between our generated code and someone else's runtime, so it gets tested in that
# runtime.
#
# Runs the worker's own `main.ts` under `denoland/deno`, mounting a generated module and two handlers.
# No published image needed, so this works before `supatype/functions-worker` is released.
#
# Usage:
#   bash tests/integration/scripts/hook-adapter.sh
#
# Environment:
#   SUPATYPE_HOOK_PORT   host port for the worker (default 8099)
#   SUPATYPE_DENO_IMAGE  Deno image (default denoland/deno:2.1.4)
set -euo pipefail

PORT="${SUPATYPE_HOOK_PORT:-8099}"
DENO_IMAGE="${SUPATYPE_DENO_IMAGE:-denoland/deno:2.1.4}"
CONTAINER="supatype-hook-adapter-test"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORK="$(mktemp -d)"
STUB_PID=""
STUB2_PID=""

cleanup() {
  docker rm -f "$CONTAINER" "${CONTAINER}-nohooks" "${CONTAINER}-perhook" "${CONTAINER}-bothroots" >/dev/null 2>&1 || true
  [ -f "$WORK/worker2.pid" ] && kill "$(cat "$WORK/worker2.pid")" >/dev/null 2>&1 || true
  [ -f "$WORK/worker3.pid" ] && kill "$(cat "$WORK/worker3.pid")" >/dev/null 2>&1 || true
  [ -f "$WORK/worker4.pid" ] && kill "$(cat "$WORK/worker4.pid")" >/dev/null 2>&1 || true
  [ -f "$WORK/worker.pid" ] && kill "$(cat "$WORK/worker.pid")" >/dev/null 2>&1 || true
  [ -n "$STUB_PID" ] && kill "$STUB_PID" >/dev/null 2>&1 || true
  [ -n "$STUB2_PID" ] && kill "$STUB2_PID" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# Docker needs a host path its daemon understands. Under Git Bash / MSYS, `mktemp -d` gives
# `/tmp/tmp.XXXX`, which the Windows daemon cannot resolve — and the failure surfaces later as a
# container that is simply not there, which is a poor thing to debug.
mount_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi
}

# ── Generate the hooks module from a schema, exactly as `push` would ──────────
echo "→ building the CLI so the generator can be invoked"
(cd "$REPO_ROOT/packages/cli" && npx tsc -p tsconfig.json >/dev/null)

mkdir -p "$WORK/schema" "$WORK/functions/post-hooks" "$WORK/functions/prev-probe"
cat > "$WORK/schema/index.ts" <<'SCHEMA'
import type { Model, RichText, Timestamp, UUID } from "@supatype/types"

export type Post = Model<{
  id: UUID
  title: string
  body: RichText
  created_at: Timestamp
}, {
  tableName: "posts"
  hooks: { beforeChange: "post-hooks"; afterChange: "post-hooks" }
}>
SCHEMA

cat > "$WORK/generate.mjs" <<'GEN'
import { writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const [dist, dir] = process.argv.slice(2)
const { extractSchemaAstFromTypes } = await import(pathToFileURL(`${dist}/type-extractor.js`).href)
const { generateHooksModule } = await import(pathToFileURL(`${dist}/hooks-generator.js`).href)

const ast = extractSchemaAstFromTypes(join(dir, "schema", "index.ts"), dir)
const mod = generateHooksModule(ast)
if (mod === null) throw new Error("no hooks module generated for a schema that declares hooks")
mkdirSync(join(dir, "functions", "_supatype"), { recursive: true })
writeFileSync(join(dir, "functions", "_supatype", "hooks.ts"), mod, "utf8")
GEN
node "$WORK/generate.mjs" "$REPO_ROOT/packages/cli/dist" "$WORK"
[ -f "$WORK/functions/_supatype/hooks.ts" ] || fail "generator wrote no hooks module"

# ── Handlers: one multiplexed, one exercising previous() ──────────────────────
cat > "$WORK/functions/post-hooks/index.ts" <<'TS'
import { hooks, type AfterChange, type BeforeChange } from "../_supatype/hooks.ts"

const moderate: BeforeChange<"posts"> = async (ctx) => {
  if (ctx.operation === "insert") {
    if (ctx.rows.some((r) => r.title.trim() === "")) return { reject: "A post needs a title" }
    if (ctx.rows.some((r) => r.title === "conflict")) {
      return { reject: { message: "Already exists", status: 409, code: "duplicate_title" } }
    }
    return { rows: ctx.rows.map((r) => ({ ...r, title: r.title.trim() })) }
  }
  if (ctx.patch.title === "boom") throw new Error("handler exploded")
  return { patch: { ...ctx.patch, title: (ctx.patch.title ?? "").toUpperCase() } }
}

const reindex: AfterChange<"posts"> = async (ctx) => {
  console.log(`[after] ${ctx.table} ${ctx.operation} rows=${ctx.rows?.length ?? 0}`)
}

export default hooks({ beforeChange: moderate, afterChange: reindex })
TS

cat > "$WORK/functions/prev-probe/index.ts" <<'TS'
import { hook, type BeforeChange } from "../_supatype/hooks.ts"

const probe: BeforeChange<"posts"> = async (ctx) => {
  if (ctx.operation === "insert") return {}
  const { rows, truncated } = await ctx.previous()
  return { reject: `saw ${rows.length} row(s) truncated=${truncated} first=${rows[0]?.title}` }
}

export default hook(probe)
TS

# Stands in for the server's callback endpoint, and records whether the signature was forwarded.
cat > "$WORK/previous-stub.mjs" <<'STUB'
import { createServer } from "node:http"
import { appendFileSync } from "node:fs"
createServer((req, res) => {
  appendFileSync(process.argv[3], `${req.method} ${req.url} sig=${req.headers["webhook-signature"] ?? "none"} depth=${req.headers["x-supatype-hook-depth"] ?? "none"}\n`)
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ rows: [{ id: "1", title: "stored" }], truncated: true }))
}).listen(Number(process.argv[2]))
STUB

# Credential probes: identical handlers in three positions — a plain public function, a public
# function named in `serviceRole`, and a hook that is named nowhere.
mkdir -p "$WORK/functions/peek-key" "$WORK/functions/granted-fn" "$WORK/hooks/privileged"
cat > "$WORK/functions/granted-fn/index.ts" <<'TS'
export default (): Response =>
  new Response(JSON.stringify({ key: Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY") ?? null }), {
    headers: { "Content-Type": "application/json" },
  })
TS
cat > "$WORK/functions/peek-key/index.ts" <<'TS'
export default (): Response =>
  new Response(JSON.stringify({ key: Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY") ?? null }), {
    headers: { "Content-Type": "application/json" },
  })
TS
cat > "$WORK/hooks/privileged/index.ts" <<'TS'
export default (): Response =>
  new Response(JSON.stringify({ key: Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY") ?? null }), {
    headers: { "Content-Type": "application/json" },
  })
TS

mkdir -p "$WORK/hooks/writer"
cat > "$WORK/hooks/writer/index.ts" <<'TS'
// A hand-rolled fetch, deliberately: the guard has to hold for a handler that never touches the
// generated adapter, which is the only way it holds for a handler using any client at all.
export default async (_req: Request): Promise<Response> => {
  await fetch(`${Deno.env.get("SUPATYPE_INTERNAL_URL")}/rest/v1/posts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "[{}]",
  })
  await fetch(`${Deno.env.get("SUPATYPE_EXTERNAL_URL")}/charge`, { method: "POST" })
  return new Response(null, { status: 204 })
}
TS

mkdir -p "$WORK/functions/import-peek"
cat > "$WORK/functions/import-peek/index.ts" <<'TS'
// Reads the key at *import* time, which is the case the startup ordering has to defeat: a module body
// runs when the worker loads it, so a key still in the environment then can be copied and kept.
const stolen = Deno.env.get("SUPATYPE_SERVICE_ROLE_KEY") ?? null
export default (): Response =>
  new Response(JSON.stringify({ stolenAtImport: stolen }), {
    headers: { "Content-Type": "application/json" },
  })
TS

cp "$REPO_ROOT/packages/functions-worker/main.ts" "$WORK/worker-main.ts"

STUB_LOG="$WORK/stub.log"
: > "$STUB_LOG"
node "$WORK/previous-stub.mjs" 8098 "$STUB_LOG" &
STUB_PID=$!

# Somebody else's API, so the test can tell "carried onward" from "leaked to everyone".
EXTERNAL_LOG="$WORK/external.log"
: > "$EXTERNAL_LOG"
node "$WORK/previous-stub.mjs" 8097 "$EXTERNAL_LOG" &
STUB2_PID=$!

# Docker is the more faithful runtime, but a local `deno` runs the same worker code and keeps this
# script usable when the daemon is down. Worth having: the credential-ordering leak below was found on
# this fallback path, because a test that needs Docker Desktop running is a test that quietly does not.
USE_DOCKER=1
if ! docker info >/dev/null 2>&1; then
  command -v deno >/dev/null 2>&1 || fail "no running docker daemon and no local deno"
  USE_DOCKER=0
  echo "→ docker unavailable; running the worker with local deno"
  (
    cd "$WORK"
    SUPATYPE_FUNCTIONS_ROOT="$WORK/functions" \
    SUPATYPE_HOOKS_ROOT="$WORK/hooks" \
    SUPATYPE_SERVICE_ROLE_KEY=super-secret-admin-key \
    SUPATYPE_SERVICE_ROLE_ROUTES=granted-fn \
    SUPATYPE_INTERNAL_URL="http://localhost:8098" \
    SUPATYPE_EXTERNAL_URL="http://localhost:8097" \
    PORT="$PORT" \
    deno run --allow-all "$WORK/worker-main.ts" > "$WORK/worker.log" 2>&1 &
    echo $! > "$WORK/worker.pid"
  )
  for _ in $(seq 1 30); do
    grep -q "handler(s)" "$WORK/worker.log" 2>/dev/null && break
    sleep 1
  done
  grep -q "handler(s)" "$WORK/worker.log" \
    || fail "worker did not start: $(tail -3 "$WORK/worker.log" 2>/dev/null)"
fi

if [ "$USE_DOCKER" = "1" ]; then
echo "→ starting the real worker under $DENO_IMAGE"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
if ! MSYS_NO_PATHCONV=1 docker run --rm -d --name "$CONTAINER" \
  -p "${PORT}:8001" \
  -e SUPATYPE_FUNCTIONS_ROOT=/project/functions \
  -e SUPATYPE_HOOKS_ROOT=/project/hooks \
  -e SUPATYPE_SERVICE_ROLE_KEY=super-secret-admin-key \
  -e SUPATYPE_SERVICE_ROLE_ROUTES=granted-fn \
  -e SUPATYPE_INTERNAL_URL=http://host.docker.internal:8098 \
  -e SUPATYPE_EXTERNAL_URL=http://host.docker.internal:8097 \
  -e PORT=8001 \
  --add-host host.docker.internal:host-gateway \
  -v "$(mount_path "$WORK"):/project:ro" \
  "$DENO_IMAGE" run --allow-all /project/worker-main.ts > "$WORK/docker.out" 2>&1; then
  fail "docker run failed: $(cat "$WORK/docker.out")"
fi

for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://localhost:${PORT}/post-hooks" -X POST \
      -H "content-type: application/json" -d '{}' 2>/dev/null; then break; fi
  sleep 1
done

docker logs "$CONTAINER" 2>&1 | grep -qE "[0-9]+ handler\(s\)" \
  || fail "worker did not start: $(docker logs "$CONTAINER" 2>&1 | tail -3)"
fi

# ── The contract: the status is the outcome ───────────────────────────────────
call() { # event, json, [function]
  curl -s -o "$WORK/body" -w "%{http_code}" -X POST "http://localhost:${PORT}/${3:-post-hooks}" \
    -H "x-supatype-hook: $1" -H "webhook-signature: v1,testsig" \
    -H "content-type: application/json" -d "$2"
}
expect() { # label, actual_status, wanted_status, wanted_body_substring
  [ "$2" = "$3" ] || fail "$1: status $2, wanted $3 (body: $(cat "$WORK/body"))"
  grep -q "$4" "$WORK/body" || fail "$1: body $(cat "$WORK/body") lacks '$4'"
  echo "  ✓ $1"
}

INSERT='{"table":"posts","operation":"insert","requestId":"r1","user":null,"rows":[{"title":"  Hello  "}]}'
expect "proceed replaces the rows"        "$(call beforeChange "$INSERT")" 200 '"title":"Hello"'
expect "rejection is a 422"               "$(call beforeChange '{"table":"posts","operation":"insert","requestId":"r2","rows":[{"title":"  "}]}')" 422 "needs a title"
expect "the hook chooses its own status"  "$(call beforeChange '{"table":"posts","operation":"insert","requestId":"r3","rows":[{"title":"conflict"}]}')" 409 "duplicate_title"
expect "update replaces the patch"        "$(call beforeChange '{"table":"posts","operation":"update","requestId":"r4","patch":{"title":"quiet"},"filter":"id=eq.1"}')" 200 '"title":"QUIET"'
# A throw is not a rejection: it must reach the server as unavailable so onUnavailable decides.
expect "a throw is a 500, not a refusal"  "$(call beforeChange '{"table":"posts","operation":"update","requestId":"r5","patch":{"title":"boom"},"filter":"id=eq.1"}')" 500 "exploded"
expect "the multiplexer dispatches"       "$(call afterChange '{"table":"posts","operation":"insert","requestId":"r6","rows":[{"id":"1"}]}')" 200 '{}'
# The schema and this file can be one deploy apart; failing a write for that would be the wrong way round.
expect "an unhandled event is a 200"      "$(call beforeDelete '{"table":"posts","operation":"delete","requestId":"r7","filter":"id=eq.1"}')" 200 '{}'
expect "malformed payload is a 400"       "$(call beforeChange 'not json')" 400 "not JSON"

# A path, not a URL: the adapter joins it to SUPATYPE_INTERNAL_URL, because the server does not know
# its own in-network address while the worker is already told how to reach the stack.
PREV='{"table":"posts","operation":"update","requestId":"r8","patch":{"title":"x"},"filter":"id=eq.1","previousPath":"/hooks/v1/previous/tok"}'
expect "previous() fetches and truncates" "$(call beforeChange "$PREV" prev-probe)" 422 "saw 1 row(s) truncated=true"
grep -q "sig=v1,testsig" "$STUB_LOG" \
  || fail "previous() did not forward the webhook signature: $(cat "$STUB_LOG")"
echo "  ✓ previous() forwards the signature it was called with"

# Whichever runtime is in use, the handler's own stdout is where the proof is.
worker_logs() {
  if [ "$USE_DOCKER" = "1" ]; then docker logs "$CONTAINER" 2>&1; else cat "$WORK/worker.log"; fi
}
worker_logs | grep -q "\[after\] posts insert rows=1" \
  || fail "the afterChange handler did not run"
echo "  ✓ afterChange ran inside the worker"

# ── The service-role key is withheld unless a route asked for it ──────────────
# Withheld *before handlers are imported*: a module body runs at import time, so a key still in the
# environment then is a key a handler can copy and keep. Testing it in the real worker is the only way
# to know the ordering held.
peeked() { curl -s -X POST "http://localhost:${PORT}/$1" -H "content-type: application/json" -d '{}'; }

IMPORT_PEEK="$(peeked import-peek)"
echo "$IMPORT_PEEK" | grep -q '"stolenAtImport":null' \
  || fail "a handler captured the key at import time: $IMPORT_PEEK"
echo "  ✓ a handler cannot capture it at import time"

PUBLIC_PEEK="$(peeked peek-key)"
echo "$PUBLIC_PEEK" | grep -q '"key":null'   || fail "a public function could read the service-role key: $PUBLIC_PEEK"
echo "  ✓ a public function cannot see the service-role key"

GRANTED_FN="$(peeked granted-fn)"
echo "$GRANTED_FN" | grep -q "super-secret-admin-key"   || fail "a public function named in serviceRole did not receive the key: $GRANTED_FN"
echo "  ✓ a public function named in serviceRole receives it"

# Named nowhere, and still granted: a hook is procedural and unreachable from outside, so listing
# every one would be friction with no attacker to stop — the same trust a trigger already has.
HOOK_PEEK="$(peeked hooks/privileged)"
echo "$HOOK_PEEK" | grep -q "super-secret-admin-key"   || fail "a hook did not receive the key it gets by default: $HOOK_PEEK"
echo "  ✓ a hook receives it without being listed"

# And it does not leak from that invocation into the next one.
PUBLIC_AGAIN="$(peeked peek-key)"
echo "$PUBLIC_AGAIN" | grep -q '"key":null'   || fail "the key leaked from a granted call into a later one: $PUBLIC_AGAIN"
echo "  ✓ and it does not persist into the next call"

# ── The chain depth survives a handler that knows nothing about it ────────────
# A hook holds the service-role key, so a hook writing to its own table re-enters the API and calls
# itself again. The server refuses past a small depth — but only if the count survives the hop through
# handler code, and a handler writes with whatever client it likes.
curl -s -o /dev/null -X POST "http://localhost:${PORT}/hooks/writer" \
  -H "content-type: application/json" -H "x-supatype-hook-depth: 2" -d '{}'

grep -q "depth=2" "$STUB_LOG" \
  || fail "a handler's own write to the stack did not carry the chain depth: $(tail -2 "$STUB_LOG")"
echo "  ✓ a handler's write carries the chain depth"

grep -q "depth=none" "$EXTERNAL_LOG" \
  || fail "an internal header leaked to a third-party API: $(tail -2 "$EXTERNAL_LOG")"
echo "  ✓ and it is not leaked to anyone else"

# ── A hooks root that is not there is ordinary, not fatal ─────────────────────
# Cloud sets SUPATYPE_HOOKS_ROOT on every project's worker, and a project with functions but no hooks
# has no such directory. Worth a real start rather than a unit test: `Deno.readDir` returns its iterable
# without touching the filesystem, so the NotFound arrives during iteration and a `try` around the call
# alone does not catch it — which crashed startup and took that project's working functions with it.
PORT2=$((PORT + 1))
if [ "$USE_DOCKER" = "1" ]; then
  CONTAINER2="${CONTAINER}-nohooks"
  docker rm -f "$CONTAINER2" >/dev/null 2>&1 || true
  MSYS_NO_PATHCONV=1 docker run -d --name "$CONTAINER2" \
    -p "${PORT2}:8001" \
    -e SUPATYPE_FUNCTIONS_ROOT=/project/functions \
    -e SUPATYPE_HOOKS_ROOT=/project/no-such-hooks \
    -e SUPATYPE_SERVICE_ROLE_KEY=super-secret-admin-key \
    -e SUPATYPE_SERVICE_ROLE_ROUTES=granted-fn \
    -e PORT=8001 \
    -v "$(mount_path "$WORK"):/project:ro" \
    "$DENO_IMAGE" run --allow-all /project/worker-main.ts > "$WORK/docker2.out" 2>&1 \
    || fail "docker run failed: $(cat "$WORK/docker2.out")"
  logs2() { docker logs "$CONTAINER2" 2>&1; }
else
  (
    cd "$WORK"
    SUPATYPE_FUNCTIONS_ROOT="$WORK/functions" \
    SUPATYPE_HOOKS_ROOT="$WORK/no-such-hooks" \
    SUPATYPE_SERVICE_ROLE_KEY=super-secret-admin-key \
    SUPATYPE_SERVICE_ROLE_ROUTES=granted-fn \
    PORT="$PORT2" \
    deno run --allow-all "$WORK/worker-main.ts" > "$WORK/worker2.log" 2>&1 &
    echo $! > "$WORK/worker2.pid"
  )
  logs2() { cat "$WORK/worker2.log"; }
fi

for _ in $(seq 1 30); do
  logs2 | grep -qE "[0-9]+ handler\(s\)" && break
  sleep 1
done
logs2 | grep -qE "[0-9]+ handler\(s\)" \
  || fail "the worker refused to start without a hooks directory: $(logs2 | tail -3)"
curl -fsS -o /dev/null -X POST "http://localhost:${PORT2}/granted-fn" \
  -H "content-type: application/json" -d '{}' \
  || fail "a public function did not answer on a worker with no hooks directory"
[ "$USE_DOCKER" = "1" ] && docker rm -f "$CONTAINER2" >/dev/null 2>&1 || true
[ -f "$WORK/worker2.pid" ] && kill "$(cat "$WORK/worker2.pid")" >/dev/null 2>&1 || true
echo "  ✓ a missing hooks directory is not fatal"

# ── The shape a free-tier project runs: one hook, no functions at all ─────────
# Cloud gives each free-tier hook its own Deployment, pinned with SUPATYPE_FUNCTION_NAME and mounting
# only a hooks root. The pin used to be checked per root, so "absent from the functions root" read as
# "absent", and such a pod crashlooped — serving nothing, which the API server reads as the hook
# refusing to answer, failing every write to its table.
PORT3=$((PORT + 2))
if [ "$USE_DOCKER" = "1" ]; then
  CONTAINER3="${CONTAINER}-perhook"
  docker rm -f "$CONTAINER3" >/dev/null 2>&1 || true
  MSYS_NO_PATHCONV=1 docker run -d --name "$CONTAINER3" \
    -p "${PORT3}:8001" \
    -e SUPATYPE_HOOKS_ROOT=/project/hooks \
    -e SUPATYPE_FUNCTION_NAME=privileged \
    -e SUPATYPE_SERVICE_ROLE_KEY=super-secret-admin-key \
    -e PORT=8001 \
    -v "$(mount_path "$WORK"):/project:ro" \
    "$DENO_IMAGE" run --allow-all /project/worker-main.ts > "$WORK/docker3.out" 2>&1 \
    || fail "docker run failed: $(cat "$WORK/docker3.out")"
  logs3() { docker logs "$CONTAINER3" 2>&1; }
else
  (
    cd "$WORK"
    SUPATYPE_HOOKS_ROOT="$WORK/hooks" \
    SUPATYPE_FUNCTION_NAME=privileged \
    SUPATYPE_SERVICE_ROLE_KEY=super-secret-admin-key \
    PORT="$PORT3" \
    deno run --allow-all "$WORK/worker-main.ts" > "$WORK/worker3.log" 2>&1 &
    echo $! > "$WORK/worker3.pid"
  )
  logs3() { cat "$WORK/worker3.log"; }
fi

for _ in $(seq 1 30); do
  logs3 | grep -qE "[0-9]+ handler\(s\)" && break
  sleep 1
done
logs3 | grep -qE "[0-9]+ handler\(s\)" \
  || fail "a per-hook worker did not start: $(logs3 | tail -3)"

# And it answers on the namespaced route, which is the only one the API server calls.
HOOK_ONLY="$(curl -s -X POST "http://localhost:${PORT3}/hooks/privileged" \
  -H "content-type: application/json" -d '{}')"
echo "$HOOK_ONLY" | grep -q "super-secret-admin-key" \
  || fail "a per-hook worker did not serve its hook: $HOOK_ONLY"
echo "  ✓ a worker pinned to one hook serves it with no functions root"

# Same pin, but with a functions root mounted as well — a shape no template generates today and an
# obvious one to reach for (pin a single hook on a worker that also holds functions). The pin used to be
# checked per root, so the hook being absent from the *functions* root threw before the hooks root was
# ever scanned.
PORT4=$((PORT + 3))
if [ "$USE_DOCKER" = "1" ]; then
  CONTAINER4="${CONTAINER}-bothroots"
  docker rm -f "$CONTAINER4" >/dev/null 2>&1 || true
  MSYS_NO_PATHCONV=1 docker run -d --name "$CONTAINER4" \
    -p "${PORT4}:8001" \
    -e SUPATYPE_FUNCTIONS_ROOT=/project/functions \
    -e SUPATYPE_HOOKS_ROOT=/project/hooks \
    -e SUPATYPE_FUNCTION_NAME=privileged \
    -e SUPATYPE_SERVICE_ROLE_KEY=super-secret-admin-key \
    -e PORT=8001 \
    -v "$(mount_path "$WORK"):/project:ro" \
    "$DENO_IMAGE" run --allow-all /project/worker-main.ts > "$WORK/docker4.out" 2>&1 \
    || fail "docker run failed: $(cat "$WORK/docker4.out")"
  logs4() { docker logs "$CONTAINER4" 2>&1; }
else
  (
    cd "$WORK"
    SUPATYPE_FUNCTIONS_ROOT="$WORK/functions" \
    SUPATYPE_HOOKS_ROOT="$WORK/hooks" \
    SUPATYPE_FUNCTION_NAME=privileged \
    SUPATYPE_SERVICE_ROLE_KEY=super-secret-admin-key \
    PORT="$PORT4" \
    deno run --allow-all "$WORK/worker-main.ts" > "$WORK/worker4.log" 2>&1 &
    echo $! > "$WORK/worker4.pid"
  )
  logs4() { cat "$WORK/worker4.log"; }
fi

for _ in $(seq 1 30); do
  logs4 | grep -qE "[0-9]+ handler\(s\)" && break
  sleep 1
done
logs4 | grep -qE "[0-9]+ handler\(s\)" \
  || fail "a worker pinned to a hook refused to start beside a functions root: $(logs4 | tail -3)"
BOTH_ROOTS="$(curl -s -X POST "http://localhost:${PORT4}/hooks/privileged" \
  -H "content-type: application/json" -d '{}')"
echo "$BOTH_ROOTS" | grep -q "super-secret-admin-key" \
  || fail "a pinned hook was not served beside a functions root: $BOTH_ROOTS"
echo "  ✓ and the pin is honoured across both roots, not per root"

echo "PASS: the generated adapter behaves inside the real functions worker"
