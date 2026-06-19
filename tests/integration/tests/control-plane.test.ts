/**
 * Control-plane integration tests — run against a live supatype dev stack.
 *
 * Requires SUPATYPE_URL and SUPATYPE_SERVICE_ROLE_KEY from `supatype dev`.
 * Run via: scripts/control-plane-test.sh
 */

import { strict as assert } from "node:assert"
import { test, describe, before } from "node:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"

const BASE_URL = process.env["SUPATYPE_URL"] ?? "http://localhost:18473"
const SERVICE_ROLE_KEY = process.env["SUPATYPE_SERVICE_ROLE_KEY"] ?? process.env["SERVICE_ROLE_KEY"]
const PROJECT_REF = process.env["SUPATYPE_PROJECT_REF"] ?? "integration-test"

function platformFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}/platform/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
}

describe("control plane via Kong", () => {
  before(() => {
    if (!SERVICE_ROLE_KEY) {
      throw new Error("SUPATYPE_SERVICE_ROLE_KEY or SERVICE_ROLE_KEY is required")
    }
  })

  test("GET /projects/:ref/status", async () => {
    const res = await platformFetch(`/projects/${PROJECT_REF}/status`)
    assert.ok(res.ok, `status failed: ${res.status}`)
    const json = await res.json() as { data: { projectRef?: string } }
    assert.ok(json.data)
  })

  test("POST /projects/:ref/schema/diff", async () => {
    const astPath = join(process.cwd(), ".supatype", "schema.ast.json")
    let ast: unknown = { version: 2, models: [] }
    try {
      ast = JSON.parse(await import("node:fs").then((m) => m.readFileSync(astPath, "utf8")))
    } catch {
      /* minimal ast */
    }

    const res = await platformFetch(`/projects/${PROJECT_REF}/schema/diff`, {
      method: "POST",
      body: JSON.stringify({ ast }),
    })
    assert.ok(res.ok, `diff failed: ${res.status}`)
  })

  test("linked remote workflow via CLI resolveTarget", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "supatype-link-test-"))
    try {
      writeFileSync(
        join(tmp, ".supatype", "link.json"),
        `${JSON.stringify({
          version: 1,
          kind: "self-host",
          projectRef: PROJECT_REF,
          defaultEnvironment: "production",
          linkedAt: new Date().toISOString(),
          environments: {
            production: {
              name: "production",
              apiUrl: BASE_URL,
              token: SERVICE_ROLE_KEY,
              linkedAt: new Date().toISOString(),
            },
          },
        }, null, 2)}\n`,
        { flag: "wx" },
      )

      const cliRoot = join(process.cwd(), "..", "..", "packages", "cli")
      const out = execSync(
        `node --import tsx/esm -e "import { resolveTarget } from './src/resolve-target.ts'; const t = resolveTarget('${tmp.replace(/\\/g, "/")}'); console.log(JSON.stringify({ mode: t.mode, prefix: t.apiPrefix, ref: t.projectRef }));"`,
        { cwd: cliRoot, encoding: "utf8" },
      )
      const parsed = JSON.parse(out.trim()) as { mode: string; prefix: string; ref: string }
      assert.equal(parsed.mode, "self-host")
      assert.equal(parsed.prefix, "/platform/v1")
      assert.equal(parsed.ref, PROJECT_REF)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("deploy create → finalize ×2 → rollback restores previous static", async () => {
    const v1 = `<html>rollback-v1-${Date.now()}</html>`
    const v2 = `<html>rollback-v2-${Date.now()}</html>`

    const create1 = await platformFetch(`/projects/${PROJECT_REF}/deployments`, {
      method: "POST",
      body: JSON.stringify({
        files: [{ path: "index.html", content: v1, encoding: "utf8" }],
      }),
    })
    assert.equal(create1.status, 201, await create1.text())
    const id1 = ((await create1.json()) as { data: { id: string } }).data.id

    const fin1 = await platformFetch(`/projects/${PROJECT_REF}/deployments/${id1}/finalize`, {
      method: "POST",
    })
    assert.ok(fin1.ok, await fin1.text())

    const create2 = await platformFetch(`/projects/${PROJECT_REF}/deployments`, {
      method: "POST",
      body: JSON.stringify({
        files: [{ path: "index.html", content: v2, encoding: "utf8" }],
      }),
    })
    assert.equal(create2.status, 201, await create2.text())
    const id2 = ((await create2.json()) as { data: { id: string } }).data.id

    const fin2 = await platformFetch(`/projects/${PROJECT_REF}/deployments/${id2}/finalize`, {
      method: "POST",
    })
    assert.ok(fin2.ok, await fin2.text())

    const rolled = await platformFetch(`/projects/${PROJECT_REF}/deployments/rollback`, {
      method: "POST",
    })
    assert.ok(rolled.ok, await rolled.text())
    const rolledJson = (await rolled.json()) as { data: { version: string } }
    assert.equal(rolledJson.data.version, id1)

    const current = await platformFetch(`/projects/${PROJECT_REF}/deployments/current`)
    assert.ok(current.ok, await current.text())
    const currentJson = (await current.json()) as { data: { id: string } }
    assert.equal(currentJson.data.id, id1)
  })

  test("GET /projects/:ref/schema/migrations", async () => {
    const res = await platformFetch(`/projects/${PROJECT_REF}/schema/migrations`)
    assert.ok(res.ok, `migrations list failed: ${res.status} ${await res.text()}`)
    const json = await res.json() as { data: unknown }
    assert.ok(Array.isArray(json.data) || json.data !== undefined)
  })
})
