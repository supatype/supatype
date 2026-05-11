import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  hasMeaningfulOverrides,
  isLinkedToCloudProject,
  resolveBinary,
  VERSION_PIN_LOCAL,
  describeActiveOverrides,
} from "../src/binary-cache.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

function baseConfig(overrides?: SupatypeProjectConfig["overrides"]): SupatypeProjectConfig {
  return {
    project: { name: "t" },
    database: { provider: "native" },
    server: { mode: "dev" },
    app: { mode: "none" },
    versions: { engine: "0.1.0", server: "0.1.0", postgres: "17", deno: "2.0.0" },
    ...(overrides !== undefined ? { overrides } : {}),
  }
}

let tmp: string
beforeEach(() => {
  tmp = join(tmpdir(), `dt-bc-${Date.now()}`)
  mkdirSync(join(tmp, ".supatype"), { recursive: true })
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("hasMeaningfulOverrides", () => {
  it("is false without overrides", () => {
    expect(hasMeaningfulOverrides(baseConfig())).toBe(false)
  })
  it("is false for empty strings only", () => {
    expect(hasMeaningfulOverrides(baseConfig({ engine: "  " }))).toBe(false)
  })
  it("is true when any path is non-empty", () => {
    expect(hasMeaningfulOverrides(baseConfig({ engine: "/x/y" }))).toBe(true)
  })
})

describe("isLinkedToCloudProject", () => {
  it("is true when project.ref is set", () => {
    const cfg = baseConfig()
    cfg.project.ref = "my-slug"
    expect(isLinkedToCloudProject(tmp, cfg)).toBe(true)
  })
  it("is true when .supatype/cloud.json has projectSlug", () => {
    writeFileSync(
      join(tmp, ".supatype", "cloud.json"),
      JSON.stringify({ apiUrl: "x", token: "t", projectSlug: "p" }),
    )
    expect(isLinkedToCloudProject(tmp, baseConfig())).toBe(true)
  })
  it("is true when .supatype/linked.json has ref", () => {
    writeFileSync(join(tmp, ".supatype", "linked.json"), JSON.stringify({ ref: "r1" }))
    expect(isLinkedToCloudProject(tmp, baseConfig())).toBe(true)
  })
  it("is false with token-only cloud.json", () => {
    writeFileSync(join(tmp, ".supatype", "cloud.json"), JSON.stringify({ apiUrl: "x", token: "t" }))
    expect(isLinkedToCloudProject(tmp, baseConfig())).toBe(false)
  })
})

describe("resolveBinary + cloud link", () => {
  const prevCwd = process.cwd()

  beforeEach(() => {
    process.chdir(tmp)
  })
  afterEach(() => {
    process.chdir(prevCwd)
  })

  it("rejects any meaningful overrides when cloud.json is linked", async () => {
    writeFileSync(
      join(tmp, ".supatype", "cloud.json"),
      JSON.stringify({ apiUrl: "x", token: "t", projectSlug: "p" }),
    )
    const cfg = baseConfig({ studio: "/does/not/need/to/exist/for/early/throw" })
    await expect(resolveBinary("engine", cfg)).rejects.toThrow(/linked to Supatype Cloud/)
  })
})

describe("VERSION_PIN_LOCAL + resolveBinary", () => {
  const prevCwd = process.cwd()

  beforeEach(() => {
    process.chdir(tmp)
  })
  afterEach(() => {
    process.chdir(prevCwd)
  })

  it("throws when versions.engine is local without overrides.engine", async () => {
    const cfg = baseConfig()
    cfg.versions.engine = VERSION_PIN_LOCAL
    await expect(resolveBinary("engine", cfg)).rejects.toThrow(/overrides\.engine/)
  })

  it("uses overrides.engine when versions.engine is local", async () => {
    const fakeBin = join(tmp, "supatype-engine-local")
    writeFileSync(fakeBin, "#")
    const cfg = baseConfig({ engine: fakeBin })
    cfg.versions.engine = VERSION_PIN_LOCAL
    const p = await resolveBinary("engine", cfg)
    expect(p.replace(/\\/g, "/")).toContain("supatype-engine-local")
  })
})

describe("describeActiveOverrides", () => {
  it("lists non-empty override paths", () => {
    const lines = describeActiveOverrides(
      baseConfig({ engine: "/a/b", server: "/c/d" }),
    )
    expect(lines.some((l) => l.includes("engine"))).toBe(true)
    expect(lines.some((l) => l.includes("/a/b"))).toBe(true)
  })
})
