import { describe, expect, it } from "vitest"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { requiredHostComponents } from "../src/required-host-components.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

function baseConfig(provider: "docker" | "native"): SupatypeProjectConfig {
  return {
    project: { name: "test" },
    provider,
    database: { provider },
    server: { mode: "dev" },
    app: { mode: "none" },
  }
}

describe("requiredHostComponents", () => {
  it("returns engine for docker (types + admin config on the host)", () => {
    expect(requiredHostComponents(baseConfig("docker"))).toEqual(["engine"])
  })

  it("returns engine for docker with overrides.engine", () => {
    const config = baseConfig("docker")
    config.overrides = { engine: "/path/to/engine" }
    expect(requiredHostComponents(config)).toEqual(["engine"])
  })

  it("returns native core binaries without functions/", () => {
    const dir = join(tmpdir(), `supatype-req-host-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    expect(requiredHostComponents(baseConfig("native"), dir)).toEqual([
      "engine",
      "server",
      "postgres",
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  it("includes deno for native when functions/ exists", () => {
    const dir = join(tmpdir(), `supatype-req-host-fn-${Date.now()}`)
    mkdirSync(join(dir, "functions"), { recursive: true })
    expect(requiredHostComponents(baseConfig("native"), dir)).toEqual([
      "engine",
      "server",
      "postgres",
      "deno",
    ])
    rmSync(dir, { recursive: true, force: true })
  })
})
