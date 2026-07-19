import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveRealtimeLaunch } from "../src/realtime-launch.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

describe("resolveRealtimeLaunch", () => {
  it("uses overrides.realtime .js entry via node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-rt-launch-"))
    try {
      const entry = join(dir, "fake-realtime.js")
      const { writeFileSync } = await import("node:fs")
      writeFileSync(entry, "export {}\n")
      const config = {
        overrides: { realtime: entry },
      } as SupatypeProjectConfig
      const spec = await resolveRealtimeLaunch(config, dir)
      expect(spec.bin).toBe(process.execPath)
      expect(spec.args).toEqual([entry])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
