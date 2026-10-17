import { strict as assert } from "node:assert"
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test, describe, before, after } from "node:test"
import { dataString, request, startServer, type ControlPlaneServer } from "./helpers.js"

const PROJECT = "test-project"

describe("deployments rollback", () => {
  let baseUrl: string
  let server: ControlPlaneServer
  let tmp: string

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), "sh-deploy-test-"))
    process.env["SUPATYPE_PROJECT_ROOT"] = tmp
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT
    process.env["SUPATYPE_DEPLOYMENTS_DIR"] = join(tmp, ".supatype", "deployments")
    process.env["SUPATYPE_STATIC_ROOT"] = join(tmp, "dist")

    ;({ server, baseUrl } = await startServer())
  })

  after(() => {
    server.close()
    rmSync(tmp, { recursive: true, force: true })
    delete process.env["SUPATYPE_PROJECT_ROOT"]
    delete process.env["SUPATYPE_PROJECT_REF"]
    delete process.env["SUPATYPE_DEPLOYMENTS_DIR"]
    delete process.env["SUPATYPE_STATIC_ROOT"]
  })

  async function deployVersion(content: string): Promise<string> {
    const created = await request(baseUrl, "POST", `/projects/${PROJECT}/deployments`, {
      files: [{ path: "index.html", content, encoding: "utf8" }],
    })
    assert.equal(created.status, 201)
    const id = dataString(created.json, "id")
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
    const version = dataString(rolled.json, "version")
    assert.equal(version, id1)

    assert.equal(readFileSync(staticFile, "utf8"), "<html>v1</html>")

    const current = await request(baseUrl, "GET", `/projects/${PROJECT}/deployments/current`)
    assert.equal(dataString(current.json, "id"), id1)

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
    assert.equal(dataString(rolled.json, "version"), id1)
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
    const id1 = dataString(created1.json, "id")
    await request(baseUrl, "POST", `/projects/${PROJECT}/deployments/${id1}/finalize`)

    const created2 = await request(baseUrl, "POST", `/projects/${PROJECT}/deployments`, {
      files: [{ path: "index.html", content: "b", encoding: "utf8" }],
    })
    const id2 = dataString(created2.json, "id")
    await request(baseUrl, "POST", `/projects/${PROJECT}/deployments/${id2}/finalize`)

    assert.ok(!existsSync(join(subTmp, "dist", "extra.txt")))

    rmSync(subTmp, { recursive: true, force: true })
    process.env["SUPATYPE_PROJECT_ROOT"] = tmp
    process.env["SUPATYPE_DEPLOYMENTS_DIR"] = join(tmp, ".supatype", "deployments")
    process.env["SUPATYPE_STATIC_ROOT"] = join(tmp, "dist")
  })
})

describe("deployments refuse paths and refs outside the project", () => {
  let baseUrl: string
  let server: ControlPlaneServer
  let tmp: string

  before(async () => {
    // The project is one level down, so a file path that climbs out of it still lands inside `tmp`.
    tmp = mkdtempSync(join(tmpdir(), "sh-deploy-escape-"))
    const projectDir = join(tmp, "proj")
    process.env["SUPATYPE_PROJECT_ROOT"] = projectDir
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT
    process.env["SUPATYPE_DEPLOYMENTS_DIR"] = join(projectDir, ".supatype", "deployments")
    process.env["SUPATYPE_STATIC_ROOT"] = join(projectDir, "dist")

    ;({ server, baseUrl } = await startServer())
  })

  after(() => {
    server.close()
    rmSync(tmp, { recursive: true, force: true })
    delete process.env["SUPATYPE_PROJECT_ROOT"]
    delete process.env["SUPATYPE_PROJECT_REF"]
    delete process.env["SUPATYPE_DEPLOYMENTS_DIR"]
    delete process.env["SUPATYPE_STATIC_ROOT"]
  })

  for (const path of ["../../../../escape.txt", "/abs/escape.txt", "assets/../../../../../escape.txt", ""]) {
    test(`a file path ${JSON.stringify(path)} is refused and nothing escapes`, async () => {
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/deployments`, {
        files: [{ path, content: "x", encoding: "utf8" }],
      })
      assert.equal(res.status, 400)
      assert.ok(!existsSync(join(tmp, "escape.txt")))
      assert.ok(!existsSync(join(tmp, "proj", "escape.txt")))
    })
  }

  test("a nested file path inside the deployment is still accepted", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/deployments`, {
      files: [{ path: "assets/app.js", content: "x", encoding: "utf8" }],
    })
    assert.equal(res.status, 201)
    const id = dataString(res.json, "id")
    assert.ok(existsSync(join(tmp, "proj", ".supatype", "deployments", id, "files", "assets", "app.js")))
  })

  // Each used to throw from inside the handler (`.map` of a string, `Buffer.from` of undefined): a 500.
  for (const files of ["index.html", [{ path: "index.html" }], [{ path: "index.html", content: 1 }]]) {
    test(`a deploy body whose files are ${JSON.stringify(files)} is a 400, and nothing is recorded`, async () => {
      const deployments = join(tmp, "proj", ".supatype", "deployments")
      const before = existsSync(deployments) ? readdirSync(deployments) : []
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/deployments`, { files })
      assert.equal(res.status, 400)
      assert.equal(res.json["error"], "validation_error")
      assert.deepEqual(existsSync(deployments) ? readdirSync(deployments) : [], before)
    })
  }

  test("a rollback target that is not a deployment id is refused", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/deployments/rollback`, {
      to: "../../..",
    })
    assert.equal(res.status, 400)
  })

  test("another project's ref is refused", async () => {
    const deployments = join(tmp, "proj", ".supatype", "deployments")
    const before = existsSync(deployments) ? readdirSync(deployments) : []
    const res = await request(baseUrl, "POST", `/projects/someone-else/deployments`, {
      files: [{ path: "index.html", content: "x", encoding: "utf8" }],
    })
    assert.equal(res.status, 404)
    assert.deepEqual(existsSync(deployments) ? readdirSync(deployments) : [], before)
  })
})
