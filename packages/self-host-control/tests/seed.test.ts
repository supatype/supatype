import { strict as assert } from "node:assert"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test, describe, before, after, beforeEach } from "node:test"
import { isJsonObject, isString } from "@supatype/shared"
import { REMOTE_SEED_MAX_BODY_BYTES, REMOTE_SEED_MAX_FILES, type RemoteSeedRequest } from "@supatype/types"
import { CONTROL_PLANE_SECRET_HEADER } from "../src/auth.js"
import { setAuditWriter, type AuditEntry } from "../src/audit.js"
import { resetEngineCapabilities } from "../src/engine-runner.js"
import { jsonObject, startServer, TEST_SECRET, type ControlPlaneServer } from "./helpers.js"

const PROJECT = "test-project"
const MOCK_ENGINE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-engine.mjs")
const PASSWORD = "s3cretpw"
const DSN = `postgres://seeduser:${PASSWORD}@db.internal:5432/app`

/** What the mock engine saw, as it wrote it down. */
interface Recorded {
  argv: string[]
  databaseUrl: string
  irs: Array<{ path: string; text: string }>
  inputPath: string | null
}

function recordedFrom(value: unknown): Recorded {
  const record = jsonObject(value)
  const { argv, databaseUrl, irs, inputPath } = record
  if (!Array.isArray(argv) || !argv.every(isString)) assert.fail("no argv recorded")
  if (typeof databaseUrl !== "string") assert.fail("no DATABASE_URL recorded")
  if (!Array.isArray(irs)) assert.fail("no ir files recorded")
  const files = irs.map((ir) => {
    const one = jsonObject(ir)
    if (typeof one["path"] !== "string" || typeof one["text"] !== "string") assert.fail("bad ir record")
    return { path: one["path"], text: one["text"] }
  })
  return { argv, databaseUrl, irs: files, inputPath: typeof inputPath === "string" ? inputPath : null }
}

function seedBody(over: Partial<RemoteSeedRequest> = {}): RemoteSeedRequest {
  return {
    ast: { models: [] },
    irDocuments: [JSON.stringify({ file: "seeds/a.ts", groups: [] }), JSON.stringify({ file: "seeds/b.ts", groups: [] })],
    atomic: false,
    runOnce: false,
    confirmProduction: true,
    ...over,
  }
}

describe("seed routes (mock engine)", () => {
  let baseUrl: string
  let server: ControlPlaneServer
  let dir: string
  let recordPath: string
  let audits: AuditEntry[]

  /** One request, with the raw text kept so a test can look for what must never be in it. */
  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", [CONTROL_PLANE_SECRET_HEADER]: TEST_SECRET, ...headers },
      ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
    })
    const text = await res.text()
    return { status: res.status, json: text === "" ? {} : jsonObject(JSON.parse(text)), text }
  }

  const seed = (body: unknown, headers: Record<string, string> = {}) =>
    call("POST", `/projects/${PROJECT}/seed`, body, headers)

  const recorded = (): Recorded => recordedFrom(JSON.parse(readFileSync(recordPath, "utf8")))

  before(async () => {
    process.env["SUPATYPE_ENGINE_MOCK"] = MOCK_ENGINE
    process.env["DATABASE_URL"] = DSN
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT
    dir = mkdtempSync(join(tmpdir(), "seed-route-test-"))
    recordPath = join(dir, "record.json")
    ;({ server, baseUrl } = await startServer())
  })

  after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
    for (const key of ["SUPATYPE_ENGINE_MOCK", "DATABASE_URL", "SUPATYPE_PROJECT_REF", "MOCK_SEED_RECORD", "MOCK_SEED_MODE", "MOCK_SEED_SLEEP_MS", "SUPATYPE_SEED_TIMEOUT_MS", "MOCK_DIFF_OPS", "MOCK_DIFF_RECORD"]) {
      delete process.env[key]
    }
  })

  beforeEach(() => {
    rmSync(recordPath, { force: true })
    process.env["MOCK_SEED_RECORD"] = recordPath
    delete process.env["MOCK_SEED_MODE"]
    delete process.env["SUPATYPE_SEED_TIMEOUT_MS"]
    delete process.env["MOCK_DIFF_OPS"]
    delete process.env["MOCK_DIFF_RECORD"]
    audits = []
    setAuditWriter({ record: async (entry) => { audits.push(entry) } })
  })

  test("a request without the gateway secret is refused before the route", async () => {
    const res = await call("POST", `/projects/${PROJECT}/seed`, seedBody(), { [CONTROL_PLANE_SECRET_HEADER]: "wrong" })
    assert.equal(res.status, 401)
    assert.equal(existsSync(recordPath), false)
  })

  test("applies the seed and answers the engine result with a run id", async () => {
    const res = await seed(seedBody())
    assert.equal(res.status, 200, res.text)
    const data = jsonObject(res.json["data"])
    assert.equal(data["ok"], true)
    assert.ok(typeof jsonObject(res.json["run"])["id"] === "string")
  })

  test("an unknown project is a 404, and so is an environment this server does not have", async () => {
    const wrongRef = await call("POST", "/projects/other/seed", seedBody())
    assert.equal(wrongRef.status, 404)
    const wrongEnv = await seed(seedBody(), { "X-Supatype-Environment": "staging" })
    assert.equal(wrongEnv.status, 404)
    assert.equal(existsSync(recordPath), false)
    const named = await seed(seedBody(), { "X-Supatype-Environment": "production" })
    assert.equal(named.status, 200)
  })

  test("the engine gets each document byte for byte, the flags as asked, and the DSN in its environment only", async () => {
    const docs = [`{"file":"seeds/a.ts",  "groups":[ ]}\n`, `{"groups":[],"file":"seeds/b.ts"}`]
    const res = await seed(seedBody({ irDocuments: docs, atomic: true, runOnce: true, environment: "production" }))
    assert.equal(res.status, 200, res.text)
    const saw = recorded()
    assert.deepEqual(saw.irs.map((ir) => ir.text), docs)
    assert.equal(saw.argv.filter((a) => a === "--ir").length, 2)
    assert.ok(saw.argv.includes("--atomic"))
    assert.ok(saw.argv.includes("--run-once"))
    assert.equal(saw.argv[saw.argv.indexOf("--environment") + 1], "production")
    assert.equal(saw.databaseUrl, DSN)
    assert.equal(saw.argv.some((a) => a.includes(PASSWORD) || a.includes("postgres://")), false)
    assert.equal(res.text.includes(PASSWORD), false)
  })

  test("without the flags the engine is not asked for them", async () => {
    await seed(seedBody())
    const saw = recorded()
    assert.equal(saw.argv.includes("--atomic"), false)
    assert.equal(saw.argv.includes("--run-once"), false)
  })

  test("a schema the database does not have yet is refused with schema_not_pushed, and nothing is seeded", async () => {
    process.env["MOCK_DIFF_OPS"] = JSON.stringify([{ type: "add_column", table: "post", column: "subtitle" }])
    const res = await seed(seedBody())
    assert.equal(res.status, 409, res.text)
    assert.equal(res.json["error"], "schema_not_pushed")
    assert.match(String(res.json["message"]), /supatype push/)
    assert.equal(existsSync(recordPath), false)
    assert.equal(audits.at(-1)?.action, "seed.refused")
  })

  test("the schema check asks the engine with the DSN in its environment only", async () => {
    const diffRecord = join(dir, "diff.json")
    process.env["MOCK_DIFF_RECORD"] = diffRecord
    assert.equal((await seed(seedBody())).status, 200)
    const saw: unknown = JSON.parse(readFileSync(diffRecord, "utf8"))
    if (!isJsonObject(saw) || !Array.isArray(saw["argv"])) assert.fail("no diff record")
    assert.equal(saw["databaseUrl"], DSN)
    assert.equal(saw["argv"].some((a) => String(a).includes("postgres://")), false)
  })

  test("temp files are removed after a run, a failed one included", async () => {
    await seed(seedBody())
    const ok = recorded()
    for (const path of [...ok.irs.map((ir) => ir.path), ...(ok.inputPath === null ? [] : [ok.inputPath])]) {
      assert.equal(existsSync(path), false, path)
    }
    process.env["MOCK_SEED_MODE"] = "crash"
    await seed(seedBody())
    const crashed = recorded()
    assert.ok(crashed.irs.length > 0)
    for (const ir of crashed.irs) assert.equal(existsSync(ir.path), false, ir.path)
  })

  test("engine exit 1 and exit 2 with a JSON result are 200 answers", async () => {
    process.env["MOCK_SEED_MODE"] = "fail1"
    const one = await seed(seedBody())
    assert.equal(one.status, 200, one.text)
    assert.equal(jsonObject(jsonObject(one.json["data"])["error"])["kind"], "constraint")
    process.env["MOCK_SEED_MODE"] = "fail2"
    const two = await seed(seedBody())
    assert.equal(two.status, 200, two.text)
    assert.equal(jsonObject(jsonObject(two.json["data"])["error"])["kind"], "connection")
  })

  test("an engine crash or an answer with no JSON is a 502 with the credentials redacted", async () => {
    process.env["MOCK_SEED_MODE"] = "crash"
    const crash = await seed(seedBody())
    assert.equal(crash.status, 502)
    assert.equal(crash.text.includes(PASSWORD), false, crash.text)
    process.env["MOCK_SEED_MODE"] = "nojson"
    const empty = await seed(seedBody())
    assert.equal(empty.status, 502)
  })

  test("production without confirmProduction is a 409 and the engine never runs", async () => {
    const res = await seed(seedBody({ confirmProduction: false }))
    assert.equal(res.status, 409)
    assert.equal(res.json["error"], "production_confirmation_required")
    assert.equal(existsSync(recordPath), false)
  })

  test("an environment that differs from the target is refused before the engine", async () => {
    const res = await seed(seedBody({ environment: "staging" }))
    assert.equal(res.status, 400)
    assert.equal(res.json["error"], "environment_mismatch")
    assert.equal(existsSync(recordPath), false)
  })

  test("a malformed body is a 400 validation_error", async () => {
    const res = await seed({ ast: {}, irDocuments: [], atomic: false, runOnce: false, confirmProduction: true })
    assert.equal(res.status, 400)
    assert.equal(res.json["error"], "validation_error")
  })

  test("more files than the cap is a 413 and the engine never runs", async () => {
    const docs = Array.from({ length: REMOTE_SEED_MAX_FILES + 1 }, (_, i) => JSON.stringify({ file: `f${i}.ts` }))
    const res = await seed(seedBody({ irDocuments: docs }))
    assert.equal(res.status, 413)
    assert.equal(res.json["error"], "payload_too_large")
    assert.equal(existsSync(recordPath), false)
  })

  test("a body over the byte cap is a 413 and the engine never runs", async () => {
    const big = JSON.stringify({ file: "big.ts", pad: "x".repeat(REMOTE_SEED_MAX_BODY_BYTES) })
    const res = await seed(seedBody({ irDocuments: [big] }))
    assert.equal(res.status, 413)
    assert.equal(res.json["error"], "payload_too_large")
    assert.equal(existsSync(recordPath), false)
  })

  test("a second seed while one runs is a 409 seed_busy, and the lock is released after", async () => {
    process.env["MOCK_SEED_MODE"] = "sleep"
    process.env["MOCK_SEED_SLEEP_MS"] = "600"
    const first = seed(seedBody())
    await new Promise((r) => setTimeout(r, 250))
    const second = await seed(seedBody())
    assert.equal(second.status, 409)
    assert.equal(second.json["error"], "seed_busy")
    assert.equal((await first).status, 200)
    delete process.env["MOCK_SEED_MODE"]
    assert.equal((await seed(seedBody())).status, 200)
  })

  test("an engine that runs past the kill timer is a 502, and the lock is released", async () => {
    process.env["MOCK_SEED_MODE"] = "sleep"
    process.env["MOCK_SEED_SLEEP_MS"] = "5000"
    process.env["SUPATYPE_SEED_TIMEOUT_MS"] = "300"
    const res = await seed(seedBody())
    assert.equal(res.status, 502)
    assert.match(String(res.json["message"]), /timed out/i)
    delete process.env["MOCK_SEED_MODE"]
    assert.equal((await seed(seedBody())).status, 200)
  })

  test("applied, failed and refused runs are each audited, without the DSN or any row data", async () => {
    await seed(seedBody({ pushedFrom: "ci-runner", runOnce: true }))
    process.env["MOCK_SEED_MODE"] = "fail1"
    await seed(seedBody())
    await seed(seedBody({ confirmProduction: false }))
    assert.deepEqual(audits.map((a) => a.action), ["seed.applied", "seed.failed", "seed.refused"])
    const applied = audits[0]!.detail
    assert.equal(applied["environment"], "production")
    assert.equal(applied["pushedFrom"], "ci-runner")
    assert.equal(applied["runOnce"], true)
    assert.equal(applied["atomic"], false)
    assert.ok(typeof applied["runId"] === "string")
    const files = applied["files"]
    if (!Array.isArray(files)) assert.fail("no files in the audit detail")
    assert.equal(jsonObject(files[0])["file"], "seeds/a.ts")
    assert.match(String(jsonObject(files[0])["hash"]), /^[0-9a-f]{64}$/)
    assert.equal(audits[2]!.detail["reason"], "production_confirmation_required")
    const everything = JSON.stringify(audits)
    assert.equal(everything.includes(PASSWORD), false)
    assert.equal(everything.includes("groups"), false)
  })

  test("capabilities lists seed", async () => {
    resetEngineCapabilities()
    const res = await call("GET", `/projects/${PROJECT}/schema/capabilities`)
    const features = jsonObject(res.json["data"])["features"]
    if (!Array.isArray(features)) assert.fail("no features")
    assert.ok(features.includes("seed"))
  })

  test("GET /seed/status runs the engine status and answers its document", async () => {
    const res = await call("GET", `/projects/${PROJECT}/seed/status`)
    assert.equal(res.status, 200, res.text)
    const files = jsonObject(res.json["data"])["files"]
    assert.ok(Array.isArray(files) && isJsonObject(files[0]))
    const saw = recorded()
    assert.ok(saw.argv.includes("--status"))
    assert.equal(saw.databaseUrl, DSN)
    assert.equal(saw.argv.some((a) => a.includes(PASSWORD)), false)
    assert.equal(res.text.includes(PASSWORD), false)
  })

  test("GET /seed/status for another environment or project is a 404", async () => {
    assert.equal((await call("GET", `/projects/${PROJECT}/seed/status`, undefined, { "X-Supatype-Environment": "staging" })).status, 404)
    assert.equal((await call("GET", "/projects/other/seed/status")).status, 404)
  })
})
