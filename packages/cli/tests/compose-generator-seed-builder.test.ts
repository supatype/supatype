import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isJsonObject } from "@supatype/shared"
import { projectConfig } from "./support/project-config.js"

/**
 * C2 follow-up: `dev` falls back to the in-compose engine for its generated files when the host
 * engine cannot be fetched. That path wrote the types, the client and the admin config, and not
 * the seed builder, so a project on it kept a builder describing the schema as init left it.
 */
const engineRequest = vi.hoisted(() => vi.fn<(endpoint: string, body: unknown, guard: unknown, engine: unknown) => Promise<unknown>>())

vi.mock("../src/engine-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/engine-client.js")>()),
  ensureEngine: async () => {
    throw new Error("no host engine in this test")
  },
  engineRequest,
}))
vi.mock("../src/compose-engine-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/compose-engine-run.js")>()),
  spawnComposeEngine: () => ({ status: 1, stdout: "", stderr: "", pid: 0, output: [], signal: null }),
}))
vi.mock("../src/self-host-compose.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-host-compose.js")>()),
  schemaEngineImageForPush: async () => "supatype/schema-engine:test",
}))

import { generateViaComposeEngine } from "../src/dev-compose.js"
import { selfHostComposePaths } from "../src/self-host-compose.js"

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

describe("dev's in-compose generator fallback", () => {
  it("writes the seed builder from the compose engine", async () => {
    const config = projectConfig({ provider: "docker" })
    await generateViaComposeEngine(selfHostComposePaths(cwd), cwd, "acme", config, { version: 2, models: [] }, join(cwd, "admin.json"))
    expect(readFileSync(join(cwd, "supatype", "generated", "seed.ts"), "utf8")).toBe("export const seedBuilder = 1\n")
    const seedCall = engineRequest.mock.calls.find(([, body]) => isJsonObject(body) && body["artifact"] === "seed")
    expect(seedCall?.[3]).toMatchObject({ target: { engineImage: "supatype/schema-engine:test" } })
  })
})
