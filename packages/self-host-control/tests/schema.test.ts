import { strict as assert } from "node:assert"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { test, describe, before, after } from "node:test"
import { createControlPlaneServer } from "../src/server.js"
import { resetEngineCapabilities } from "../src/engine-runner.js"

const PROJECT = "test-project"
const MOCK_ENGINE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-engine.mjs")

async function request(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json = (await res.json()) as Record<string, unknown>
  return { status: res.status, json }
}

describe("schema routes (mock engine)", () => {
  let baseUrl: string
  let server: ReturnType<typeof createControlPlaneServer>

  before(async () => {
    process.env["SUPATYPE_ENGINE_MOCK"] = MOCK_ENGINE
    process.env["DATABASE_URL"] = "postgres://mock/mock/mock"
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT

    server = createControlPlaneServer()
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve())
    })
    const addr = server.address()
    const port = typeof addr === "object" && addr ? addr.port : 0
    baseUrl = `http://127.0.0.1:${port}`
  })

  after(() => {
    server.close()
    delete process.env["SUPATYPE_ENGINE_MOCK"]
    delete process.env["DATABASE_URL"]
    delete process.env["SUPATYPE_PROJECT_REF"]
  })

  test("GET /schema/migrations returns list", async () => {
    const res = await request(baseUrl, "GET", `/projects/${PROJECT}/schema/migrations`)
    assert.equal(res.status, 200)
    const data = res.json.data as unknown[]
    assert.ok(Array.isArray(data))
    assert.equal((data[0] as { name: string }).name, "20240101_test")
  })

  test("GET /schema/migrations/:name/sources returns snapshot", async () => {
    const res = await request(
      baseUrl,
      "GET",
      `/projects/${PROJECT}/schema/migrations/20240101_test/sources`,
    )
    assert.equal(res.status, 200)
    const data = res.json.data as { name: string; schema_sources_base64: string }
    assert.equal(data.name, "20240101_test")
    assert.ok(data.schema_sources_base64)
  })

  /** The engine arguments the mock was run with for this request. */
  const argsOf = (json: Record<string, unknown>): string[] => (json.data as { args: string[] }).args

  test("GET /schema/capabilities proxies the engine's answer", async () => {
    resetEngineCapabilities()
    const res = await request(baseUrl, "GET", `/projects/${PROJECT}/schema/capabilities`)
    assert.equal(res.status, 200)
    const data = res.json.data as { features: string[] }
    assert.ok(data.features.includes("accept_access_drift"))
    assert.ok(data.features.includes("adopt_none"))
  })

  test("GET /schema/capabilities is empty for an engine from before the subcommand", async () => {
    resetEngineCapabilities()
    process.env["MOCK_ENGINE_NO_CAPABILITIES"] = "1"
    try {
      const res = await request(baseUrl, "GET", `/projects/${PROJECT}/schema/capabilities`)
      assert.equal(res.status, 200)
      assert.deepEqual(res.json.data, { features: [] })
    } finally {
      delete process.env["MOCK_ENGINE_NO_CAPABILITIES"]
      resetEngineCapabilities()
    }
  })

  test("POST /schema/push forwards overwrite_drift", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/push`, {
      ast: {},
      force: true,
      overwrite_drift: true,
    })
    assert.equal(res.status, 200)
    assert.ok(argsOf(res.json).includes("--overwrite-drift"))
    const plain = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/push`, { ast: {}, force: true })
    assert.ok(!argsOf(plain.json).includes("--overwrite-drift"))
  })

  test("POST /schema/adopt forwards keys, release and reclaim", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/adopt`, {
      ast: {},
      yes: true,
      keys: ["table:posts", "column:posts.note"],
      release: ["policy:posts.read"],
      reclaim: ["index:posts.idx"],
    })
    assert.equal(res.status, 200)
    const args = argsOf(res.json)
    assert.deepEqual(
      args.slice(args.indexOf("--yes")),
      ["--yes", "--release", "policy:posts.read", "--reclaim", "index:posts.idx", "--key", "table:posts", "--key", "column:posts.note"],
    )
  })

  test("POST /schema/adopt with keys: [] adopts none, never every conflict", async () => {
    const none = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/adopt`, {
      ast: {},
      yes: true,
      keys: [],
      release: ["policy:posts.read"],
    })
    assert.ok(argsOf(none.json).includes("--adopt-none"))
    assert.ok(!argsOf(none.json).includes("--key"))
    const all = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/adopt`, { ast: {}, yes: true })
    assert.ok(!argsOf(all.json).includes("--adopt-none"))
  })

  test("POST /schema/doctor forwards rebaseline and accept_access_drift", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/doctor`, {
      ast: {},
      rebaseline: true,
      accept_access_drift: true,
    })
    assert.equal(res.status, 200)
    const args = argsOf(res.json)
    assert.ok(args.includes("--rebaseline"))
    assert.ok(args.includes("--accept-access-drift"))
    assert.ok(!args.includes("--overwrite-drift"))
    const report = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/doctor`, { ast: {} })
    assert.ok(!argsOf(report.json).includes("--rebaseline"))
  })

  test("a refusal the engine names is a 409 with its reason", async () => {
    process.env["MOCK_ENGINE_REFUSE"] = "security_drift"
    try {
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/push`, { ast: {} })
      assert.equal(res.status, 409)
      assert.equal(res.json["reason"], "security_drift")
      assert.ok(Array.isArray(res.json["objects"]))
      assert.match(String(res.json["message"]), /changed outside Supatype/)
    } finally {
      delete process.env["MOCK_ENGINE_REFUSE"]
    }
  })

  test("a busy engine is a 409 engine_busy with the engine's own sentence", async () => {
    process.env["MOCK_ENGINE_REFUSE"] = "engine_busy"
    try {
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/adopt`, { ast: {}, yes: true })
      assert.equal(res.status, 409)
      assert.equal(res.json["reason"], "engine_busy")
      assert.equal(
        res.json["message"],
        "another push, adopt or rebaseline is running on this database; try again. Nothing was applied.",
      )
    } finally {
      delete process.env["MOCK_ENGINE_REFUSE"]
    }
  })

  test("POST /schema/rollback applies rollback", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/rollback`, {})
    assert.equal(res.status, 200)
    const data = res.json.data as { status: string }
    assert.equal(data.status, "rolled_back")
  })
})
