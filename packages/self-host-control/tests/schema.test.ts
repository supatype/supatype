import { strict as assert } from "node:assert"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { test, describe, before, after } from "node:test"
import { createControlPlaneServer } from "../src/server.js"

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

  test("POST /schema/rollback applies rollback", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/rollback`, {})
    assert.equal(res.status, 200)
    const data = res.json.data as { status: string }
    assert.equal(data.status, "rolled_back")
  })
})
