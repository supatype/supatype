import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { syncComposeImagePins, upsertDevComposeEnv } from "../src/dev-compose.js"
import { projectConfig } from "./support/project-config.js"

/**
 * Local test round 6: with `versions.engine: "0.7.0"` on a Docker project, `supatype push` wrote
 * `SUPATYPE_ENGINE_IMAGE=supatype/schema-engine:v0.7.0` into `.env` as a managed line, then refused
 * the engine, and `.env` stayed pinned to it. The pin is checked before anything is written.
 */
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ENV_BEFORE = "SUPATYPE_KONG_PORT=18700\n"

function oldEnginePinned(): { cwd: string; config: ReturnType<typeof projectConfig> } {
  const cwd = mkdtempSync(join(tmpdir(), "supatype-engine-pin-"))
  dirs.push(cwd)
  writeFileSync(join(cwd, ".env"), ENV_BEFORE)
  return { cwd, config: projectConfig({ database: { provider: "docker" }, versions: { engine: "0.7.0" } }) }
}

describe("an engine pin older than this CLI needs", () => {
  it("is refused before the dev env is written", () => {
    const { cwd, config } = oldEnginePinned()
    expect(() => upsertDevComposeEnv(cwd, config, "anon", "service", 18700)).toThrow("versions.engine")
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe(ENV_BEFORE)
  })

  it("is refused before update syncs the image pins", () => {
    const { cwd, config } = oldEnginePinned()
    expect(() => syncComposeImagePins(cwd, config)).toThrow("versions.engine")
    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe(ENV_BEFORE)
  })
})
