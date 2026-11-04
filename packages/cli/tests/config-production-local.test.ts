import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadConfig } from "../src/config.js"

/**
 * Issue 24: `loadConfig` always laid `supatype.local.config.ts` over the committed config. That file
 * is the developer's local override (`server.mode: "dev"` among it, for a self-host project), so a
 * self-host or production command run where it exists deployed with development settings.
 * `loadConfig(cwd, { local: false })` leaves it out, and says so in one line when there is one.
 */
let dir = ""
const said: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "supatype-config-local-"))
  said.length = 0
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => void said.push(parts.map(String).join(" ")))
  writeFileSync(
    join(dir, "supatype.config.ts"),
    `export default ${JSON.stringify({
      project: { name: "acme" },
      database: {},
      server: { mode: "standalone", domain: "api.example.com" },
      app: { mode: "none" },
    })}\n`,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const writeLocal = () =>
  writeFileSync(join(dir, "supatype.local.config.ts"), `export default ${JSON.stringify({ server: { mode: "dev" } })}\n`)

describe("loadConfig without the local override", () => {
  it("still merges it by default", () => {
    writeLocal()
    expect(loadConfig(dir).server.mode).toBe("dev")
  })

  it("leaves it out, and says so once", () => {
    writeLocal()
    expect(loadConfig(dir, { local: false }).server.mode).toBe("standalone")
    expect(said.filter((line) => line.includes("supatype.local.config.ts"))).toHaveLength(1)
  })

  it("says nothing when there is no local override", () => {
    expect(loadConfig(dir, { local: false }).server.mode).toBe("standalone")
    expect(said).toEqual([])
  })
})
