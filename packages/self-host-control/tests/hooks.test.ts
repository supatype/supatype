import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { after, before, beforeEach, describe, test } from "node:test"
import { isJsonObject } from "@supatype/shared"
import { dataOf, request, startServer, type ControlPlaneServer } from "./helpers.js"

/**
 * Local test round 4 (N23): `supatype push` to a project linked to a self-host stack applied the
 * schema, then posted its hooks to `/projects/:ref/hooks/deploy`, which the control plane did not
 * have: `Route not found`. The route takes the body the CLI sends Cloud, writes the handlers where
 * the stack's worker serves hooks from, and the hook map into the manifest the server reads.
 */
const PROJECT = "test-project"

/** What the CLI sends: handlers flattened, the generated adapter as `_supatype-hooks`. */
const ADAPTER = { name: "_supatype-hooks", source: "export const hook = (handler) => handler\n" }
const TAG_NOTE = {
  name: "tag-note",
  source: 'import { hook } from "./_supatype-hooks.ts"\nexport default hook(async () => ({}))\n',
}
const MAP = { note: { beforeChange: { function: "tag-note", timeout: 5000, onUnavailable: "reject" } } }

function tree(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const rel = `${prefix}${d.name}`
    return d.isDirectory() ? [rel, ...tree(join(dir, d.name), `${rel}/`)] : [rel]
  })
}

function manifest(projectDir: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(projectDir, ".supatype", "manifest.json"), "utf8"))
  if (!isJsonObject(parsed)) assert.fail("the manifest is not a JSON object")
  return parsed
}

describe("hooks deploy route", () => {
  let baseUrl: string
  let server: ControlPlaneServer
  let tmp: string
  let projectDir: string

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), "sh-hooks-test-"))
    projectDir = join(tmp, "proj")
    process.env["SUPATYPE_PROJECT_ROOT"] = projectDir
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT
    process.env["COMPOSE_PROJECT_NAME"] = "supatype-self-host-control-test-none"
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
    delete process.env["SUPATYPE_PROJECT_ROOT"]
    delete process.env["SUPATYPE_PROJECT_REF"]
    delete process.env["COMPOSE_PROJECT_NAME"]
  })

  test("writes each handler where the worker serves hooks, the adapter beside them, and the map", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [TAG_NOTE, ADAPTER], map: MAP })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual(dataOf(res.json)["handlers"], ["tag-note"])
    const handler = readFileSync(join(projectDir, "hooks", "tag-note", "index.ts"), "utf8")
    // The project's own layout: the import the CLI flattened is put back.
    assert.match(handler, /from "\.\.\/_supatype\/hooks\.ts"/)
    assert.equal(readFileSync(join(projectDir, "hooks", "_supatype", "hooks.ts"), "utf8"), ADAPTER.source)
    const written = manifest(projectDir)
    assert.deepEqual(written["hooks"], MAP)
    assert.equal(written["functions_enabled"], true)
  })

  test("removes the map when the schema declares no hooks", async () => {
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [TAG_NOTE, ADAPTER], map: MAP })
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [], map: {} })
    assert.equal(res.status, 200)
    assert.equal("hooks" in manifest(projectDir), false)
  })

  for (const name of ["../escape", "..", "a/../../escape", "..\\escape", "/abs", ".hidden", "", "_supatype"]) {
    test(`refuses the handler name ${JSON.stringify(name)} and writes nothing`, async () => {
      const before = tree(tmp)
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, {
        handlers: [TAG_NOTE, { name, source: "x" }],
        map: MAP,
      })
      assert.equal(res.status, 400)
      assert.equal(res.json["error"], "validation_error")
      assert.deepEqual(tree(tmp), before)
    })
  }

  test("refuses a map naming a handler that was not uploaded, and writes nothing", async () => {
    const before = tree(tmp)
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [ADAPTER], map: MAP })
    assert.equal(res.status, 400)
    assert.match(String(res.json["message"]), /tag-note/)
    assert.deepEqual(tree(tmp), before)
  })

  test("refuses a caller without the gateway's secret", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [], map: {} }, null)
    assert.equal(res.status, 401)
    assert.equal(existsSync(join(projectDir, "hooks")), false)
  })

  // A linked push wrote no validator or cache map on the stack, so neither applied there.
  const CHECK_TITLE = { name: "check-title", source: "export default () => ({ ok: true })\n" }
  const VALIDATORS = { note: { title: { function: "check-title", timeout: 5000, onUnavailable: "reject" } } }
  const CACHE = { note: { enabled: true, rows: true, maxTtl: 60 } }

  test("writes the validator and cache maps in the same manifest write", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, {
      handlers: [TAG_NOTE, CHECK_TITLE, ADAPTER],
      map: MAP,
      validators: VALIDATORS,
      cache: CACHE,
    })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    const written = manifest(projectDir)
    assert.deepEqual(written["validators"], VALIDATORS)
    assert.deepEqual(written["cache"], CACHE)
    assert.ok(existsSync(join(projectDir, "hooks", "check-title", "index.ts")))
  })

  test("removes a map sent empty, and leaves one not sent as it is", async () => {
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [CHECK_TITLE], map: {}, validators: VALIDATORS, cache: CACHE })
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [], map: {}, cache: {} })
    assert.equal(res.status, 200)
    const written = manifest(projectDir)
    assert.equal("cache" in written, false)
    assert.deepEqual(written["validators"], VALIDATORS)
  })

  test("refuses a validator map naming a function that was not uploaded, and writes nothing", async () => {
    const before = tree(tmp)
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [], map: {}, validators: VALIDATORS })
    assert.equal(res.status, 400)
    assert.match(String(res.json["message"]), /check-title/)
    assert.deepEqual(tree(tmp), before)
  })

  test("refuses a cache map whose settings are not the manifest's", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [], map: {}, cache: { note: { maxTtl: "60" } } })
    assert.equal(res.status, 400)
  })

  test("answers another project ref as unknown", async () => {
    const res = await request(baseUrl, "POST", "/projects/other/hooks/deploy", { handlers: [], map: {} })
    assert.equal(res.status, 404)
  })
})
