import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { defaultScaffoldOptions, scaffold } from "../src/commands/init.js"
import { mergeProjectConfig, validateProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"
import { withPublishing, withRealtime } from "../src/model-versioning.js"
import type { ExtractedSchemaAstV2 } from "../src/schema-ast-v2.js"

/**
 * `realtime.channels` in `supatype.config.ts`: whether a topic no `Channel<>` matches may carry
 * broadcast and presence. Absent means `open`, so an existing project is unchanged; `supatype init`
 * writes `declared`.
 */

const BASE = {
  project: { name: "p" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
}

const AST = { astVersion: 2, models: [] } as unknown as ExtractedSchemaAstV2
const config = (realtime?: unknown): SupatypeProjectConfig =>
  ({ ...BASE, ...(realtime !== undefined && { realtime }) }) as unknown as SupatypeProjectConfig

describe("validating realtime.channels", () => {
  it.each(["open", "declared"])("accepts %s", (mode) => {
    expect(validateProjectConfig({ ...BASE, realtime: { channels: mode } }, "c").realtime?.channels).toBe(mode)
  })

  it("accepts a config with no realtime section", () => {
    expect(validateProjectConfig(BASE, "c").realtime).toBeUndefined()
  })

  it.each([["strict"], [true], [1], [""]])("refuses %j, naming the two modes", (mode) => {
    expect(() => validateProjectConfig({ ...BASE, realtime: { channels: mode } }, "supatype.config.ts")).toThrow(
      /supatype\.config\.ts: realtime\.channels must be "open" or "declared"/,
    )
  })

  it("refuses a realtime section that is not an object", () => {
    expect(() => validateProjectConfig({ ...BASE, realtime: "declared" }, "c")).toThrow(/realtime must be an object/)
  })
})

describe("merging the local config over the base", () => {
  it("lets the local file tighten or loosen the mode", () => {
    const merged = mergeProjectConfig(config({ channels: "declared" }), { realtime: { channels: "open" } })
    expect(merged.realtime?.channels).toBe("open")
  })

  it("keeps the base mode when the local file says nothing", () => {
    expect(mergeProjectConfig(config({ channels: "declared" }), {}).realtime?.channels).toBe("declared")
  })
})

describe("attaching it to the AST", () => {
  it("adds the mode the config states, for the engine", () => {
    expect(withRealtime(AST, config({ channels: "declared" })).realtime).toEqual({ channels: "declared" })
  })

  it("adds nothing when the config states none, which the engine reads as open", () => {
    expect(withRealtime(AST, config()).realtime).toBeUndefined()
  })

  it("rides along with the publishing settings on every path that sends a schema", () => {
    expect(withPublishing(AST, config({ channels: "open" })).realtime).toEqual({ channels: "open" })
  })
})

describe("what init writes", () => {
  let dir: string
  beforeEach(() => {
    dir = join(tmpdir(), `dt-init-realtime-${process.pid}-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("declares channels for a new project, with a comment saying what it refuses", () => {
    scaffold(dir, defaultScaffoldOptions("r-app"))
    const written = readFileSync(join(dir, "supatype.config.ts"), "utf8")
    expect(written).toContain(`realtime: { channels: "declared" }`)
    expect(written).toContain("// Broadcast and presence on a channel no Channel<> declares")
  })
})
