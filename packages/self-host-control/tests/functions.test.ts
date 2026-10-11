import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs"
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

/** Every entry under `dir`, relative to it, so a test can show nothing new appeared anywhere. */
function tree(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const rel = `${prefix}${d.name}`
    return d.isDirectory() ? [rel, ...tree(join(dir, d.name), `${rel}/`)] : [rel]
  })
}

describe("functions routes", () => {
  let baseUrl: string
  let server: ReturnType<typeof createControlPlaneServer>
  let tmp: string
  let projectDir: string

  before(async () => {
    // The project lives one level down so a name that climbs out of it still lands inside `tmp`.
    tmp = mkdtempSync(join(tmpdir(), "sh-functions-test-"))
    projectDir = join(tmp, "proj")
    mkdirSync(join(projectDir, "functions"), { recursive: true })
    writeFileSync(join(projectDir, "keep.txt"), "project file", "utf8")
    process.env["SUPATYPE_PROJECT_ROOT"] = projectDir
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT
    // The worker restart shells out to docker compose; point it at a project that does not exist.
    process.env["COMPOSE_PROJECT_NAME"] = "supatype-self-host-control-test-none"

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
    delete process.env["SUPATYPE_PROJECT_REF"]
    delete process.env["COMPOSE_PROJECT_NAME"]
  })

  const traversalNames = ["../escape", "..", "../../escape", "a/../../escape", "..\\escape", "/abs", ".hidden", ""]

  for (const name of traversalNames) {
    test(`deploy refuses the name ${JSON.stringify(name)} and writes nothing`, async () => {
      const before = tree(tmp)
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, {
        functions: [{ name, source: "export default () => new Response('x')" }],
      })
      assert.equal(res.status, 400)
      assert.equal(res.json["error"], "validation_error")
      assert.deepEqual(tree(tmp), before)
    })
  }

  test("deploy refuses the whole batch when one name is bad", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, {
      functions: [
        { name: "fine", source: "x" },
        { name: "../escape", source: "x" },
      ],
    })
    assert.equal(res.status, 400)
    assert.ok(!existsSync(join(projectDir, "functions", "fine")))
  })

  test("delete refuses a name outside the rule and removes nothing", async () => {
    const before = tree(tmp)
    for (const name of ["..%2Fproj", "%2E%2E%5C", ".hidden", "UPPER"]) {
      const res = await request(baseUrl, "DELETE", `/projects/${PROJECT}/functions/${name}`)
      assert.equal(res.status, 400, name)
    }
    assert.deepEqual(tree(tmp), before)
  })

  test("a valid deploy, list and delete still work", async () => {
    const deployed = await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, {
      functions: [{ name: "hello-world_2", source: "export default 1" }],
    })
    assert.equal(deployed.status, 200)
    assert.ok(existsSync(join(projectDir, "functions", "hello-world_2", "index.ts")))

    const listed = await request(baseUrl, "GET", `/projects/${PROJECT}/functions`)
    assert.deepEqual(listed.json["data"], [{ name: "hello-world_2" }])

    const deleted = await request(baseUrl, "DELETE", `/projects/${PROJECT}/functions/hello-world_2`)
    assert.equal(deleted.status, 200)
    assert.ok(!existsSync(join(projectDir, "functions", "hello-world_2")))
    assert.ok(existsSync(join(projectDir, "keep.txt")))
  })

  const routes: Array<[string, string, unknown?]> = [
    ["GET", "/functions"],
    ["POST", "/functions/deploy", { functions: [{ name: "other", source: "x" }] }],
    ["DELETE", "/functions/other"],
    ["GET", "/functions/env"],
    ["POST", "/functions/env", { key: "K", value: "v" }],
  ]
  for (const [method, path, body] of routes) {
    test(`${method} ${path} refuses another project's ref`, async () => {
      const before = tree(tmp)
      const res = await request(baseUrl, method, `/projects/someone-else${path}`, body)
      assert.equal(res.status, 404)
      assert.equal(res.json["error"], "not_found")
      assert.deepEqual(tree(tmp), before)
    })
  }
})
