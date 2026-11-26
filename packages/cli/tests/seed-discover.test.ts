import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { discoverSeedsDir } from "../src/commands/seed.js"
import { projectConfig } from "./support/project-config.js"

let tmp: string
beforeEach(() => {
  tmp = join(tmpdir(), `supatype-seed-${Date.now()}`)
  mkdirSync(join(tmp, "seeds"), { recursive: true })
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("discoverSeedsDir", () => {
  it("returns sorted paths for seeds/*.ts", () => {
    writeFileSync(join(tmp, "seeds", "z_first.ts"), "//")
    writeFileSync(join(tmp, "seeds", "a_second.ts"), "//")
    const paths = discoverSeedsDir(tmp, join(tmp, "seeds"))
    expect(paths.map((p) => p.replace(/\\/g, "/"))).toEqual([
      join(tmp, "seeds", "a_second.ts").replace(/\\/g, "/"),
      join(tmp, "seeds", "z_first.ts").replace(/\\/g, "/"),
    ])
  })

  it("returns empty when seeds dir missing", () => {
    const empty = join(tmp, "no-seeds")
    expect(discoverSeedsDir(tmp, empty)).toEqual([])
  })
})

// S-35: `supatype seed a.ts b.ts` ran a.ts and silently ignored b.ts.
describe("seedPaths", () => {
  it("runs every file named, in the order named", async () => {
    const { seedPaths } = await import("../src/commands/seed.js")
    const config = projectConfig({ project: { name: "acme" } })
    const paths = seedPaths(["b.ts", "a.ts"], tmp, config)
    expect(paths).toEqual([resolve(tmp, "b.ts"), resolve(tmp, "a.ts")])
  })

  it("still takes one file, or none", async () => {
    const { seedPaths } = await import("../src/commands/seed.js")
    const config = projectConfig({ project: { name: "acme" } })
    expect(seedPaths("one.ts", tmp, config)).toHaveLength(1)
    writeFileSync(join(tmp, "seeds", "x.ts"), "//")
    expect(seedPaths(undefined, tmp, config)).toHaveLength(1)
  })
})
