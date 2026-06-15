import { describe, expect, it } from "vitest"
import { resolveProxyDevScript } from "../src/app/proxy-dev-app.js"
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
