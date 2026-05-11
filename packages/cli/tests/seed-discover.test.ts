import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { discoverSeedsDir } from "../src/commands/seed.js"

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
