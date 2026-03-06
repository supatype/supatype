import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { defineConfig, loadConfig } from "../src/config.js"
import type { DefinatypeConfig } from "../src/config.js"

let counter = 0
let tmpDir: string

beforeEach(() => {
  // Counter prevents timestamp collisions when tests run in rapid succession
  tmpDir = join(tmpdir(), `dt-config-test-${Date.now()}-${++counter}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("defineConfig()", () => {
  it("returns its argument unchanged (identity helper for type inference)", () => {
    const cfg: DefinatypeConfig = {
      connection: "postgresql://localhost/test",
      schema: "./schema/index.ts",
    }
    expect(defineConfig(cfg)).toBe(cfg)
  })

  it("preserves optional output field", () => {
    const cfg = defineConfig({
      connection: "postgresql://localhost/test",
      schema: "./schema/index.ts",
      output: { types: "./src/types.d.ts", client: "./src/client.ts" },
    })
    expect(cfg.output?.types).toBe("./src/types.d.ts")
    expect(cfg.output?.client).toBe("./src/client.ts")
  })
})

describe("loadConfig()", () => {
  it("throws when no config file exists in the directory", () => {
    expect(() => loadConfig(tmpDir)).toThrow(/No supatype.config.ts found/)
  })

  it("loads a valid supatype.config.ts (plain export default, no package imports)", () => {
    // Note: avoid importing @supatype/cli inside the temp config —
    // the temp dir is outside the monorepo and can't resolve workspace packages.
    writeFileSync(
      join(tmpDir, "supatype.config.ts"),
      `export default {
  connection: "postgresql://localhost/mydb",
  schema: "./schema/index.ts",
}
`,
    )
    const cfg = loadConfig(tmpDir)
    expect(cfg.connection).toBe("postgresql://localhost/mydb")
    expect(cfg.schema).toBe("./schema/index.ts")
  })

  it("loads a supatype.config.js (plain ESM)", () => {
    writeFileSync(
      join(tmpDir, "supatype.config.js"),
      `export default {
  connection: "postgresql://localhost/jsdb",
  schema: "./schema/index.ts",
}
`,
    )
    const cfg = loadConfig(tmpDir)
    expect(cfg.connection).toBe("postgresql://localhost/jsdb")
  })

  it("throws if config is missing the schema field", () => {
    writeFileSync(
      join(tmpDir, "supatype.config.ts"),
      `export default { connection: "postgresql://localhost/test" }`,
    )
    expect(() => loadConfig(tmpDir)).toThrow(/must export/)
  })

  it("throws if config is missing the connection field", () => {
    writeFileSync(
      join(tmpDir, "supatype.config.ts"),
      `export default { schema: "./schema/index.ts" }`,
    )
    expect(() => loadConfig(tmpDir)).toThrow(/must export/)
  })

  it("prefers supatype.config.ts over supatype.config.js when both exist", () => {
    writeFileSync(
      join(tmpDir, "supatype.config.ts"),
      `export default { connection: "postgresql://localhost/from-ts", schema: "./schema/index.ts" }`,
    )
    writeFileSync(
      join(tmpDir, "supatype.config.js"),
      `export default { connection: "postgresql://localhost/from-js", schema: "./schema/index.ts" }`,
    )
    const cfg = loadConfig(tmpDir)
    expect(cfg.connection).toContain("from-ts")
  })

  it("supports optional output field in config", () => {
    writeFileSync(
      join(tmpDir, "supatype.config.ts"),
      `export default {
  connection: "postgresql://localhost/test",
  schema: "./schema/index.ts",
  output: { types: "./src/types.d.ts" },
}
`,
    )
    const cfg = loadConfig(tmpDir)
    expect(cfg.output?.types).toBe("./src/types.d.ts")
  })
})
