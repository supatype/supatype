import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import {
  portFromUpstream,
  resolveProxyDevScript,
  resolveViteDirectSpawn,
} from "../src/app/proxy-dev-app.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

const base = {
  project: { name: "test" },
  database: { provider: "native" as const },
  server: { mode: "dev" as const },
  versions: { engine: "latest", server: "latest", postgres: "latest", deno: "latest" },
}

describe("resolveProxyDevScript()", () => {
  it("returns null when app.mode is not proxy", () => {
    const config = { ...base, app: { mode: "static" as const } } satisfies SupatypeProjectConfig
    expect(resolveProxyDevScript(config)).toBeNull()
  })

  it("defaults to start when proxy mode and app.start omitted", () => {
    const config = {
      ...base,
      app: { mode: "proxy" as const, upstream: "http://127.0.0.1:4321" },
    } satisfies SupatypeProjectConfig
    expect(resolveProxyDevScript(config)).toBe("start")
  })

  it("uses app.start when set", () => {
    const config = {
      ...base,
      app: { mode: "proxy" as const, upstream: "http://127.0.0.1:4321", start: "dev:site" },
    } satisfies SupatypeProjectConfig
    expect(resolveProxyDevScript(config)).toBe("dev:site")
  })
})

describe("portFromUpstream()", () => {
  it("parses port from upstream URL", () => {
    const config = {
      ...base,
      app: { mode: "proxy" as const, upstream: "http://localhost:5285" },
    } satisfies SupatypeProjectConfig
    expect(portFromUpstream(config)).toBe(5285)
  })

  it("returns null when upstream has no port", () => {
    const config = {
      ...base,
      app: { mode: "proxy" as const, upstream: "http://localhost" },
    } satisfies SupatypeProjectConfig
    expect(portFromUpstream(config)).toBeNull()
  })
})

describe("resolveViteDirectSpawn()", () => {
  it("returns node + vite.js for a plain vite script", () => {
    const appDir = join(tmpdir(), `supatype-vite-spawn-${Date.now()}`)
    const viteJs = join(appDir, "node_modules", "vite", "bin", "vite.js")
    mkdirSync(join(appDir, "node_modules", "vite", "bin"), { recursive: true })
    writeFileSync(viteJs, "")
    const result = resolveViteDirectSpawn(appDir, "dev:vite", { "dev:vite": "vite" })
    expect(result).not.toBeNull()
    expect(result?.bin).toBe(process.execPath)
    expect(result?.args[0]).toBe(viteJs)
    expect(result?.shell).toBe(false)
  })

  it("returns null for non-vite scripts", () => {
    const result = resolveViteDirectSpawn(process.cwd(), "dev", { dev: "next dev" })
    expect(result).toBeNull()
  })
})
