import { describe, expect, it } from "vitest"
import { monorepoEntry } from "../src/component-launch.js"

/**
 * Local test round 3b N12: realtime's index.js only exports now, and main.js starts the server.
 * The contributor fallback ran `packages/<pkg>/dist/index.js`, which would exit at once for realtime.
 */
const slashed = (path: string): string => path.split("\\").join("/")

describe("the in-repo service a contributor's CLI falls back to", () => {
  it("runs realtime from its process entry, main.js", () => {
    expect(slashed(monorepoEntry("realtime"))).toMatch(/\/realtime\/dist\/main\.js$/)
  })

  it("runs storage from its index.js, which is its process entry", () => {
    expect(slashed(monorepoEntry("storage"))).toMatch(/\/storage\/dist\/index\.js$/)
  })
})
