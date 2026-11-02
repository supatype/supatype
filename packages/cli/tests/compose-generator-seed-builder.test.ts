import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isJsonObject } from "@supatype/shared"
import { projectConfig } from "./support/project-config.js"

/**
 * C2 follow-up: when the host engine cannot be fetched, a Docker project's generated files come
 * from its compose engine image (generated-files-engine.ts), and that includes the seed builder:
 * the fallback once wrote the types, the client and the admin config and not the builder, so a
 * project on it kept a builder describing the schema as init left it.
 */
const engineRequest = vi.hoisted(() => vi.fn<(endpoint: string, body: unknown, guard: unknown, engine: unknown) => Promise<unknown>>())

vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: async () => {
    const { BinaryUnavailable } = await import("../src/ensure-binary.js")
    throw new BinaryUnavailable("no host engine in this test")
  },
  engineRequest,
}))
vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  schemaEngineImageForPush: async () => "supatype/schema-engine:test",
}))

import { generatedFilesEngine } from "../src/generated-files-engine.js"
import { projectOutputPaths, writeSeedBuilder } from "../src/type-generation.js"

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-compose-gen-"))
  engineRequest.mockReset()
  engineRequest.mockImplementation(async (_endpoint, body) =>
    isJsonObject(body) && body["artifact"] === "seed" ? { code: "export const seedBuilder = 1\n" } : {},
  )
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

describe("the engine image fallback for generated files", () => {
  it("writes the seed builder from the compose engine", async () => {
    const config = projectConfig({ provider: "docker" })
    const { engine } = await generatedFilesEngine(cwd, config)
    await writeSeedBuilder({ cwd, ast: { version: 2, models: [] }, ...projectOutputPaths(config.output), engine })
    expect(readFileSync(join(cwd, "supatype", "generated", "seed.ts"), "utf8")).toBe("export const seedBuilder = 1\n")
    const seedCall = engineRequest.mock.calls.find(([, body]) => isJsonObject(body) && body["artifact"] === "seed")
    expect(seedCall?.[3]).toMatchObject({ target: { engineImage: "supatype/schema-engine:test" } })
  })
})
