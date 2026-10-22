import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ComposeEngine } from "../src/engine-client.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Fresh-user test C3: `seed` ran the host engine binary while push, doctor and generate ran the
 * project's compose engine image. The host binary was a stale cached one, so every seed failed on
 * a schema the compose engine had just pushed. One project, two engines. Seed now takes the engine
 * push takes, but only when it seeds the stack's own database: a local URL at the port the stack
 * publishes Postgres on. The compose engine reaches the stack's database inside the stack network,
 * so for any other database, local or not, it would seed the wrong one.
 */
const composeEngine = vi.hoisted(
  (): ComposeEngine => ({
    target: { cwd: "", project: "p", composePath: "", engineImage: "img" },
    databaseUrl: "postgresql://db/app",
    capabilities: () => Promise.reject(new Error("not asked in this test")),
  }),
)
const stack = vi.hoisted(() => ({ mode: "dev" as "dev" | "standalone" }))

vi.mock("../src/dev-compose.js", () => ({
  projectComposeEngine: async () => composeEngine,
}))
vi.mock("../src/compose-render-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-render-mode.js")>()),
  composeRenderMode: () => stack.mode,
}))

import { seedEngine } from "../src/commands/seed.js"

const config = projectConfig({ provider: "docker" })
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-seed-engine-"))
  writeFileSync(join(dir, ".env"), "SUPATYPE_DEV_DB_PORT=54777\nSUPATYPE_DB_PORT=54390\n")
  vi.stubEnv("SUPATYPE_DEV_DB_PORT", undefined)
  vi.stubEnv("SUPATYPE_DB_PORT", undefined)
  stack.mode = "dev"
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe("the engine a seed runs", () => {
  it("is the project's compose engine when seeding a dev stack's database at its port", async () => {
    expect(await seedEngine(dir, config, undefined, "postgresql://u:p@127.0.0.1:54777/app")).toBe(composeEngine)
  })

  it("is the compose engine for a self-host stack's database at its port", async () => {
    stack.mode = "standalone"
    expect(await seedEngine(dir, config, undefined, "postgresql://u:p@localhost:54390/app")).toBe(composeEngine)
  })

  it("is the host binary for a local database at a port the stack does not publish", async () => {
    expect(await seedEngine(dir, config, undefined, "postgresql://u:p@127.0.0.1:5432/app")).toBeUndefined()
    stack.mode = "standalone"
    expect(await seedEngine(dir, config, undefined, "postgresql://u:p@127.0.0.1:54777/app")).toBeUndefined()
  })

  it("is the host binary for a database named with --connection", async () => {
    const url = "postgresql://u:p@127.0.0.1:54777/x"
    expect(await seedEngine(dir, config, url, url)).toBeUndefined()
  })

  it("is the host binary for a database on another machine", async () => {
    expect(await seedEngine(dir, config, undefined, "postgresql://u:p@db.example.com:54777/app")).toBeUndefined()
  })
})
