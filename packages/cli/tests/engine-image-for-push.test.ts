import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { schemaEngineImageForPush } from "../src/self-host-compose.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * Which engine image a compose push runs. An image named explicitly (environment or `.env`) must
 * win: the push used to overwrite it with the latest published tag, so a local engine build, and
 * CI's `SUPATYPE_ENGINE_IMAGE`, were silently never the engine that pushed.
 */
const pinned = { project: { name: "p" }, versions: { engine: "0.6.0" } } as unknown as SupatypeProjectConfig

const dirs: string[] = []
function project(env?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "engine-image-"))
  dirs.push(dir)
  if (env !== undefined) writeFileSync(join(dir, ".env"), env)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("schemaEngineImageForPush()", () => {
  it("runs the image the environment names, over a pin", async () => {
    const image = await schemaEngineImageForPush(pinned, project(), { SUPATYPE_ENGINE_IMAGE: "supatype/schema-engine:local" })
    expect(image).toBe("supatype/schema-engine:local")
  })

  it("runs the image the project's .env names, over a pin", async () => {
    const image = await schemaEngineImageForPush(pinned, project("SUPATYPE_ENGINE_IMAGE=me/engine:dev\n"), {})
    expect(image).toBe("me/engine:dev")
  })

  it("runs the pinned version when nothing is named", async () => {
    const image = await schemaEngineImageForPush(pinned, project(), {})
    expect(image).toContain("0.6.0")
  })
})
