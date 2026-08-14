import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let fakeHome = ""

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return {
    ...actual,
    homedir: () => (fakeHome.length > 0 ? fakeHome : actual.homedir()),
  }
})

import {
  cleanCachedBinaries,
  findSupatypeProjectDirs,
  pinnedVersionsFromConfigs,
} from "../src/cache-pins.js"
import { cachePath } from "../src/binary-cache.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

let counter = 0
let tmpDir: string

function minimalConfig(name: string, versions?: Partial<Record<string, string>>): SupatypeProjectConfig {
  return {
    project: { name },
    database: { provider: "docker" },
    server: { mode: "dev" },
    app: { mode: "none" },
    ...(versions !== undefined ? { versions } : {}),
  }
}

function writeProjectConfig(projectDir: string, config: SupatypeProjectConfig): void {
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(
    join(projectDir, "supatype.config.ts"),
    `export default ${JSON.stringify(config)}
`,
  )
}

function seedCache(component: "engine" | "server" | "postgres" | "deno" | "realtime", version: string, bytes = 8): string {
  const dir = cachePath(component, version)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "artifact.bin"), "x".repeat(bytes))
  return dir
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `supatype-cache-clean-${Date.now()}-${++counter}`)
  fakeHome = join(tmpDir, "home")
  mkdirSync(join(fakeHome, ".supatype", "cache"), { recursive: true })
})

afterEach(() => {
  fakeHome = ""
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("pinnedVersionsFromConfigs", () => {
  it("collects semver pins and ignores local", () => {
    const { protectedVersions, sources } = pinnedVersionsFromConfigs([
      {
        projectDir: "/proj/a",
        config: minimalConfig("alpha", { engine: "0.4.2", server: "local" }),
      },
      {
        projectDir: "/proj/b",
        config: minimalConfig("beta", { engine: "0.4.1", postgres: "17.2" }),
      },
    ])

    expect([...protectedVersions.get("engine")!].sort()).toEqual(["0.4.1", "0.4.2"])
    expect(protectedVersions.get("postgres")).toEqual(new Set(["17.2"]))
    expect(protectedVersions.has("server")).toBe(false)
    expect(sources).toHaveLength(3)
  })

  it("does not protect anything when versions block is absent", () => {
    const { protectedVersions } = pinnedVersionsFromConfigs([
      { projectDir: "/proj/x", config: minimalConfig("bare") },
    ])
    expect(protectedVersions.size).toBe(0)
  })
})

describe("cleanCachedBinaries", () => {
  it("removes all versions when nothing is pinned", () => {
    const v1 = `c13-a-${counter}`
    const v2 = `c13-b-${counter}`
    const v3 = `c13-c-${counter}`
    seedCache("engine", v1)
    seedCache("engine", v2)
    seedCache("engine", v3)

    const result = cleanCachedBinaries({
      components: ["engine"],
      projectDirs: [],
    })

    expect(result.removed.map((e) => e.version).sort()).toEqual([v1, v2, v3].sort())
    expect(result.skipped).toHaveLength(0)
    for (const v of [v1, v2, v3]) {
      expect(existsSync(cachePath("engine", v))).toBe(false)
    }
  })

  it("keeps pinned versions and removes the rest", () => {
    const pinned = `c13-pin-${counter}`
    const stale = `c13-stale-${counter}`
    seedCache("engine", pinned)
    seedCache("engine", stale)
    seedCache("server", "c13-srv-old")
    seedCache("server", "c13-srv-pin")

    const projectDir = join(tmpDir, "my-app")
    writeProjectConfig(
      projectDir,
      minimalConfig("my-app", { engine: pinned, server: "c13-srv-pin" }),
    )

    const result = cleanCachedBinaries({
      components: ["engine", "server"],
      projectDirs: [projectDir],
    })

    expect(result.removed.map((e) => `${e.component}@${e.version}`).sort()).toEqual([
      `engine@${stale}`,
      "server@c13-srv-old",
    ])
    expect(result.skipped.map((e) => `${e.component}@${e.version}`).sort()).toEqual([
      `engine@${pinned}`,
      "server@c13-srv-pin",
    ])
    expect(existsSync(cachePath("engine", pinned))).toBe(true)
    expect(existsSync(cachePath("engine", stale))).toBe(false)
  })

  it("--force removes pinned versions", () => {
    const pinned = `c13-force-${counter}`
    seedCache("engine", pinned)

    const projectDir = join(tmpDir, "forced")
    writeProjectConfig(projectDir, minimalConfig("forced", { engine: pinned }))

    const result = cleanCachedBinaries({
      components: ["engine"],
      force: true,
      projectDirs: [projectDir],
    })

    expect(result.removed).toHaveLength(1)
    expect(result.skipped).toHaveLength(0)
    expect(existsSync(cachePath("engine", pinned))).toBe(false)
  })

  it("explicit version removes even when pinned (with warning)", () => {
    const pinned = `c13-explicit-${counter}`
    seedCache("engine", pinned)

    const projectDir = join(tmpDir, "explicit")
    writeProjectConfig(projectDir, minimalConfig("explicit", { engine: pinned }))

    const result = cleanCachedBinaries({
      components: ["engine"],
      version: pinned,
      projectDirs: [projectDir],
    })

    expect(result.removed).toHaveLength(1)
    expect(result.warned.some((w) => w.includes("pinned"))).toBe(true)
    expect(existsSync(cachePath("engine", pinned))).toBe(false)
  })

  it("dry-run does not delete files", () => {
    const version = `c13-dry-${counter}`
    seedCache("engine", version)

    const result = cleanCachedBinaries({
      components: ["engine"],
      dryRun: true,
      projectDirs: [],
    })

    expect(result.removed).toHaveLength(1)
    expect(existsSync(cachePath("engine", version))).toBe(true)
  })
})

describe("findSupatypeProjectDirs", () => {
  it("finds nested projects up to max depth", () => {
    const root = join(tmpDir, "mono")
    const nested = join(root, "apps", "blog")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, "supatype.config.ts"), "export default {}")
    mkdirSync(join(root, "node_modules", "fake"), { recursive: true })
    writeFileSync(join(root, "node_modules", "fake", "supatype.config.ts"), "export default {}")

    const found = findSupatypeProjectDirs(root, 4)
    expect(found).toEqual([nested])
  })
})
