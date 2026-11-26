import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, beforeEach, describe, test } from "node:test"
import { isJsonObject } from "@supatype/shared"
import { request, startServer, type ControlPlaneServer } from "./helpers.js"

/**
 * A push's `build.publicEnv` reaches a self-host stack through `PUT /projects/:ref/site/env/config`,
 * which writes the manifest's `public_env`. The server reads it and serves it at /supatype-env.js.
 */
const PROJECT = "test-project"

function manifest(projectDir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(projectDir, ".supatype", "manifest.json"), "utf8"))
  if (!isJsonObject(parsed)) assert.fail("the manifest is not a JSON object")
  return parsed
}

describe("site env config route", () => {
  let baseUrl: string
  let server: ControlPlaneServer
  let tmp: string
  let projectDir: string

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), "sh-site-env-test-"))
    projectDir = join(tmp, "proj")
    process.env["SUPATYPE_PROJECT_ROOT"] = projectDir
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT
    ;({ server, baseUrl } = await startServer())
  })

  beforeEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
    mkdirSync(join(projectDir, ".supatype"), { recursive: true })
    writeFileSync(join(projectDir, ".supatype", "manifest.json"), JSON.stringify({ functions_enabled: true }))
  })

  after(() => {
    server.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  const put = (values: unknown) => request(baseUrl, "PUT", `/projects/${PROJECT}/site/env/config`, { values })

  test("writes the values into the manifest and keeps what else it holds", async () => {
    const res = await put({ MAPS_KEY: "m", STRIPE_PK: "pk_live_1" })
    assert.equal(res.status, 200)
    assert.deepEqual(manifest(projectDir)["public_env"], { MAPS_KEY: "m", STRIPE_PK: "pk_live_1" })
    assert.equal(manifest(projectDir)["functions_enabled"], true)
  })

  test("an empty set clears what an earlier push wrote", async () => {
    await put({ A: "1" })
    const res = await put({})
    assert.equal(res.status, 200)
    assert.equal("public_env" in manifest(projectDir), false)
  })

  test("refuses a value that looks secret and writes nothing", async () => {
    const res = await put({ STRIPE: "sk_live_51Habcdefghijkl" })
    assert.equal(res.status, 400)
    assert.equal("public_env" in manifest(projectDir), false)
    assert.equal(JSON.stringify(res.json).includes("51Habcdefghijkl"), false)
  })

  test("refuses a name that is not allowed", async () => {
    assert.equal((await put({ "bad-name": "x" })).status, 400)
    assert.equal((await put({ VITE_X: "x" })).status, 400)
  })

  test("refuses a body that is not a map of strings", async () => {
    assert.equal((await put({ A: 1 })).status, 400)
    assert.equal((await put([])).status, 400)
  })

  test("refuses a project it does not serve", async () => {
    const res = await request(baseUrl, "PUT", "/projects/other/site/env/config", { values: {} })
    assert.notEqual(res.status, 200)
  })

  test("says so when the stack has no manifest", async () => {
    rmSync(join(projectDir, ".supatype", "manifest.json"))
    assert.equal((await put({ A: "1" })).status, 409)
  })
})
