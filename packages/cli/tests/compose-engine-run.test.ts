import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SpawnSyncReturns } from "node:child_process"

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
  it("gives compose a value for each required variable .env does not set", () => {
    const env = spawnEnv(["-T", "--no-deps"])
    expect(env["JWT_SECRET"]).toMatch(/\S/)
    expect(env["AUTHENTICATOR_PASSWORD"]).toMatch(/\S/)
    expect(env["NOT_A_VARIABLE"]).toBeUndefined()
  })

  it("leaves a variable .env sets for compose to read from .env", () => {
    writeFileSync(join(cwd, ".env"), "JWT_SECRET=the-project-secret\n")
    const env = spawnEnv(["--no-deps"])
    expect(env["JWT_SECRET"]).toBe("")
    expect(env["AUTHENTICATOR_PASSWORD"]).toMatch(/\S/)
  })

  it("never hands the values to the engine container", () => {
    spawnEnv(["--no-deps"])
    const args = spawnSync.mock.calls[0]?.[1] ?? []
    expect(args).not.toContain("JWT_SECRET")
  })
})

describe("spawnComposeEngine with its dependencies", () => {
  it("adds nothing, so a stack missing a secret still refuses to start", () => {
    const env = spawnEnv(["-T"])
    expect(env["JWT_SECRET"]).toBe("")
  })
})
