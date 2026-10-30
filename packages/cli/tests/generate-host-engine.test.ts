import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GenerateTypesRequest } from "../src/type-generation.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Local test round 3, N7: `supatype generate` on a Docker project ran the engine with
 * `docker compose run` twice, which left a `supatype-<name>_default` network and a
 * `supatype-<name>_db-data` volume and took 7 to 12 s. Generating needs no database, so it runs
 * the host engine that `push` generates its types with, and never asks compose for one.
 */
const seen = vi.hoisted(() => ({ requests: [] as GenerateTypesRequest[], hostFetchFails: false }))
const IMAGE_ENGINE = vi.hoisted(() => ({
  target: { cwd: "", project: "p", composePath: "", engineImage: "supatype/schema-engine:v0.8.0" },
  databaseUrl: "",
  capabilities: () => Promise.reject(new Error("not asked in this test")),
}))

vi.mock("../src/config.js", () => ({
  loadConfig: () => projectConfig({ provider: "docker", database: { provider: "docker" } }),
  loadSchemaAst: () => ({ models: [] }),
}))
vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: async () => {
    const { BinaryUnavailable } = await import("../src/ensure-binary.js")
    if (seen.hostFetchFails) throw new BinaryUnavailable("fetch failed: releases.supatype.com unreachable")
  },
}))
vi.mock("../src/dev-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dev-compose.js")>()),
  projectComposeEngine: async () => IMAGE_ENGINE,
}))
vi.mock("../src/type-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/type-generation.js")>()),
  writeGeneratedTypes: async (req: GenerateTypesRequest) => {
    seen.requests.push(req)
    return ["Types written"]
  },
}))

import { regenerateTypes } from "../src/commands/generate.js"

let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-generate-host-"))
  seen.requests = []
  seen.hostFetchFails = false
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("supatype generate on a Docker project", () => {
  it("runs the host engine, never the compose one", async () => {
    await regenerateTypes(dir)
    expect(seen.requests).toHaveLength(1)
    expect(seen.requests[0]?.engine).toBeUndefined()
  })

  it("falls back to the project's engine image when the host engine cannot be fetched, saying so once", async () => {
    seen.hostFetchFails = true
    const said: string[] = []
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void said.push(args.join(" ")))
    await regenerateTypes(dir)
    expect(seen.requests[0]?.engine).toBe(IMAGE_ENGINE)
    expect(said).toHaveLength(1)
    expect(said[0]).toMatch(/engine image.*fetch failed/)
  })
})
