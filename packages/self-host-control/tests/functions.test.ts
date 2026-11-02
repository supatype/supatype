import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, existsSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test, describe, before, after } from "node:test"
import { dataOf, fakeDocker, request, startServer, type ControlPlaneServer, type FakeDocker } from "./helpers.js"

const PROJECT = "test-project"

/** Every entry under `dir`, relative to it, so a test can show nothing new appeared anywhere. */
function tree(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const rel = `${prefix}${d.name}`
    return d.isDirectory() ? [rel, ...tree(join(dir, d.name), `${rel}/`)] : [rel]
  })
}

describe("functions routes", () => {
  let baseUrl: string
  let server: ControlPlaneServer
  let tmp: string
  let projectDir: string
  let docker: FakeDocker

  before(async () => {
    // The project lives one level down so a name that climbs out of it still lands inside `tmp`.
    tmp = mkdtempSync(join(tmpdir(), "sh-functions-test-"))
    projectDir = join(tmp, "proj")
    mkdirSync(join(projectDir, "functions"), { recursive: true })
    writeFileSync(join(projectDir, "keep.txt"), "project file", "utf8")
    process.env["SUPATYPE_PROJECT_ROOT"] = projectDir
    process.env["SUPATYPE_PROJECT_REF"] = PROJECT
    process.env["COMPOSE_PROJECT_NAME"] = "supatype-self-host-control-test-none"

    docker = fakeDocker()
    ;({ server, baseUrl } = await startServer())
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
    assert.ok(existsSync(join(projectDir, "functions", "hello-world_2.ts")))

    const listed = await request(baseUrl, "GET", `/projects/${PROJECT}/functions`)
    assert.deepEqual(listed.json["data"], [{ name: "hello-world_2" }])

    const deleted = await request(baseUrl, "DELETE", `/projects/${PROJECT}/functions/hello-world_2`)
    assert.equal(deleted.status, 200)
    assert.ok(!existsSync(join(projectDir, "functions", "hello-world_2.ts")))
    assert.ok(existsSync(join(projectDir, "keep.txt")))
  })

  // Review r8 C13: every env call hashed the worker's code, which took the env commands seconds on a
  // large project. An env change never needs a restart, so the env routes only check the worker runs.
  test("env set does not look at the code, even code changed on disk; the next deploy does", async () => {
    await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, { functions: [{ name: "edited-on-disk", source: "export default 1" }] })
    writeFileSync(join(projectDir, "functions", "edited-on-disk.ts"), "export default 2\n")
    docker.calls.length = 0
    assert.equal((await request(baseUrl, "POST", `/projects/${PROJECT}/functions/env`, { key: "C13", value: "v" })).status, 200)
    assert.deepEqual(docker.calls.map((args) => args[0]), ["ps"])
    await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, { functions: [{ name: "edited-on-disk", source: "export default 2\n" }] })
    assert.equal(docker.calls.filter((args) => args[0] === "restart").length, 1)
    await request(baseUrl, "DELETE", `/projects/${PROJECT}/functions/env/C13`)
  })

  // Review r8 A1: the deploy ignored serviceRole, so a route taken off functions.serviceRole kept the
  // key on a self-hosted stack. It writes the list the worker reads on every call, wholesale.
  test("deploy writes the service-role list it carries, an empty one too, and leaves it when none is sent", async () => {
    const routesFile = join(projectDir, ".supatype", "service-role-routes")
    const deploy = (extra: Record<string, unknown>) =>
      request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, { functions: [{ name: "granted", source: "export default 1" }], ...extra })
    assert.equal((await deploy({ serviceRole: ["granted", "other"] })).status, 200)
    assert.equal(readFileSync(routesFile, "utf8"), "granted,other")
    assert.equal((await deploy({})).status, 200)
    assert.equal(readFileSync(routesFile, "utf8"), "granted,other")
    assert.equal((await deploy({ serviceRole: [] })).status, 200)
    assert.equal(readFileSync(routesFile, "utf8"), "")
  })

  test("deploy refuses a service-role entry that is not a function name, and writes nothing", async () => {
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, {
      functions: [{ name: "granted", source: "export default 1" }],
      serviceRole: ["a,b"],
    })
    assert.equal(res.status, 400, JSON.stringify(res.json))
  })

  // Review r8 A3: a single-file function was written back as <name>/index.ts beside the project's
  // <name>.ts, two routes for one name. It is written in the form the project keeps, never both.
  describe("the form a function is written back in", () => {
    const fns = (): string => join(projectDir, "functions")
    const deploy = (fn: Record<string, unknown>) => request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, { functions: [fn] })

    test("a single file where the project keeps <name>.ts, and no directory beside it", async () => {
      writeFileSync(join(fns(), "kept-file.ts"), "export default 0\n")
      assert.equal((await deploy({ name: "kept-file", source: "export default 1\n" })).status, 200)
      assert.equal(readFileSync(join(fns(), "kept-file.ts"), "utf8"), "export default 1\n")
      assert.equal(existsSync(join(fns(), "kept-file")), false)
    })

    test("a single file where the project keeps <name>/: its index.ts", async () => {
      mkdirSync(join(fns(), "kept-dir"), { recursive: true })
      writeFileSync(join(fns(), "kept-dir", "index.ts"), "export default 0\n")
      assert.equal((await deploy({ name: "kept-dir", source: "export default 1\n" })).status, 200)
      assert.equal(readFileSync(join(fns(), "kept-dir", "index.ts"), "utf8"), "export default 1\n")
      assert.equal(existsSync(join(fns(), "kept-dir.ts")), false)
    })

    test("a directory deploy where the project keeps <name>.ts: the directory, and no <name>.ts", async () => {
      writeFileSync(join(fns(), "grew.ts"), "export default 0\n")
      const res = await deploy({ name: "grew", source: "export default 1\n", files: { "index.ts": "export default 1\n", "lib/a.ts": "export const a = 1\n" } })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(readFileSync(join(fns(), "grew", "lib", "a.ts"), "utf8"), "export const a = 1\n")
      assert.equal(existsSync(join(fns(), "grew.ts")), false)
    })

    test("a single file where the project has both: <name>.ts, and the directory is gone", async () => {
      writeFileSync(join(fns(), "both.ts"), "export default 0\n")
      mkdirSync(join(fns(), "both"), { recursive: true })
      writeFileSync(join(fns(), "both", "index.ts"), "export default 0\n")
      assert.equal((await deploy({ name: "both", source: "export default 1\n" })).status, 200)
      assert.equal(readFileSync(join(fns(), "both.ts"), "utf8"), "export default 1\n")
      assert.equal(existsSync(join(fns(), "both")), false)
    })

    // Review r9 A-5: the other form's directory was removed whole, notes and data included. Only what
    // the worker loads goes, and the directory only when nothing is left in it.
    test("a single file where the project has both keeps the directory's files the worker does not load", async () => {
      writeFileSync(join(fns(), "both-notes.ts"), "export default 0\n")
      mkdirSync(join(fns(), "both-notes", "lib"), { recursive: true })
      writeFileSync(join(fns(), "both-notes", "index.ts"), "export default 0\n")
      writeFileSync(join(fns(), "both-notes", "lib", "a.ts"), "export const a = 0\n")
      writeFileSync(join(fns(), "both-notes", "README.md"), "notes\n")
      writeFileSync(join(fns(), "both-notes", "rates.csv"), "a,1\n")
      assert.equal((await deploy({ name: "both-notes", source: "export default 1\n" })).status, 200)
      for (const gone of ["index.ts", "lib/a.ts"]) assert.equal(existsSync(join(fns(), "both-notes", gone)), false, gone)
      for (const kept of ["README.md", "rates.csv"]) assert.equal(existsSync(join(fns(), "both-notes", kept)), true, kept)
    })

    // Review r9 A-4: a redeploy of fewer files left the old ones, which the worker still loaded.
    test("a directory redeploy removes the source files it no longer sends, and keeps the rest", async () => {
      const files = { "index.ts": "export default 1\n", "lib/old.ts": "export const old = 1\n" }
      assert.equal((await deploy({ name: "shrinks", source: files["index.ts"], files })).status, 200)
      writeFileSync(join(fns(), "shrinks", "README.md"), "notes\n")
      assert.equal((await deploy({ name: "shrinks", source: files["index.ts"], files: { "index.ts": files["index.ts"] } })).status, 200)
      assert.equal(existsSync(join(fns(), "shrinks", "lib", "old.ts")), false)
      assert.equal(existsSync(join(fns(), "shrinks", "README.md")), true)
      assert.equal(existsSync(join(fns(), "shrinks", "index.ts")), true)
    })

    // Review r8 A2: deleting a single-file function removed only <name>/, so <name>.ts stayed served.
    test("delete removes the function in whichever form it is kept, both when both are there", async () => {
      writeFileSync(join(fns(), "gone-file.ts"), "export default 0\n")
      writeFileSync(join(fns(), "gone-both.ts"), "export default 0\n")
      mkdirSync(join(fns(), "gone-both"), { recursive: true })
      writeFileSync(join(fns(), "gone-both", "index.ts"), "export default 0\n")
      for (const name of ["gone-file", "gone-both"]) {
        assert.equal((await request(baseUrl, "DELETE", `/projects/${PROJECT}/functions/${name}`)).status, 200)
      }
      for (const left of ["gone-file.ts", "gone-both.ts", "gone-both"]) assert.equal(existsSync(join(fns(), left)), false, left)
    })

    // Review r8 A9: the list named every directory (_shared, .git, one with no index.ts) and missed
    // the functions kept as <name>.ts. It names what the worker serves.
    test("list names exactly the functions the worker serves", async () => {
      mkdirSync(join(fns(), "_shared"), { recursive: true })
      writeFileSync(join(fns(), "_shared", "util.ts"), "export {}\n")
      mkdirSync(join(fns(), ".git"), { recursive: true })
      mkdirSync(join(fns(), "no-entry"), { recursive: true })
      writeFileSync(join(fns(), "types.d.ts"), "export {}\n")
      writeFileSync(join(fns(), "listed-file.ts"), "export default 0\n")
      mkdirSync(join(fns(), "listed-dir"), { recursive: true })
      writeFileSync(join(fns(), "listed-dir", "index.ts"), "export default 0\n")
      const listed: unknown = (await request(baseUrl, "GET", `/projects/${PROJECT}/functions`)).json["data"]
      assert.ok(Array.isArray(listed), JSON.stringify(listed))
      const names = listed.map((entry: unknown) => (typeof entry === "object" && entry !== null && "name" in entry ? entry.name : entry))
      for (const name of ["listed-file", "listed-dir"]) assert.ok(names.includes(name), `${name} in ${JSON.stringify(names)}`)
      for (const name of ["_shared", ".git", "no-entry", "types", "types.d"]) assert.ok(!names.includes(name), `${name} not in ${JSON.stringify(names)}`)
    })
  })

  // `supatype functions env unset` on a self-host link was refused: the control plane had no route.
  test("env unset removes the key, and only checks the worker runs", async () => {
    const envFile = join(projectDir, ".supatype", "function-env.json")
    await request(baseUrl, "POST", `/projects/${PROJECT}/functions/env`, { key: "GONE SOON", value: "1" })
    await request(baseUrl, "POST", `/projects/${PROJECT}/functions/env`, { key: "KEPT", value: "2" })
    docker.calls.length = 0
    const res = await request(baseUrl, "DELETE", `/projects/${PROJECT}/functions/env/${encodeURIComponent("GONE SOON")}`)
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.deepEqual(JSON.parse(readFileSync(envFile, "utf8")), { KEPT: "2" })
    assert.deepEqual(docker.calls.map((args) => args[0]), ["ps"])
  })

  // Nic's decision on N28a (a): the worker reads every env file on each call, so an env change is
  // seen on the next call (functions-worker env-file.test.ts) and restarting for it only took every
  // function down. Code it loads once at start still restarts it.
  test("restarts nothing for an env change, in the control plane's file or the env files, and still restarts for code", async () => {
    const deploy = (source: string) =>
      request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, { functions: [{ name: "env-reader", source }] })
    await deploy("export default 1")
    docker.calls.length = 0
    assert.equal((await request(baseUrl, "POST", `/projects/${PROJECT}/functions/env`, { key: "API_KEY", value: "new" })).status, 200)
    assert.equal((await request(baseUrl, "DELETE", `/projects/${PROJECT}/functions/env/API_KEY`)).status, 200)
    writeFileSync(join(projectDir, "functions", ".env.local"), "SHARED=1\n")
    writeFileSync(join(projectDir, "functions", ".env.env-reader.local"), "OWN=1\n")
    await deploy("export default 1")
    assert.deepEqual(docker.calls.filter((args) => args[0] === "restart"), [])
    await deploy("export default 2")
    assert.deepEqual(docker.calls.filter((args) => args[0] === "restart").length, 1)
  })

  // Review: the worker reads this file (SUPATYPE_FUNCTION_ENV_FILE), so it must be a map of names
  // to string values, the key set by its own name.
  test("env set writes the map of names to values the worker reads", async () => {
    const envFile = join(projectDir, ".supatype", "function-env.json")
    const res = await request(baseUrl, "POST", `/projects/${PROJECT}/functions/env`, { key: "READ_BY_WORKER", value: "yes" })
    assert.equal(res.status, 200)
    assert.match(readFileSync(envFile, "utf8"), /"READ_BY_WORKER": "yes"/)
    await request(baseUrl, "DELETE", `/projects/${PROJECT}/functions/env/READ_BY_WORKER`)
    assert.doesNotMatch(readFileSync(envFile, "utf8"), /READ_BY_WORKER/)
  })

  // Review r7 A2: the list answered every value, secrets included. It answers the names, sorted, as
  // Cloud's does.
  test("env list answers the names only, never a value", async () => {
    await request(baseUrl, "POST", `/projects/${PROJECT}/functions/env`, { key: "ZED_SECRET", value: "s3cr3t-z" })
    await request(baseUrl, "POST", `/projects/${PROJECT}/functions/env`, { key: "ALPHA_SECRET", value: "s3cr3t-a" })
    const res = await request(baseUrl, "GET", `/projects/${PROJECT}/functions/env`)
    assert.equal(res.status, 200)
    const names: unknown = res.json["data"]
    assert.ok(Array.isArray(names), JSON.stringify(res.json))
    assert.deepEqual(names.filter((name) => name === "ALPHA_SECRET" || name === "ZED_SECRET"), ["ALPHA_SECRET", "ZED_SECRET"])
    assert.doesNotMatch(JSON.stringify(res.json), /s3cr3t/)
  })

  test("env unset of a key not set answers 200 with a warning when Docker cannot be reached", async () => {
    await request(baseUrl, "POST", `/projects/${PROJECT}/functions/env`, { key: "SETTLED", value: "v" })
    docker.psStatus = 1
    docker.psSays = "Cannot connect to the Docker daemon"
    const res = await request(baseUrl, "DELETE", `/projects/${PROJECT}/functions/env/NEVER_SET`)
    docker.psStatus = 0
    assert.equal(res.status, 200, JSON.stringify(res.json))
    assert.match(String(dataOf(res.json)["warning"]), /Cannot connect to the Docker daemon/)
  })

  test("env unset answers 502 with the reason when a stopped worker cannot be started", async () => {
    await request(baseUrl, "POST", `/projects/${PROJECT}/functions/env`, { key: "K2", value: "v" })
    docker.exited = true
    docker.restartStatus = 1
    docker.restartSays = "Error response from daemon: no such container"
    const res = await request(baseUrl, "DELETE", `/projects/${PROJECT}/functions/env/K2`)
    docker.restartStatus = 0
    docker.exited = false
    assert.equal(res.status, 502)
    assert.match(String(res.json["message"]), /no such container/)
  })

  test("env unset of a key not set still makes a restart owed by one that failed", async () => {
    docker.restartStatus = 1
    await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, { functions: [{ name: "owed", source: "export default 3" }] })
    docker.restartStatus = 0
    docker.calls.length = 0
    const res = await request(baseUrl, "DELETE", `/projects/${PROJECT}/functions/env/NEVER_SET`)
    assert.equal(res.status, 200)
    assert.ok(docker.calls.some((args) => args[0] === "restart"))
  })

  // Round 6 N27 (data loss): a directory function reached the control plane as a JSON map of its
  // files in `source`, which was written as its index.ts, over the project's own checkout.
  describe("a function made of several files", () => {
    const ENTRY = 'import { greet } from "./lib/greet.ts"\nexport default () => new Response(greet())\n'
    const LIB = 'export const greet = (): string => "hi"\n'
    const dirOf = (name: string): string => join(projectDir, "functions", name)

    test("writes each file it carries under the function's directory", async () => {
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, {
        functions: [{ name: "multi", source: ENTRY, entrypoint: "multi/index.ts", files: { "index.ts": ENTRY, "lib/greet.ts": LIB } }],
      })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(readFileSync(join(dirOf("multi"), "index.ts"), "utf8"), ENTRY)
      assert.equal(readFileSync(join(dirOf("multi"), "lib", "greet.ts"), "utf8"), LIB)
    })

    test("writes the files of a map an older CLI sent as the source, not the map as index.ts", async () => {
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, {
        functions: [{ name: "legacy", source: JSON.stringify({ "index.ts": ENTRY, "lib\\greet.ts": LIB }) }],
      })
      assert.equal(res.status, 200, JSON.stringify(res.json))
      assert.equal(readFileSync(join(dirOf("legacy"), "index.ts"), "utf8"), ENTRY)
      assert.equal(readFileSync(join(dirOf("legacy"), "lib", "greet.ts"), "utf8"), LIB)
    })

    test("leaves a file whose content is the same untouched", async () => {
      const body = { functions: [{ name: "same", source: ENTRY, files: { "index.ts": ENTRY, "lib/greet.ts": LIB } }] }
      await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, body)
      const lib = join(dirOf("same"), "lib", "greet.ts")
      const before = statSync(lib).mtimeMs
      await new Promise((resolve) => setTimeout(resolve, 20))
      await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, body)
      assert.equal(statSync(lib).mtimeMs, before)
    })

    for (const path of ["../escape.ts", "lib/../../escape.ts", "/abs.ts", "C:\\abs.ts", "\\\\server\\share.ts", "", "lib/"]) {
      test(`refuses the file path ${JSON.stringify(path)} and writes nothing`, async () => {
        const before = tree(tmp)
        const res = await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, {
          functions: [{ name: "unsafe", source: ENTRY, files: { "index.ts": ENTRY, [path]: LIB } }],
        })
        assert.equal(res.status, 400, JSON.stringify(res.json))
        assert.deepEqual(tree(tmp), before)
      })
    }

    test("refuses to write through a link that leaves the function's directory", async (t) => {
      const outside = join(tmp, "outside")
      mkdirSync(outside, { recursive: true })
      mkdirSync(dirOf("linked"), { recursive: true })
      try {
        symlinkSync(outside, join(dirOf("linked"), "lib"), "junction")
      } catch {
        t.skip("this machine cannot make a link")
        return
      }
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, {
        functions: [{ name: "linked", source: ENTRY, files: { "index.ts": ENTRY, "lib/greet.ts": LIB } }],
      })
      assert.equal(res.status, 400, JSON.stringify(res.json))
      assert.equal(existsSync(join(outside, "greet.ts")), false)
    })

    // Review r8 A4 (security): a link that leads nowhere passed the check, which asked existsSync
    // and was told nothing is there, and the write then followed it out of the project.
    test("refuses to write through a link that leads nowhere, and creates nothing at its target", async (t) => {
      const outside = join(tmp, "outside-dangling")
      mkdirSync(dirOf("dangling"), { recursive: true })
      try {
        symlinkSync(join(outside, "evil.ts"), join(dirOf("dangling"), "index.ts"), "file")
      } catch {
        t.skip("this machine cannot make a file link")
        return
      }
      mkdirSync(outside, { recursive: true })
      rmSync(join(outside, "evil.ts"), { force: true })
      const res = await request(baseUrl, "POST", `/projects/${PROJECT}/functions/deploy`, {
        functions: [{ name: "dangling", source: ENTRY, files: { "index.ts": ENTRY, "lib/greet.ts": LIB } }],
      })
      assert.equal(res.status, 400, JSON.stringify(res.json))
      assert.equal(existsSync(join(outside, "evil.ts")), false)
    })
  })

  const routes: Array<[string, string, unknown?]> = [
    ["GET", "/functions"],
    ["POST", "/functions/deploy", { functions: [{ name: "other", source: "x" }] }],
    ["DELETE", "/functions/other"],
    ["GET", "/functions/env"],
    ["POST", "/functions/env", { key: "K", value: "v" }],
    ["DELETE", "/functions/env/K"],
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
