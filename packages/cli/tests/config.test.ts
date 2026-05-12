import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { defineConfig, loadConfig } from "../src/config.js"
import { mergeProjectConfig, type SupatypeProjectConfig } from "../src/project-config.js"

let counter = 0
let tmpDir: string

const minimalProject = (name: string): SupatypeProjectConfig => ({
  project: { name },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
  versions: {
    engine: "0.4.2",
    server: "0.1.0",
    postgres: "17.2",
    deno: "2.2.0",
  },
})

beforeEach(() => {
  tmpDir = join(tmpdir(), `dt-config-test-${Date.now()}-${++counter}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("defineConfig()", () => {
  it("returns its argument unchanged (identity helper for type inference)", () => {
    const cfg = defineConfig({
      ...minimalProject("test"),
      connection: "postgresql://localhost/test",
      schema: { path: "./schema/index.ts" },
    })
    expect(defineConfig(cfg)).toBe(cfg)
  })

  it("preserves optional output field", () => {
    const cfg = defineConfig({
      ...minimalProject("test"),
      schema: { path: "./schema/index.ts" },
      output: { types: "./src/types.d.ts", client: "./src/client.ts" },
    })
    expect(cfg.output?.types).toBe("./src/types.d.ts")
    expect(cfg.output?.client).toBe("./src/client.ts")
  })
})

describe("loadConfig()", () => {
  it("throws when no config file exists in the directory", () => {
    expect(() => loadConfig(tmpDir)).toThrow(/No supatype.config.ts/)
  })

  it("loads a valid supatype.config.ts (plain export default, no package imports)", () => {
    const body = {
      ...minimalProject("mydb"),
      connection: "postgresql://localhost/mydb",
      schema: { path: "./schema/index.ts" },
    }
    writeFileSync(
      join(tmpDir, "supatype.config.ts"),
      `export default ${JSON.stringify(body)}
`,
    )
    const cfg = loadConfig(tmpDir)
    expect(cfg.connection).toBe("postgresql://localhost/mydb")
    expect(cfg.schema?.path).toBe("./schema/index.ts")
  })

  it("normalizes shorthand schema string to { path, pg_schema }", () => {
    writeFileSync(
      join(tmpDir, "supatype.config.ts"),
      `export default ${JSON.stringify({
        ...minimalProject("x"),
        schema: "./schema/index.ts",
      })}
`,
    )
    const cfg = loadConfig(tmpDir)
    expect(cfg.schema?.path).toBe("./schema/index.ts")
    expect(cfg.schema?.pg_schema).toBe("public")
  })

  it("loads a supatype.config.js (plain ESM)", () => {
    writeFileSync(
      join(tmpDir, "supatype.config.js"),
      `export default ${JSON.stringify({
        ...minimalProject("jsdb"),
        connection: "postgresql://localhost/jsdb",
        schema: { path: "./schema/index.ts" },
      })}
`,
    )
    const cfg = loadConfig(tmpDir)
    expect(cfg.connection).toBe("postgresql://localhost/jsdb")
  })

  it("throws if config is missing the versions section", () => {
    writeFileSync(
      join(tmpDir, "supatype.config.ts"),
      `export default {
  project: { name: "t" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
  schema: { path: "./schema/index.ts" },
}`,
    )
    expect(() => loadConfig(tmpDir)).toThrow(/versions/)
  })

  it("prefers supatype.config.ts over supatype.config.js when both exist", () => {
    writeFileSync(
      join(tmpDir, "supatype.config.ts"),
      `export default ${JSON.stringify({
        ...minimalProject("from-ts"),
        connection: "postgresql://localhost/from-ts",
        schema: { path: "./schema/index.ts" },
      })}`,
    )
    writeFileSync(
      join(tmpDir, "supatype.config.js"),
      `export default ${JSON.stringify({
        ...minimalProject("from-js"),
        connection: "postgresql://localhost/from-js",
        schema: { path: "./schema/index.ts" },
      })}`,
    )
    const cfg = loadConfig(tmpDir)
    expect(cfg.connection).toContain("from-ts")
  })

  it("supports optional output field in config", () => {
    writeFileSync(
      join(tmpDir, "supatype.config.ts"),
      `export default ${JSON.stringify({
        ...minimalProject("t"),
        schema: { path: "./schema/index.ts" },
        output: { types: "./src/types.d.ts" },
      })}`,
    )
    const cfg = loadConfig(tmpDir)
    expect(cfg.output?.types).toBe("./src/types.d.ts")
  })

  it("merges supatype.local.config.ts over base", () => {
    writeFileSync(
      join(tmpDir, "supatype.config.ts"),
      `export default ${JSON.stringify({
        ...minimalProject("base"),
        schema: { path: "./a.ts" },
        versions: {
          engine: "0.4.0",
          server: "0.1.0",
          postgres: "17",
          deno: "2.2.0",
        },
      })}`,
    )
    writeFileSync(
      join(tmpDir, "supatype.local.config.ts"),
      `export default ${JSON.stringify({
        versions: {
          engine: "0.4.2",
          server: "0.1.0",
          postgres: "17",
          deno: "2.2.0",
        },
      })}`,
    )
    const cfg = loadConfig(tmpDir)
    expect(cfg.versions.engine).toBe("0.4.2")
    expect(cfg.schema?.path).toBe("./a.ts")
  })
})

describe("mergeProjectConfig()", () => {
  it("deep-merges email.smtp between base and local", () => {
    const base = defineConfig({
      ...minimalProject("p"),
      email: { provider: "smtp", smtp: { host: "h1", port: 587, user: "u0" } },
    })
    const merged = mergeProjectConfig(base, { email: { smtp: { host: "h2", pass: "x" } } })
    expect(merged.email?.provider).toBe("smtp")
    expect(merged.email?.smtp?.host).toBe("h2")
    expect(merged.email?.smtp?.port).toBe(587)
    expect(merged.email?.smtp?.user).toBe("u0")
    expect(merged.email?.smtp?.pass).toBe("x")
  })

  it("overrides app.vite_dev_url from local", () => {
    const base = defineConfig({
      ...minimalProject("p"),
      app: { mode: "static", static_dir: "./dist", vite_dev_url: "http://127.0.0.1:1111" },
    })
    const merged = mergeProjectConfig(base, { app: { vite_dev_url: "http://127.0.0.1:5173" } })
    expect(merged.app.vite_dev_url).toBe("http://127.0.0.1:5173")
    expect(merged.app.mode).toBe("static")
    expect(merged.app.static_dir).toBe("./dist")
  })
})
