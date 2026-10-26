import { strict as assert } from "node:assert"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { test, describe, before, after } from "node:test"
import { dataString, dataStrings, jsonObject, request, startServer, type ControlPlaneServer } from "./helpers.js"
import { resetEngineCapabilities } from "../src/engine-runner.js"

const PROJECT = "test-project"
const MOCK_ENGINE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-engine.mjs")

describe("schema routes (mock engine)", () => {
  let baseUrl: string
  let server: ControlPlaneServer

  before(async () => {
    process.env["SUPATYPE_ENGINE_MOCK"] = MOCK_ENGINE
    process.env["DATABASE_URL"] = "postgres://mock/mock/mock"
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT

    ;({ server, baseUrl } = await startServer())
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
    const data = res.json["data"]
    if (!Array.isArray(data)) assert.fail("expected a list of migrations")
    assert.equal(jsonObject(data[0])["name"], "20240101_test")
  })

  test("GET /schema/migrations/:name/sources returns snapshot", async () => {
    const res = await request(
      baseUrl,
      "GET",
      `/projects/${PROJECT}/schema/migrations/20240101_test/sources`,
    )
    assert.equal(res.status, 200)
    assert.equal(dataString(res.json, "name"), "20240101_test")
    assert.ok(dataString(res.json, "schema_sources_base64"))
  })

  /** The engine arguments the mock was run with for this request. */
  const argsOf = (json: Record<string, unknown>): string[] => dataStrings(json, "args")

  test("GET /schema/capabilities proxies the engine's answer", async () => {
    resetEngineCapabilities()
    const res = await request(baseUrl, "GET", `/projects/${PROJECT}/schema/capabilities`)
    assert.equal(res.status, 200)
    const features = dataStrings(res.json, "features")
    assert.ok(features.includes("accept_access_drift"))
    assert.ok(features.includes("adopt_none"))
  })

  test("GET /schema/capabilities is empty for an engine from before the subcommand", async () => {
    resetEngineCapabilities()
    process.env["MOCK_ENGINE_NO_CAPABILITIES"] = "1"
    try {
      const res = await request(baseUrl, "GET", `/projects/${PROJECT}/schema/capabilities`)
      assert.equal(res.status, 200)
      assert.deepEqual(res.json.data, { features: [] })
    } finally {
      delete process.env["MOCK_ENGINE_NO_CAPABILITIES"]
      resetEngineCapabilities()
    }
  })

  test("POST /schema/push forwards overwrite_drift", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/push`, {
      ast: {},
      force: true,
      overwrite_drift: true,
    })
    assert.equal(res.status, 200)
    assert.ok(argsOf(res.json).includes("--overwrite-drift"))
    const plain = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/push`, { ast: {}, force: true })
    assert.ok(!argsOf(plain.json).includes("--overwrite-drift"))
  })

  /** The value after `flag` in the engine's arguments, or undefined when the flag is absent. */
  const flagValue = (args: string[], flag: string): string | undefined => {
    const at = args.indexOf(flag)
    return at === -1 ? undefined : args[at + 1]
  }

  // The audit trail: only the gateway reaches this control plane (the shared secret), and the
  // gateway forwards only a caller holding the service role. That is the identity recorded, as
  // verified; whoever the client says it is, is not.
  test("POST /schema/push records the service role as the verified author, ignoring the client's claim", async () => {
    resetEngineCapabilities()
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/push`, {
      ast: {},
      pushed_by: "Mallory <mallory@example.com>",
      pushed_by_verified: true,
      pushed_via: "cli",
      pushed_from: "mallorys-laptop",
    })
    assert.equal(res.status, 200)
    const args = argsOf(res.json)
    assert.equal(flagValue(args, "--pushed-by"), "service_role")
    assert.equal(flagValue(args, "--pushed-via"), "self-host")
    assert.ok(args.includes("--pushed-by-verified"))
    assert.ok(!args.join(" ").includes("Mallory"), args.join(" "))
    // Where the push came from is context, not identity: the client's word is kept.
    assert.equal(flagValue(args, "--pushed-from"), "mallorys-laptop")
  })

  test("POST /schema/push sends no audit flag to an engine from before them", async () => {
    resetEngineCapabilities()
    process.env["MOCK_ENGINE_NO_AUDIT"] = "1"
    try {
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/push`, { ast: {}, pushed_by: "x" })
      assert.equal(res.status, 200)
      assert.ok(!argsOf(res.json).some((a) => a.startsWith("--pushed")))
    } finally {
      delete process.env["MOCK_ENGINE_NO_AUDIT"]
      resetEngineCapabilities()
    }
  })

  test("POST /schema/adopt forwards keys, release and reclaim", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/adopt`, {
      ast: {},
      yes: true,
      keys: ["table:posts", "column:posts.note"],
      release: ["policy:posts.read"],
      reclaim: ["index:posts.idx"],
    })
    assert.equal(res.status, 200)
    const args = argsOf(res.json)
    assert.deepEqual(
      args.slice(args.indexOf("--yes")),
      ["--yes", "--release", "policy:posts.read", "--reclaim", "index:posts.idx", "--key", "table:posts", "--key", "column:posts.note"],
    )
  })

  test("POST /schema/adopt with keys: [] adopts none, never every conflict", async () => {
    const none = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/adopt`, {
      ast: {},
      yes: true,
      keys: [],
      release: ["policy:posts.read"],
    })
    assert.ok(argsOf(none.json).includes("--adopt-none"))
    assert.ok(!argsOf(none.json).includes("--key"))
    const all = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/adopt`, { ast: {}, yes: true })
    assert.ok(!argsOf(all.json).includes("--adopt-none"))
  })

  test("POST /schema/doctor forwards rebaseline and accept_access_drift", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/doctor`, {
      ast: {},
      rebaseline: true,
      accept_access_drift: true,
    })
    assert.equal(res.status, 200)
    const args = argsOf(res.json)
    assert.ok(args.includes("--rebaseline"))
    assert.ok(args.includes("--accept-access-drift"))
    assert.ok(!args.includes("--overwrite-drift"))
    const report = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/doctor`, { ast: {} })
    assert.ok(!argsOf(report.json).includes("--rebaseline"))
  })

  test("POST /schema/doctor forwards a rebaseline's previewed keys, each as --key (F29)", async () => {
    const keys = ["policy:note.note_select", "table:note"]
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/doctor`, { ast: {}, rebaseline: true, keys })
    assert.equal(res.status, 200)
    const args = argsOf(res.json)
    assert.deepEqual(args.slice(args.indexOf("--rebaseline")), ["--rebaseline", "--key", keys[0], "--key", keys[1]])
    // Keys mean nothing without a rebaseline, and the binary refuses them there.
    const report = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/doctor`, { ast: {}, keys })
    assert.ok(!argsOf(report.json).includes("--key"))
  })

  test("POST /schema/doctor refuses an empty key list, which the binary would read as every drifted object", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/doctor`, { ast: {}, rebaseline: true, keys: [] })
    assert.equal(res.status, 400)
  })

  test("a drift_changed refusal is a 409 naming what is new and what is gone (F29)", async () => {
    process.env["MOCK_ENGINE_REFUSE"] = "drift_changed"
    try {
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/doctor`, {
        ast: {},
        rebaseline: true,
        keys: ["policy:note.note_select"],
      })
      assert.equal(res.status, 409)
      assert.equal(res.json["reason"], "drift_changed")
      assert.deepEqual(res.json["unseen"], ["policy:tag.tag_select"])
      assert.deepEqual(res.json["gone"], [])
      assert.match(String(res.json["message"]), /drift changed after the preview/)
    } finally {
      delete process.env["MOCK_ENGINE_REFUSE"]
    }
  })

  test("a refusal the engine names is a 409 with its reason", async () => {
    process.env["MOCK_ENGINE_REFUSE"] = "security_drift"
    try {
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/push`, { ast: {} })
      assert.equal(res.status, 409)
      assert.equal(res.json["reason"], "security_drift")
      assert.ok(Array.isArray(res.json["objects"]))
      assert.match(String(res.json["message"]), /changed outside Supatype/)
    } finally {
      delete process.env["MOCK_ENGINE_REFUSE"]
    }
  })

  test("a busy engine is a 409 engine_busy with the engine's own sentence", async () => {
    process.env["MOCK_ENGINE_REFUSE"] = "engine_busy"
    try {
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/adopt`, { ast: {}, yes: true })
      assert.equal(res.status, 409)
      assert.equal(res.json["reason"], "engine_busy")
      assert.equal(
        res.json["message"],
        "another push, adopt or rebaseline is running on this database; try again. Nothing was applied.",
      )
    } finally {
      delete process.env["MOCK_ENGINE_REFUSE"]
    }
  })

  test("POST /schema/rollback applies rollback", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/schema/rollback`, {})
    assert.equal(res.status, 200)
    assert.equal(dataString(res.json, "status"), "rolled_back")
  })

  /** Run `work` with the mock engine refusing with `reason`, as an engine from before reasons when `wordsOnly`. */
  async function refusing<T>(reason: string, wordsOnly: boolean, work: () => Promise<T>): Promise<T> {
    process.env["MOCK_ENGINE_REFUSE"] = reason
    if (wordsOnly) process.env["MOCK_ENGINE_WORDS_ONLY"] = "1"
    try {
      return await work()
    } finally {
      delete process.env["MOCK_ENGINE_REFUSE"]
      delete process.env["MOCK_ENGINE_WORDS_ONLY"]
    }
  }

  const sourcesPath = `/projects/${PROJECT}/schema/migrations/20240101_test/sources`

  for (const wordsOnly of [false, true]) {
    const engine = wordsOnly ? "an engine from before the reason, by its wording" : "by its reason"
    test(`a migration with no schema snapshot is a 404 naming no_schema_snapshot, ${engine} (CL3)`, async () => {
      const res = await refusing("no_schema_snapshot", wordsOnly, () => request(baseUrl, "GET", sourcesPath))
      assert.equal(res.status, 404)
      assert.equal(res.json["error"], "not_found")
      assert.equal(res.json["code"], "no_schema_snapshot")
      assert.match(String(res.json["message"]), /20240101_test/)
    })

    for (const reason of ["no_applied_migration", "no_rollback_sql"]) {
      test(`a rollback refused with ${reason} is a 409 naming it, ${engine} (CL3)`, async () => {
        const res = await refusing(reason, wordsOnly, () =>
          request(baseUrl, "POST", `/projects/${PROJECT}/schema/rollback`, {}),
        )
        assert.equal(res.status, 409)
        assert.equal(res.json["reason"], reason)
        assert.equal(res.json["code"], reason)
        assert.ok(String(res.json["message"]).length > 0)
      })
    }
  }
})
