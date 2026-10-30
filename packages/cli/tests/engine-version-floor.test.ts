import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ensureBinary } from "../src/ensure-binary.js"
import { engineImageVersion } from "../src/engine-floor.js"
import { schemaEngineImageForPush } from "../src/self-host-compose.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Decision D3 (local test round 3, N9): a bucket that names no access mode now leaves `public` out of
 * the schema, and the released engine 0.7.0 failed on it with ``missing field `public` ``, which
 * names nothing about the cause. The CLI refuses an engine older than 0.8.0, wherever it resolves
 * one, with a message naming the version it needs.
 */
let dir = ""

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-engine-floor-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("an engine older than this CLI needs", () => {
  it("is refused as a host binary pinned in the config, naming the version needed", async () => {
    const config = projectConfig({ provider: "native", versions: { engine: "0.7.0" } })
    await expect(ensureBinary("engine", config)).rejects.toThrow(/is engine 0\.7\.0,.*0\.8\.0 or newer/)
  })

  it("is refused as the image a docker push would run, named in the shell", async () => {
    const config = projectConfig({ provider: "docker" })
    const env = { SUPATYPE_ENGINE_IMAGE: "supatype/schema-engine:v0.7.0" }
    await expect(schemaEngineImageForPush(config, dir, env)).rejects.toThrow(/is engine 0\.7\.0,.*0\.8\.0 or newer/)
  })

  it("is refused as the image a docker project pins", async () => {
    const config = projectConfig({ provider: "docker", versions: { engine: "0.7.0" } })
    await expect(schemaEngineImageForPush(config, dir, {})).rejects.toThrow(/0\.8\.0 or newer/)
  })

  it("lets through an image whose tag names no version, which is the developer's own build", async () => {
    const config = projectConfig({ provider: "docker" })
    const env = { SUPATYPE_ENGINE_IMAGE: "supatype/schema-engine:it-r3" }
    await expect(schemaEngineImageForPush(config, dir, env)).resolves.toBe("supatype/schema-engine:it-r3")
  })

  it("lets through an image of the version needed or newer", async () => {
    const config = projectConfig({ provider: "docker", versions: { engine: "0.8.0" } })
    await expect(schemaEngineImageForPush(config, dir, {})).resolves.toBe("supatype/schema-engine:v0.8.0")
  })
})

describe("engineImageVersion", () => {
  it("reads the tag before a digest, never the digest", () => {
    expect(engineImageVersion("supatype/schema-engine:v0.7.0@sha256:abc123")).toBe("0.7.0")
    expect(engineImageVersion("localhost:5000/schema-engine:v0.8.0")).toBe("0.8.0")
    expect(engineImageVersion("localhost:5000/schema-engine@sha256:abc123")).toBeUndefined()
    expect(engineImageVersion("supatype/schema-engine")).toBeUndefined()
  })

  it("refuses a pinned-by-digest image whose tag names an engine too old", async () => {
    const env = { SUPATYPE_ENGINE_IMAGE: "supatype/schema-engine:v0.7.0@sha256:abc123" }
    await expect(schemaEngineImageForPush(projectConfig({ provider: "docker" }), dir, env)).rejects.toThrow(/engine 0\.7\.0/)
  })
})
