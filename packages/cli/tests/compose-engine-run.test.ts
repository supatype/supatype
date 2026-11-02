import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SpawnSyncReturns } from "node:child_process"
import { projectConfig } from "./support/project-config.js"

/**
 * Compose interpolates the whole file before it runs one service. A project whose `.env` `dev` has
 * never prepared (a fresh clone, the CI job that checks generated types) could not run
 * `supatype generate` in its engine image: compose refused over `JWT_SECRET`, which only PostgREST
 * and the server read, and a `--no-deps` engine run starts neither.
 */

interface SpawnOptions { env?: NodeJS.ProcessEnv }
type Spawned = Partial<SpawnSyncReturns<string>>
const spawnSync = vi.fn<(cmd: string, args: readonly string[], opts?: SpawnOptions) => Spawned>()
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (cmd: string, args: readonly string[], opts?: SpawnOptions) => spawnSync(cmd, args, opts),
}))

const { spawnComposeEngine } = await import("../src/compose-engine-run.js")
const { ENGINE_SERVICE } = await import("../src/compose-engine-service.js")
const { renderSelfHostCompose } = await import("../src/self-host-compose.js")

const COMPOSE = [
  "services:",
  "  postgrest:",
  "    environment:",
  "      PGRST_JWT_SECRET: ${JWT_SECRET:?JWT_SECRET is missing from .env}",
  "      PGRST_DB_URI: postgresql://authenticator:${AUTHENTICATOR_PASSWORD:?missing}@db:5432/x",
  "      LITERAL: $${NOT_A_VARIABLE:?never interpolated}",
  "  schema-engine:",
  "    image: ${SUPATYPE_ENGINE_IMAGE:-supatype/schema-engine:latest}",
  "",
].join("\n")

let cwd: string

function spawnEnv(runFlags: readonly string[]): NodeJS.ProcessEnv {
  const target = { cwd, project: "p", composePath: join(cwd, "compose.yml"), engineImage: undefined }
  spawnComposeEngine(target, ["generate"], { runFlags })
  expect(spawnSync).toHaveBeenCalledTimes(1)
  return spawnSync.mock.calls[0]?.[2]?.env ?? {}
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "compose-engine-run-"))
  writeFileSync(join(cwd, "compose.yml"), COMPOSE)
  spawnSync.mockReset()
  spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" })
  vi.stubEnv("JWT_SECRET", "")
  vi.stubEnv("AUTHENTICATOR_PASSWORD", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(cwd, { recursive: true, force: true })
})

describe("spawnComposeEngine with --no-deps", () => {
  it("never reads the compose file, so the secrets .env lacks do not matter", () => {
    const env = spawnEnv(["-T", "--no-deps"])
    const args = spawnSync.mock.calls[0]?.[1] ?? []
    expect(args).not.toContain("compose")
    expect(args).not.toContain("JWT_SECRET")
    expect(env["JWT_SECRET"]).toBe("")
  })
})

describe("spawnComposeEngine with its dependencies", () => {
  it("adds nothing, so a stack missing a secret still refuses to start", () => {
    const env = spawnEnv(["-T"])
    expect(env["JWT_SECRET"]).toBe("")
  })
})

/**
 * Local test round 3c: `generate`'s fallback to the project's engine image ran `compose run
 * --no-deps`, which still created the project's network and its `_db-data` volume, and left them on
 * a project whose stack had never run. A run that needs no database runs the image alone.
 */
describe("spawnComposeEngine for a run that needs no database", () => {
  function run(engineImage: string | undefined): readonly string[] {
    const target = { cwd, project: "p", composePath: join(cwd, "compose.yml"), engineImage }
    spawnComposeEngine(target, ["generate", "--input", "/project/x.json"], { runFlags: ["-T", "--no-deps"], secrets: { DATABASE_URL: "postgres://pw@db/x" } })
    return spawnSync.mock.calls[0]?.[1] ?? []
  }

  it("runs the engine image alone, with no network, the project mounted, and nothing left behind", () => {
    const args = run("supatype/schema-engine:9.9.9")
    expect(args).not.toContain("compose")
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--network", "none"])
    expect(args).toContain(`type=bind,"source=${cwd.replace(/\\/g, "/")}",target=/project`)
    expect(args.slice(-4)).toEqual(["supatype/schema-engine:9.9.9", "generate", "--input", "/project/x.json"])
    // The secret's value stays off the command line.
    expect(args.join(" ")).not.toContain("postgres://pw@db/x")
  })

  // Review of round 3c: a project naming no image (versions.engine "local") still ran compose.
  it("runs the image the compose file would name when the project names none", () => {
    vi.stubEnv("SUPATYPE_ENGINE_IMAGE", "")
    const args = run(undefined)
    expect(args).not.toContain("compose")
    expect(args).toContain(ENGINE_SERVICE.defaultImage)
  })

  it("takes the image .env names, as compose would", () => {
    vi.stubEnv("SUPATYPE_ENGINE_IMAGE", "")
    writeFileSync(join(cwd, ".env"), "SUPATYPE_ENGINE_IMAGE=supatype/schema-engine:from-env\n")
    expect(run(undefined)).toContain("supatype/schema-engine:from-env")
  })

  it("runs the image as the compose file's service describes it", () => {
    const args = run("supatype/schema-engine:9.9.9")
    expect(args).toContain(ENGINE_SERVICE.entrypoint)
    expect(args[args.indexOf("--workdir") + 1]).toBe(ENGINE_SERVICE.projectDir)
    const compose = renderSelfHostCompose(projectConfig({ provider: "docker" }), cwd)
    const service = compose.slice(compose.indexOf("  schema-engine:"), compose.indexOf("  kong:"))
    expect(service).toContain(`entrypoint: ["${ENGINE_SERVICE.entrypoint}"]`)
    expect(service).toContain(`working_dir: ${ENGINE_SERVICE.projectDir}`)
    expect(service).toContain(`target: ${ENGINE_SERVICE.projectDir}\n`)
    expect(service).toContain(`image: \${${ENGINE_SERVICE.imageVariable}:-${ENGINE_SERVICE.defaultImage}}`)
  })
})
