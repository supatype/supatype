import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * Issues 46 to 48: the project's stack runs but its `db` container was stopped on its own. `diff`
 * and `push` refused with the issue 41 message and left it stopped. `adopt` and `doctor` ran the
 * engine with `compose run`, which starts `db` as its dependency, so `adopt` reported "Nothing to
 * adopt" with the database running again; `pull` went on to the stopped database and hung.
 * Every command that reaches the stack's database now refuses the same way, before anything runs.
 */

const stack = vi.hoisted(() => ({ mode: undefined as "dev" | "standalone" | undefined, dbRunning: false, engineRuns: 0 }))

vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  runningStackMode: () => stack.mode,
  composeRenderOptions: () => ({ devLocal: stack.mode === "dev" }),
}))
vi.mock("../src/compose-kong.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-kong.js")>()),
  composeServiceIsRunning: (_cwd: string, _stack: unknown, service: string) => service === "db" && stack.dbRunning,
}))
vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  schemaEngineImageForPush: async () => "supatype/schema-engine:test",
  writeSelfHostCompose: (cwd: string) => ({
    dir: join(cwd, ".supatype", "self-host"),
    composePath: join(cwd, ".supatype", "self-host", "docker-compose.yml"),
    kongPath: "",
    nginxPath: "",
    s3ConfigPath: "",
  }),
}))
// A `compose run` of the engine is what started the stopped `db`: counted, never run.
vi.mock("../src/compose-engine-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-engine-run.js")>()),
  spawnComposeEngine: async () => {
    stack.engineRuns += 1
    return { status: 0, stdout: "{}", stderr: "", timedOut: false, missing: false }
  },
}))

const { requireLocalStack } = await import("../src/local-stack-guard.js")
const { schemaCommandTarget } = await import("../src/resolve-target.js")

const config: SupatypeProjectConfig = {
  project: { name: "acme" },
  provider: "docker",
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
}

let cwd = ""
const savedUrl = process.env["DATABASE_URL"]

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-stack-db-stopped-"))
  writeFileSync(join(cwd, ".env"), "POSTGRES_PASSWORD=pw\nPOSTGRES_DB=acme\nSUPATYPE_KONG_PORT=55560\n")
  writeFileSync(join(cwd, "supatype.config.mjs"), `export default ${JSON.stringify(config)}\n`)
  mkdirSync(join(cwd, ".supatype"), { recursive: true })
  delete process.env["DATABASE_URL"]
  stack.mode = "standalone"
  stack.dbRunning = false
  stack.engineRuns = 0
})

afterEach(() => {
  if (savedUrl === undefined) delete process.env["DATABASE_URL"]
  else process.env["DATABASE_URL"] = savedUrl
  rmSync(cwd, { recursive: true, force: true })
})

const refusal = (command: string) => `then run \`supatype ${command}\` again.`

describe("a running stack whose db container is stopped", () => {
  it.each(["pull", "adopt", "doctor", "migrate", "seed", "introspect"])(
    "supatype %s refuses with the local-stack message",
    (command) => {
      expect(() => requireLocalStack(cwd, config, command, { direct: true })).toThrow(refusal(command))
    },
  )

  it.each(["adopt", "doctor"])("supatype %s refuses before the engine runs, so db stays stopped", async (command) => {
    await expect(schemaCommandTarget(cwd, config, {}, command)).rejects.toThrow(refusal(command))
    expect(stack.engineRuns).toBe(0)
  })

  it("a database named for the run is reached as it is", () => {
    expect(() => requireLocalStack(cwd, config, "pull", { connection: "postgresql://u:p@db.example.com:5432/x" })).not.toThrow()
  })
})

describe("a running stack whose db container runs", () => {
  it("is let through", () => {
    stack.dbRunning = true
    expect(() => requireLocalStack(cwd, config, "pull", { direct: true })).not.toThrow()
  })
})
