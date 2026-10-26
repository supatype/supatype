import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test, describe, before, after } from "node:test"
import { request, startServer, TEST_SECRET, type ControlPlaneServer } from "./helpers.js"

/**
 * The control plane answers only the gateway.
 *
 * It listens on the compose network, which the functions worker shares, and it used to answer
 * anybody there: user function code could push a schema, deploy or delete functions, or read
 * their environment by calling it directly instead of through the gateway that checks the
 * service role. Now every request has to present the secret only the gateway holds.
 */

const PROJECT = "test-project"

/** Every route the control plane serves, with a path that reaches it. */
const ROUTES: Array<[string, string]> = [
  ["GET", `/projects/${PROJECT}/status`],
  ["GET", `/projects/${PROJECT}/schema/capabilities`],
  ["POST", `/projects/${PROJECT}/schema/diff`],
  ["POST", `/projects/${PROJECT}/schema/push`],
  ["POST", `/projects/${PROJECT}/schema/rollback`],
  ["GET", `/projects/${PROJECT}/schema/migrations`],
  ["GET", `/projects/${PROJECT}/schema/migrations/m1/sources`],
  ["POST", `/projects/${PROJECT}/schema/doctor`],
  ["POST", `/projects/${PROJECT}/schema/introspect`],
  ["POST", `/projects/${PROJECT}/schema/adopt`],
  ["GET", `/projects/${PROJECT}/functions`],
  ["POST", `/projects/${PROJECT}/functions/deploy`],
  ["DELETE", `/projects/${PROJECT}/functions/hello`],
  ["GET", `/projects/${PROJECT}/functions/env`],
  ["POST", `/projects/${PROJECT}/functions/env`],
  ["POST", `/projects/${PROJECT}/deployments`],
  ["POST", `/projects/${PROJECT}/deployments/rollback`],
  ["POST", `/projects/${PROJECT}/deployments/d1/finalize`],
  ["GET", `/projects/${PROJECT}/deployments/current`],
  ["GET", `/projects/${PROJECT}/deployments`],
  // Not a route: refused before routing, so an unauthenticated caller cannot map the surface.
  ["GET", "/nothing-here"],
  ["OPTIONS", `/projects/${PROJECT}/status`],
]

describe("control plane authentication", () => {
  let baseUrl: string
  let server: ControlPlaneServer
  let tmp: string

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), "sh-auth-test-"))
    mkdirSync(join(tmp, "functions", "hello"), { recursive: true })
    writeFileSync(join(tmp, "functions", "hello", "index.ts"), "export default () => 1\n", "utf8")
    process.env["SUPATYPE_PROJECT_ROOT"] = tmp
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT
    process.env["COMPOSE_PROJECT_NAME"] = "supatype-self-host-control-test-none"
    ;({ server, baseUrl } = await startServer())
  })

  after(() => {
    server.close()
    rmSync(tmp, { recursive: true, force: true })
    delete process.env["SUPATYPE_PROJECT_ROOT"]
    delete process.env["SUPATYPE_PROJECT_REF"]
    delete process.env["COMPOSE_PROJECT_NAME"]
  })

  for (const [method, path] of ROUTES) {
    test(`${method} ${path} without the secret is 401`, async () => {
      const res = await request(baseUrl, method, path, method === "GET" ? undefined : {}, null)
      assert.equal(res.status, 401)
      assert.equal(res.json["error"], "unauthorized")
    })

    test(`${method} ${path} with a wrong secret is 401`, async () => {
      const res = await request(baseUrl, method, path, method === "GET" ? undefined : {}, `${TEST_SECRET}x`)
      assert.equal(res.status, 401)
    })
  }

  test("a refused request changes nothing", async () => {
    await request(baseUrl, "DELETE", `/projects/${PROJECT}/functions/hello`, {}, null)
    assert.ok(existsSync(join(tmp, "functions", "hello", "index.ts")))
  })

  test("an empty secret header is refused", async () => {
    const res = await request(baseUrl, "GET", `/projects/${PROJECT}/status`, undefined, "")
    assert.equal(res.status, 401)
  })

  test("the right secret is served", async () => {
    const res = await request(baseUrl, "GET", `/projects/${PROJECT}/status`)
    assert.equal(res.status, 200)
    assert.equal((res.json["data"] as Record<string, unknown>)["projectRef"], PROJECT)
  })
})

describe("a control plane with no secret configured", () => {
  test("refuses every request, rather than serving everyone", async () => {
    const { server, baseUrl: base } = await startServer("")
    try {
      for (const presented of [null, "", "anything"]) {
        const res = await request(base, "GET", `/projects/${PROJECT}/status`, undefined, presented)
        assert.equal(res.status, 401, `presented ${JSON.stringify(presented)}`)
      }
    } finally {
      server.close()
    }
  })
})
