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

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [ -n "$STUB_PID" ] && kill "$STUB_PID" >/dev/null 2>&1 || true
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
  appendFileSync(process.argv[3], `${req.method} ${req.url} sig=${req.headers["webhook-signature"] ?? "none"}\n`)
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ rows: [{ id: "1", title: "stored" }], truncated: true }))
}).listen(Number(process.argv[2]))
STUB

cp "$REPO_ROOT/packages/functions-worker/main.ts" "$WORK/worker-main.ts"

STUB_LOG="$WORK/stub.log"
: > "$STUB_LOG"
node "$WORK/previous-stub.mjs" 8098 "$STUB_LOG" &
STUB_PID=$!

echo "→ starting the real worker under $DENO_IMAGE"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
if ! MSYS_NO_PATHCONV=1 docker run --rm -d --name "$CONTAINER" \
  -p "${PORT}:8001" \
  -e SUPATYPE_FUNCTIONS_ROOT=/project/functions \
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

docker logs "$CONTAINER" 2>&1 | grep -q "2 handler(s)" \
  || fail "worker did not discover both handlers: $(docker logs "$CONTAINER" 2>&1 | tail -3)"

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

PREV='{"table":"posts","operation":"update","requestId":"r8","patch":{"title":"x"},"filter":"id=eq.1","previousUrl":"http://host.docker.internal:8098/hook/r8/previous"}'
expect "previous() fetches and truncates" "$(call beforeChange "$PREV" prev-probe)" 422 "saw 1 row(s) truncated=true"
grep -q "sig=v1,testsig" "$STUB_LOG" \
  || fail "previous() did not forward the webhook signature: $(cat "$STUB_LOG")"
echo "  ✓ previous() forwards the signature it was called with"

docker logs "$CONTAINER" 2>&1 | grep -q "\[after\] posts insert rows=1" \
  || fail "the afterChange handler did not run"
echo "  ✓ afterChange ran inside the worker"

echo "PASS: the generated adapter behaves inside the real functions worker"
