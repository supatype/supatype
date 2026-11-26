import { describe, expect, it, vi } from "vitest"
import { BinaryUnavailable } from "../src/ensure-binary.js"
import type { ComposeEngine } from "../src/engine-client.js"
import { generatedFilesEngine } from "../src/generated-files-engine.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Second review of the shared engine choice: only a host engine that cannot be fetched falls back
 * to the image. A refusal (an engine too old) or a config error is the answer, as it is. A failed
 * fetch is remembered for the process, so an offline dev session does not retry the download on
 * every save, and says so once.
 */
const IMAGE: ComposeEngine = {
  target: { cwd: "", project: "p", composePath: "", engineImage: "supatype/schema-engine:v0.8.0" },
  databaseUrl: "",
  capabilities: () => Promise.reject(new Error("not asked")),
}
const offline = (): Promise<void> => Promise.reject(new BinaryUnavailable("fetch failed: releases.supatype.com unreachable"))

describe("generatedFilesEngine", () => {
  it("rethrows a refusal as it is, and never asks for the image", async () => {
    const composeEngine = vi.fn(async () => IMAGE)
    const refusal = new Error("This CLI needs Supatype engine 0.8.0 or newer, and versions.engine is engine 0.7.0")
    const config = projectConfig({ provider: "docker", versions: { engine: "0.7.1" } })
    await expect(generatedFilesEngine("/p", config, { hostEngine: () => Promise.reject(refusal), composeEngine })).rejects.toBe(refusal)
    expect(composeEngine).not.toHaveBeenCalled()
  })

  it("falls back to the image when the host engine cannot be fetched, with why", async () => {
    const config = projectConfig({ provider: "docker", versions: { engine: "0.8.1" } })
    const choice = await generatedFilesEngine("/p", config, { hostEngine: offline, composeEngine: async () => IMAGE })
    expect(choice.engine).toBe(IMAGE)
    expect(choice.fellBack).toContain("releases.supatype.com unreachable")
  })

  it("keeps the host engine's reason when the image cannot be used either", async () => {
    const config = projectConfig({ provider: "docker", versions: { engine: "0.8.2" } })
    const composeEngine = () => Promise.reject(new Error("image pull failed"))
    await expect(generatedFilesEngine("/p", config, { hostEngine: offline, composeEngine })).rejects.toThrow(
      /releases\.supatype\.com unreachable.*image pull failed/,
    )
  })

  it("does not try the download again in the same process, and says why only once", async () => {
    const config = projectConfig({ provider: "docker", versions: { engine: "0.8.3" } })
    const hostEngine = vi.fn(offline)
    const first = await generatedFilesEngine("/p", config, { hostEngine, composeEngine: async () => IMAGE })
    const second = await generatedFilesEngine("/p", config, { hostEngine, composeEngine: async () => IMAGE })
    expect(hostEngine).toHaveBeenCalledTimes(1)
    expect(first.fellBack).toBeDefined()
    expect(second.engine).toBe(IMAGE)
    expect(second.fellBack).toBeUndefined()
  })
})

/**
 * A Docker project that names its engine image in SUPATYPE_ENGINE_IMAGE pushes with that image, so
 * the generated files come from it too (owner, 2026-11-15). With the cached host engine older than
 * the image, push said "Schema pushed." while types, seed builder and admin config each failed with
 * "this Supatype engine does not support realtime channels". Unnamed, the host engine stays (round 3).
 */
describe("an engine image named in SUPATYPE_ENGINE_IMAGE", () => {
  it("writes the generated files with that image, never asking the host engine", async () => {
    const hostEngine = vi.fn(async () => {})
    const config = projectConfig({ provider: "docker" })
    const choice = await generatedFilesEngine("/p", config, { hostEngine, composeEngine: async () => IMAGE, namedImage: async () => "supatype/schema-engine:local" })
    expect(choice.engine).toBe(IMAGE)
    expect(hostEngine).not.toHaveBeenCalled()
  })

  it("keeps the host engine when no image is named, or for a native project", async () => {
    const composeEngine = vi.fn(async () => IMAGE)
    const docker = await generatedFilesEngine("/p", projectConfig({ provider: "docker" }), { hostEngine: async () => {}, composeEngine, namedImage: async () => undefined })
    const native = await generatedFilesEngine("/p", projectConfig({ provider: "native" }), { hostEngine: async () => {}, composeEngine, namedImage: async () => "supatype/schema-engine:local" })
    expect(docker.engine).toBeUndefined()
    expect(native.engine).toBeUndefined()
    expect(composeEngine).not.toHaveBeenCalled()
  })
})

describe("the engine image line the CLI writes from versions.engine", () => {
  it("is not a named image: the host engine at that pin already matches it", async () => {
    vi.stubEnv("SUPATYPE_ENGINE_IMAGE", "supatype/schema-engine:v0.9.9")
    const hostEngine = vi.fn(async () => {})
    const composeEngine = vi.fn(async () => IMAGE)
    const config = projectConfig({ provider: "docker", versions: { engine: "0.9.9" } })
    const choice = await generatedFilesEngine("/p", config, { hostEngine, composeEngine })
    vi.unstubAllEnvs()
    expect(choice.engine).toBeUndefined()
    expect(composeEngine).not.toHaveBeenCalled()
  })
})
