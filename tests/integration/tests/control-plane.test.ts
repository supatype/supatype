/**
 * Control-plane integration tests: run against a live supatype dev stack.
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
import { at, stringAt } from "../lib/json.js"

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

/**
 * A response body read once: its text for a failure message and its JSON for the assertions.
 *
 * Reading it twice is not possible. `assert.ok(res.ok, await res.text())` evaluates its message
 * whether or not the assertion fails, so a `res.json()` after it threw "Body is unusable".
 */
async function readBody(res: Response): Promise<{ text: string; json: unknown }> {
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // Not JSON: left undefined, and the assertion that reads it fails with the text.
  }
  return { text, json }
}

/** Create a static deployment of one page and finalize it, returning its id. */
async function deployStatic(html: string): Promise<string> {
  const created = await platformFetch(`/projects/${PROJECT_REF}/deployments`, {
    method: "POST",
    body: JSON.stringify({ files: [{ path: "index.html", content: html, encoding: "utf8" }] }),
  })
  const body = await readBody(created)
  assert.equal(created.status, 201, body.text)
  const id = stringAt(at(body.json, "data"), "id")
  assert.ok(id !== undefined, `the deployment has no data.id: ${body.text}`)

  const finalized = await platformFetch(`/projects/${PROJECT_REF}/deployments/${id}/finalize`, {
    method: "POST",
  })
  assert.ok(finalized.ok, await finalized.text())
  return id
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
    const json = await res.json()
    assert.ok(at(json, "data"))
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
      const parsed = JSON.parse(out.trim())
      assert.equal(at(parsed, "mode"), "self-host")
      assert.equal(at(parsed, "prefix"), "/platform/v1")
      assert.equal(at(parsed, "ref"), PROJECT_REF)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("deploy create → finalize ×2 → rollback restores previous static", async () => {
    const v1 = `<html>rollback-v1-${Date.now()}</html>`
    const v2 = `<html>rollback-v2-${Date.now()}</html>`

    const id1 = await deployStatic(v1)
    await deployStatic(v2)

    const rolled = await platformFetch(`/projects/${PROJECT_REF}/deployments/rollback`, {
      method: "POST",
    })
    const rolledBody = await readBody(rolled)
    assert.ok(rolled.ok, rolledBody.text)
    assert.equal(at(at(rolledBody.json, "data"), "version"), id1)

    const current = await platformFetch(`/projects/${PROJECT_REF}/deployments/current`)
    const currentBody = await readBody(current)
    assert.ok(current.ok, currentBody.text)
    assert.equal(at(at(currentBody.json, "data"), "id"), id1)
  })

  test("GET /projects/:ref/schema/migrations", async () => {
    const res = await platformFetch(`/projects/${PROJECT_REF}/schema/migrations`)
    const body = await readBody(res)
    assert.ok(res.ok, `migrations list failed: ${res.status} ${body.text}`)
    assert.ok(at(body.json, "data") !== undefined, `no data in ${body.text}`)
  })
})
