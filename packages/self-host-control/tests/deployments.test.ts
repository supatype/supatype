import { strict as assert } from "node:assert"
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test, describe, before, after } from "node:test"
import { createControlPlaneServer } from "../src/server.js"

const PROJECT = "test-project"

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

describe("deployments rollback", () => {
  let baseUrl: string
  let server: ReturnType<typeof createControlPlaneServer>
  let tmp: string

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), "sh-deploy-test-"))
    process.env["SUPATYPE_PROJECT_ROOT"] = tmp
    process.env["SUPATYPE_DEPLOYMENTS_DIR"] = join(tmp, ".supatype", "deployments")
    process.env["SUPATYPE_STATIC_ROOT"] = join(tmp, "dist")

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
    rmSync(tmp, { recursive: true, force: true })
    delete process.env["SUPATYPE_PROJECT_ROOT"]
    delete process.env["SUPATYPE_DEPLOYMENTS_DIR"]
    delete process.env["SUPATYPE_STATIC_ROOT"]
  })

  async function deployVersion(content: string): Promise<string> {
    const created = await request(baseUrl, "POST", `/projects/${PROJECT}/deployments`, {
      files: [{ path: "index.html", content, encoding: "utf8" }],
    })
    assert.equal(created.status, 201)
    const id = (created.json.data as { id: string }).id
    const fin = await request(
      baseUrl,
      "POST",
      `/projects/${PROJECT}/deployments/${id}/finalize`,
    )
    assert.equal(fin.status, 200)
    return id
  }

  test("create → finalize ×2 → rollback restores v1", async () => {
    const id1 = await deployVersion("<html>v1</html>")
    const id2 = await deployVersion("<html>v2</html>")

    const staticFile = join(tmp, "dist", "index.html")
    assert.equal(readFileSync(staticFile, "utf8"), "<html>v2</html>")

    const rolled = await request(baseUrl, "POST", `/projects/${PROJECT}/deployments/rollback`)
    assert.equal(rolled.status, 200)
    const version = (rolled.json.data as { version: string }).version
    assert.equal(version, id1)

    assert.equal(readFileSync(staticFile, "utf8"), "<html>v1</html>")

    const current = await request(baseUrl, "GET", `/projects/${PROJECT}/deployments/current`)
    assert.equal((current.json.data as { id: string }).id, id1)

    void id2
  })

  test("rollback --to specific deployment id", async () => {
    const subTmp = mkdtempSync(join(tmpdir(), "sh-deploy-to-"))
    process.env["SUPATYPE_PROJECT_ROOT"] = subTmp
    process.env["SUPATYPE_DEPLOYMENTS_DIR"] = join(subTmp, ".supatype", "deployments")
    process.env["SUPATYPE_STATIC_ROOT"] = join(subTmp, "dist")

    const id1 = await deployVersion("<html>target</html>")
    const id2 = await deployVersion("<html>live</html>")
    assert.equal(readFileSync(join(subTmp, "dist", "index.html"), "utf8"), "<html>live</html>")

    const rolled = await request(baseUrl, "POST", `/projects/${PROJECT}/deployments/rollback`, {
      to: id1,
    })
    assert.equal(rolled.status, 200)
    assert.equal((rolled.json.data as { version: string }).version, id1)
    assert.equal(readFileSync(join(subTmp, "dist", "index.html"), "utf8"), "<html>target</html>")

    void id2
    rmSync(subTmp, { recursive: true, force: true })
    process.env["SUPATYPE_PROJECT_ROOT"] = tmp
    process.env["SUPATYPE_DEPLOYMENTS_DIR"] = join(tmp, ".supatype", "deployments")
    process.env["SUPATYPE_STATIC_ROOT"] = join(tmp, "dist")
  })

  test("rollback without previous returns 404", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "sh-deploy-fresh-"))
    process.env["SUPATYPE_PROJECT_ROOT"] = fresh
    process.env["SUPATYPE_DEPLOYMENTS_DIR"] = join(fresh, ".supatype", "deployments")
    process.env["SUPATYPE_STATIC_ROOT"] = join(fresh, "dist")

    await deployVersion("<html>only</html>")
    const rolled = await request(baseUrl, "POST", `/projects/${PROJECT}/deployments/rollback`)
    assert.equal(rolled.status, 404)

    rmSync(fresh, { recursive: true, force: true })
    process.env["SUPATYPE_PROJECT_ROOT"] = tmp
    process.env["SUPATYPE_DEPLOYMENTS_DIR"] = join(tmp, ".supatype", "deployments")
    process.env["SUPATYPE_STATIC_ROOT"] = join(tmp, "dist")
  })

  test("finalize clears removed static assets", async () => {
    const subTmp = mkdtempSync(join(tmpdir(), "sh-deploy-clear-"))
    process.env["SUPATYPE_PROJECT_ROOT"] = subTmp
    process.env["SUPATYPE_DEPLOYMENTS_DIR"] = join(subTmp, ".supatype", "deployments")
    process.env["SUPATYPE_STATIC_ROOT"] = join(subTmp, "dist")

    const created1 = await request(baseUrl, "POST", `/projects/${PROJECT}/deployments`, {
      files: [
        { path: "index.html", content: "a", encoding: "utf8" },
        { path: "extra.txt", content: "keep", encoding: "utf8" },
      ],
    })
    const id1 = (created1.json.data as { id: string }).id
    await request(baseUrl, "POST", `/projects/${PROJECT}/deployments/${id1}/finalize`)

    const created2 = await request(baseUrl, "POST", `/projects/${PROJECT}/deployments`, {
      files: [{ path: "index.html", content: "b", encoding: "utf8" }],
    })
    const id2 = (created2.json.data as { id: string }).id
    await request(baseUrl, "POST", `/projects/${PROJECT}/deployments/${id2}/finalize`)

    assert.ok(!existsSync(join(subTmp, "dist", "extra.txt")))

    rmSync(subTmp, { recursive: true, force: true })
    process.env["SUPATYPE_PROJECT_ROOT"] = tmp
    process.env["SUPATYPE_DEPLOYMENTS_DIR"] = join(tmp, ".supatype", "deployments")
    process.env["SUPATYPE_STATIC_ROOT"] = join(tmp, "dist")
  })
})
