import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SpawnSyncReturns } from "node:child_process"
import { isJsonObject, isUnknown } from "@supatype/shared"
import type { ComposeEngineTarget, ComposeEngineSpawn } from "../src/compose-engine-run.js"

/**
 * A5-N2, A5-N3: on a docker project without `overrides.engine`, adopt, doctor, type generation and
 * the admin config run in the project's engine image, as push does. They used to run the host
 * binary (the pin, else whatever was cached), so `adopt --key` was refused by an old engine that
 * did not know the flag while the compose push had just applied the schema.
 */

interface Run {
  target: ComposeEngineTarget
  args: readonly string[]
  spawn: ComposeEngineSpawn
  /** The request file as the container would read it, captured while it existed. */
  request: string | undefined
}
const runs: Run[] = []
const answer: { stdout: string } = { stdout: "{}" }

vi.mock("../src/compose-engine-run.js", () => ({
  spawnComposeEngine: (
    target: ComposeEngineTarget,
    args: readonly string[],
    spawn: ComposeEngineSpawn = {},
  ): SpawnSyncReturns<string> => {
    const input = args[args.indexOf("--input") + 1]
    const hostPath =
      input !== undefined && input.startsWith("/project/") ? join(target.cwd, input.slice("/project/".length)) : undefined
    runs.push({ target, args, spawn, request: hostPath !== undefined ? readFileSync(hostPath, "utf8") : undefined })
    return { pid: 0, output: [], status: 0, signal: null, stdout: answer.stdout, stderr: "" }
  },
}))
// The host binary must not be needed at all.
vi.mock("../src/ensure-binary.js", () => ({
  ensureBinary: async () => {
    throw new Error("the host engine binary was resolved")
  },
}))
vi.mock("../src/config.js", () => ({
  hasProjectConfig: () => true,
  loadConfig: () => ({ project: { name: "demo" } }),
}))

const { engineRequest } = await import("../src/engine-client.js")
const { targetSchemaAdopt, targetSchemaDoctor, targetCapabilities } = await import("../src/resolve-target.js")
const { writeGeneratedTypes } = await import("../src/type-generation.js")

let cwd: string
const IN_NETWORK = "postgresql://supatype_admin:pw@db:5432/demo"

function compose() {
  return {
    target: { cwd, project: "supatype-demo", composePath: join(cwd, "docker-compose.yml"), engineImage: "supatype/schema-engine:9.9.9" },
    databaseUrl: IN_NETWORK,
    capabilities: async () => ({ features: new Set(["adopt_keys", "identity_columns"]), source: "engine" as const }),
  }
}

beforeEach(() => {
  runs.length = 0
  answer.stdout = "{}"
  cwd = mkdtempSync(join(tmpdir(), "supatype-compose-engine-"))
})

afterEach(() => rmSync(cwd, { recursive: true, force: true }))

describe("engineRequest through the project's compose engine", () => {
  it("runs the subcommand in the engine image, reading the request from the project mount", async () => {
    answer.stdout = '{"status":"ok"}'
    const result = await engineRequest("/adopt", { ast: { models: [] }, schema: "public", yes: true, keys: ["table:a"], database_url: "ignored" }, isJsonObject, compose())
    expect(result).toEqual({ status: "ok" })
    expect(runs).toHaveLength(1)
    const [run] = runs
    expect(run!.target.engineImage).toBe("supatype/schema-engine:9.9.9")
    expect(run!.args.slice(0, 1)).toEqual(["adopt"])
    expect(run!.args).toContain("--key")
    expect(run!.args[run!.args.indexOf("--input") + 1]).toMatch(/^\/project\/\.supatype\/engine-[^/]+\/request\.json$/)
    expect(JSON.parse(run!.request!)).toEqual({ models: [] })
    // The database as the container reaches it, through the environment, never on argv.
    expect(run!.spawn.secrets).toEqual({ DATABASE_URL: IN_NETWORK })
    expect(run!.args.join(" ")).not.toContain(IN_NETWORK)
  })

  it("removes the request files when the run is over", async () => {
    await engineRequest("/generate", { ast: { models: [] }, lang: "typescript" }, isUnknown, compose())
    const supatype = join(cwd, ".supatype")
    expect(existsSync(supatype) ? readdirSync(supatype).filter((n) => n.startsWith("engine-")) : []).toEqual([])
  })

  it("does not start the database for a run that needs none", async () => {
    await engineRequest("/admin", { ast: { models: [] } }, isUnknown, compose())
    expect(runs[0]!.spawn.runFlags).toContain("--no-deps")
  })
})

describe("schema commands on a compose-engine target", () => {
  const target = () => ({
    mode: "direct" as const,
    environment: "local",
    projectRef: "demo",
    apiBaseUrl: "",
    apiPrefix: "/platform/v1" as const,
    link: null,
    compose: compose(),
  })

  it("adopts through the engine image", async () => {
    answer.stdout = '{"adopt":[]}'
    await targetSchemaAdopt(target(), { models: [] }, { yes: true, keys: ["table:a"] })
    expect(runs.map((r) => r.args[0])).toEqual(["adopt"])
  })

  it("runs doctor through the engine image", async () => {
    answer.stdout = '{"missing":[],"staleManaged":[],"unmanagedDrift":[]}'
    await targetSchemaDoctor(target(), { models: [] })
    expect(runs.map((r) => r.args[0])).toEqual(["doctor"])
  })

  it("asks the engine image, not the host binary, what it supports", async () => {
    expect((await targetCapabilities(target())).features.has("adopt_keys")).toBe(true)
  })
})

describe("type generation on a compose-engine project", () => {
  it("generates the types in the engine image", async () => {
    answer.stdout = "// Generated by supatype-engine\nexport type X = 1\n"
    await writeGeneratedTypes({ cwd, ast: { models: [] }, typesPath: "types/database.ts", engine: compose() })
    expect(runs[0]!.args[0]).toBe("generate")
    expect(readFileSync(join(cwd, "types", "database.ts"), "utf8")).toContain("export type X = 1")
  })
})
