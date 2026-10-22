import { describe, expect, it, vi } from "vitest"
import type { ComposeEngine } from "../src/engine-client.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Fresh-user test C3: `seed` ran the host engine binary while push, doctor and generate ran the
 * project's compose engine image. The host binary was a stale cached one, so every seed failed on
 * a schema the compose engine had just pushed. One project, two engines. Seed now takes the engine
 * push takes, whenever it seeds the project's own stack database.
 */
const composeEngine = vi.hoisted(
  (): ComposeEngine => ({
    target: { cwd: "", project: "p", composePath: "", engineImage: "img" },
    databaseUrl: "postgresql://db/app",
    capabilities: () => Promise.reject(new Error("not asked in this test")),
  }),
)

vi.mock("../src/dev-compose.js", () => ({
  projectComposeEngine: async () => composeEngine,
}))

import { seedEngine } from "../src/commands/seed.js"

const config = projectConfig({ provider: "docker" })

describe("the engine a seed runs", () => {
  it("is the project's compose engine when seeding its own stack database", async () => {
    expect(await seedEngine(process.cwd(), config, undefined, "postgresql://u:p@127.0.0.1:54329/app")).toBe(composeEngine)
  })

  it("is the host binary for a database named with --connection", async () => {
    expect(await seedEngine(process.cwd(), config, "postgresql://u:p@127.0.0.1:5432/x", "postgresql://u:p@127.0.0.1:5432/x")).toBeUndefined()
  })

  it("is the host binary for a database on another machine", async () => {
    expect(await seedEngine(process.cwd(), config, undefined, "postgresql://u:p@db.example.com:5432/app")).toBeUndefined()
  })
})
