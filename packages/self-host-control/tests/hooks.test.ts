import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { after, before, beforeEach, describe, test } from "node:test"
import { isJsonObject } from "@supatype/shared"
import { dataOf, fakeDocker, request, startServer, type ControlPlaneServer, type FakeDocker } from "./helpers.js"

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
  let docker: FakeDocker

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), "sh-hooks-test-"))
    projectDir = join(tmp, "proj")
    process.env["SUPATYPE_PROJECT_ROOT"] = projectDir
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT
    process.env["COMPOSE_PROJECT_NAME"] = "supatype-self-host-control-test-none"
    docker = fakeDocker()
    ;({ server, baseUrl } = await startServer())
  })

  beforeEach(() => {
    docker.calls.length = 0
    docker.containers = ["worker-1"]
    docker.exited = false
    docker.restartStatus = 0
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

  // Every push restarted the worker and rewrote every file, though nothing had changed.
  // Review: staleness by content, not file times, which clock skew and rsync-kept mtimes defeated.
  test("restarts nothing for a deploy of what the worker already loaded, and writes nothing", async () => {
    const body = { handlers: [TAG_NOTE, ADAPTER], map: MAP, validators: {}, cache: {} }
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, body)
    const handler = join(projectDir, "hooks", "tag-note", "index.ts")
    const manifestFile = join(projectDir, ".supatype", "manifest.json")
    const before = [statSync(handler).mtimeMs, statSync(manifestFile).mtimeMs]
    docker.calls.length = 0
    const again = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, body)
    assert.equal(again.status, 200)
    assert.equal(dataOf(again.json)["restarted"], false)
    assert.deepEqual([statSync(handler).mtimeMs, statSync(manifestFile).mtimeMs], before)
    // One `docker ps` checks the worker runs, and nothing more is asked of Docker.
    assert.deepEqual(docker.calls.map((args) => args[0]), ["ps"])
  })

  // Review: the hash took every file, so a README or an editor's temp file restarted the worker.
  test("restarts nothing for files the worker does not load, and restarts for a module it imports", async () => {
    const body = { handlers: [TAG_NOTE, ADAPTER], map: MAP, validators: {}, cache: {} }
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, body)
    const hookDir = join(projectDir, "hooks", "tag-note")
    writeFileSync(join(hookDir, "README.md"), "notes\n")
    writeFileSync(join(hookDir, "index.ts~"), "backup\n")
    writeFileSync(join(hookDir, ".index.ts.swp"), "swap\n")
    mkdirSync(join(projectDir, "hooks", ".git"), { recursive: true })
    writeFileSync(join(projectDir, "hooks", ".git", "HEAD.ts"), "ref\n")
    const untouched = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, body)
    assert.equal(dataOf(untouched.json)["restarted"], false)
    mkdirSync(join(projectDir, "hooks", "_shared"), { recursive: true })
    writeFileSync(join(projectDir, "hooks", "_shared", "util.ts"), "export const x = 1\n")
    const imported = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, body)
    assert.equal(dataOf(imported.json)["restarted"], true)
  })

  test("restarts for a hook edited on disk before the push, though the push writes nothing", async () => {
    // A stack run from the project's own checkout has the edit before the push sends it.
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [TAG_NOTE, ADAPTER], map: MAP })
    const edited = { name: "tag-note", source: `${TAG_NOTE.source}// edited\n` }
    writeFileSync(join(projectDir, "hooks", "tag-note", "index.ts"), edited.source.split("./_supatype-hooks.ts").join("../_supatype/hooks.ts"))
    const again = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [edited, ADAPTER], map: MAP })
    assert.equal(dataOf(again.json)["restarted"], true)
  })

  test("restarts for a map someone else changed in the manifest", async () => {
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [TAG_NOTE, ADAPTER], map: MAP })
    const edited = manifest(projectDir)
    writeFileSync(join(projectDir, ".supatype", "manifest.json"), JSON.stringify({ ...edited, validators: { note: { title: { function: "tag-note" } } } }))
    const again = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [TAG_NOTE, ADAPTER], map: MAP })
    assert.equal(dataOf(again.json)["restarted"], true)
  })

  // Restarting for every push that carries handlers took every function down on each push.
  test("restarts nothing for a deploy with no handlers whose maps are already there", async () => {
    const body = { handlers: [], map: {}, validators: {}, cache: {} }
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, body)
    const again = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, body)
    assert.equal(dataOf(again.json)["restarted"], false)
  })

  // The server reads the cache map; the worker does not, so a restart buys nothing.
  test("writes a cache-only change without restarting the worker", async () => {
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [], map: {} })
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [], map: {}, cache: { note: { enabled: true } } })
    assert.equal(dataOf(res.json)["restarted"], false)
    assert.deepEqual(manifest(projectDir)["cache"], { note: { enabled: true } })
  })

  // Nic's decision (a): every deploy checks the worker runs, and starts it if not.
  test("starts a worker that has stopped, though what it loads has not changed", async () => {
    const body = { handlers: [TAG_NOTE, ADAPTER], map: MAP }
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, body)
    docker.exited = true
    docker.calls.length = 0
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, body)
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual(docker.calls.filter((args) => args[0] !== "ps"), [["start", "worker-1"]])
    assert.equal(docker.calls.filter((args) => args[0] === "ps").length, 1)
  })

  test("answers 200 with a warning when Docker cannot be reached and nothing needed restarting", async () => {
    const body = { handlers: [TAG_NOTE, ADAPTER], map: MAP }
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, body)
    docker.psStatus = 1
    docker.psSays = "Cannot connect to the Docker daemon"
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, body)
    docker.psStatus = 0
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.equal(dataOf(res.json)["restarted"], false)
    assert.match(String(dataOf(res.json)["warning"]), /Cannot connect to the Docker daemon/)
  })

  test("answers 502 when Docker cannot be reached and the worker needed restarting", async () => {
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [TAG_NOTE, ADAPTER], map: MAP })
    docker.psStatus = 1
    docker.psSays = "Cannot connect to the Docker daemon"
    const edited = { name: "tag-note", source: `${TAG_NOTE.source}// unreachable\n` }
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [edited, ADAPTER], map: MAP })
    docker.psStatus = 0
    assert.equal(res.status, 502)
    assert.match(String(res.json["message"]), /Cannot connect to the Docker daemon/)
  })

  test("starts a worker that has stopped when a deploy changes what it loads", async () => {
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [TAG_NOTE, ADAPTER], map: MAP })
    docker.exited = true
    docker.calls.length = 0
    const edited = { name: "tag-note", source: `${TAG_NOTE.source}// stopped\n` }
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [edited, ADAPTER], map: MAP })
    assert.equal(res.status, 200, JSON.stringify(res.json))
    // Round 6 N29: the restart gives the worker the stop grace compose gives it, above its drain.
    assert.deepEqual(docker.calls.find((args) => args[0] === "restart"), ["restart", "-t", "10", "worker-1"])
  })

  test("keeps a restart owed across a control plane restart, in the project's .supatype", async () => {
    docker.restartStatus = 1
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [TAG_NOTE, ADAPTER], map: MAP })
    assert.ok(existsSync(join(projectDir, ".supatype", "functions-worker-restart-owed")))
    docker.restartStatus = 0
    // Only the file says so: a control plane started since knows nothing else. A deploy that changes
    // nothing still makes the restart, then clears it.
    rmSync(join(projectDir, "hooks"), { recursive: true, force: true })
    writeFileSync(join(projectDir, ".supatype", "manifest.json"), JSON.stringify({ functions_enabled: true }))
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [], map: {} })
    assert.equal(dataOf(res.json)["restarted"], true)
    assert.equal(existsSync(join(projectDir, ".supatype", "functions-worker-restart-owed")), false)
  })

  test("answers a manifest that is not JSON with 409, as one that is not an object", async () => {
    writeFileSync(join(projectDir, ".supatype", "manifest.json"), "{ not json")
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [], map: {} })
    assert.equal(res.status, 409)
  })

  // Local test round 5: the control-plane image has Docker without the compose plugin, so `docker
  // compose -p ... restart` failed, unreported: the push said its hooks were deployed and the worker
  // kept serving its old routes.
  test("restarts the worker container its compose labels name, without compose", async () => {
    await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [TAG_NOTE, ADAPTER], map: MAP })
    assert.ok(docker.calls.every((args) => !args.includes("compose")), JSON.stringify(docker.calls))
    const ps = docker.calls.find((args) => args[0] === "ps") ?? []
    assert.ok(ps.includes("label=com.docker.compose.project=supatype-self-host-control-test-none"))
    assert.ok(ps.includes("label=com.docker.compose.service=functions-worker"))
    assert.deepEqual(docker.calls.find((args) => args[0] === "restart"), ["restart", "-t", "10", "worker-1"])
  })

  test("answers 502 with the reason when the worker cannot be restarted, and restarts it next time", async () => {
    docker.restartStatus = 1
    docker.restartSays = "Error response from daemon: no such container"
    const failed = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [TAG_NOTE, ADAPTER], map: MAP })
    assert.equal(failed.status, 502)
    assert.match(String(failed.json["message"]), /no such container/)
    // The files are written by then; the next deploy, though nothing changed, restarts the worker.
    docker.restartStatus = 0
    docker.calls.length = 0
    const again = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [TAG_NOTE, ADAPTER], map: MAP })
    assert.equal(again.status, 200)
    assert.equal(dataOf(again.json)["restarted"], true)
  })

  test("answers 502 saying no worker container exists at all", async () => {
    docker.containers = []
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/hooks/deploy`, { handlers: [TAG_NOTE, ADAPTER], map: MAP })
    assert.equal(res.status, 502)
    assert.match(String(res.json["message"]), /no functions-worker container exists/)
  })

  test("answers another project ref as unknown", async () => {
    const res = await request(baseUrl, "POST", "/projects/other/hooks/deploy", { handlers: [], map: {} })
    assert.equal(res.status, 404)
  })
})
