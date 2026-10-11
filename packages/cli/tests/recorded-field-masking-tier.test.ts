import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SpawnSyncReturns } from "node:child_process"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * T2-N6: the CLI wrote PostgREST's search path from the tier it predicts from the image, so a
 * `supatype/postgres` stack whose database had lost `supatype_mask` (tier 2, the `api` views) kept
 * searching `public`, and GraphQL served end users no model. The engine records the tier the
 * database really has on every push; once there is a record, compose is rendered from it.
 */

type Spawned = Partial<SpawnSyncReturns<string>>
const spawnSync = vi.fn<(cmd: string, args: readonly string[]) => Spawned>()
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: (cmd: string, args: readonly string[]) => spawnSync(cmd, args),
}))

const { readRecordedTier, recordDatabaseTier, recordedTierPath, sameApiSurface, tierFromEngine, writeRecordedTier } =
  await import("../src/recorded-field-masking-tier.js")
const { writeSelfHostCompose, selfHostComposePaths } = await import("../src/self-host-compose.js")

const config: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
}
const stack = { project: "supatype-acme", composePath: "/x/.supatype/self-host/docker-compose.yml" }

/** The database answers `recorded` to the tier query; everything else docker is asked fails. */
function databaseRecords(recorded: string): void {
  spawnSync.mockImplementation((cmd, args) =>
    cmd === "docker" && args.includes("psql")
      ? { status: 0, stdout: `${recorded}\n`, stderr: "" }
      : { status: 1, stdout: "", stderr: "" },
  )
}

function searchPath(dir: string, cfg: SupatypeProjectConfig = config): string | undefined {
  writeSelfHostCompose(dir, cfg)
  const compose = readFileSync(selfHostComposePaths(dir).composePath, "utf8")
  return /PGRST_DB_EXTRA_SEARCH_PATH: (\S+)/.exec(compose)?.[1]
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-recorded-tier-"))
  spawnSync.mockReset()
  databaseRecords("")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("tierFromEngine", () => {
  it("maps the engine's names onto the CLI's tiers", () => {
    expect(tierFromEngine("extension")).toBe("extension")
    expect(tierFromEngine("views\n")).toBe("views")
    expect(tierFromEngine("unenforced")).toBe("none")
  })

  it("has no tier for a broken record or none at all, so the prediction stands", () => {
    for (const recorded of ["broken", "", "something new"]) expect(tierFromEngine(recorded)).toBeUndefined()
  })
})

describe("the recorded tier", () => {
  it("round trips, and a file that does not parse is no record", () => {
    expect(readRecordedTier(dir)).toBeUndefined()
    writeRecordedTier(dir, "views")
    expect(readRecordedTier(dir)).toBe("views")
    writeFileSync(recordedTierPath(dir), "{not json", "utf8")
    expect(readRecordedTier(dir)).toBeUndefined()
  })

  it("is read from the stack's database and kept", () => {
    databaseRecords("views")
    expect(recordDatabaseTier(dir, stack)).toBe("views")
    expect(readRecordedTier(dir)).toBe("views")
    databaseRecords("extension")
    expect(recordDatabaseTier(dir, stack)).toBe("extension")
    expect(readRecordedTier(dir)).toBe("extension")
  })

  it("is left alone when the database cannot say", () => {
    writeRecordedTier(dir, "views")
    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "no such service: db" })
    expect(recordDatabaseTier(dir, stack)).toBeUndefined()
    databaseRecords("broken")
    expect(recordDatabaseTier(dir, stack)).toBeUndefined()
    expect(readRecordedTier(dir)).toBe("views")
  })

  it("changes what PostgREST serves only between views and the rest", () => {
    expect(sameApiSurface(config, "none", "extension")).toBe(true)
    expect(sameApiSurface(config, undefined, "none")).toBe(true)
    expect(sameApiSurface(config, "extension", "views")).toBe(false)
    expect(sameApiSurface(config, "views", "views")).toBe(true)
  })
})

describe("PostgREST's search path", () => {
  it("follows the database's recorded tier over the image's prediction", () => {
    expect(searchPath(dir)).toBe("public,extensions")
    writeRecordedTier(dir, "views")
    expect(searchPath(dir)).toBe("api,extensions")
    writeRecordedTier(dir, "extension")
    expect(searchPath(dir)).toBe("public,extensions")
  })

  it("ignores a record for an external database, which has no stack database to record one", () => {
    mkdirSync(join(dir, ".supatype"), { recursive: true })
    writeRecordedTier(dir, "views")
    const url = "postgres://u:p@db.example.com:5432/app"
    writeFileSync(join(dir, ".env"), `DATABASE_URL=${url}\n`, "utf8")
    const external = { ...config, database: { provider: "docker", external: { url } } } as SupatypeProjectConfig
    expect(searchPath(dir, external)).toBe("public,extensions")
  })
})
