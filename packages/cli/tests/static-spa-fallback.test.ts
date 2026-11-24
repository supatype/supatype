import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveAppConfig } from "../src/app/framework.js"
import type { AppFramework } from "../src/config.js"
import { renderSelfHostCompose } from "../src/self-host-compose.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * A missing page on a plain static site serves index.html on both hosts, and `build.spa` (the
 * config's SPA setting) is honoured on both (E2E round 5, FF-8). Self-host's gateway defaulted it on
 * and ignored the config; the Cloud deploy took it from the detected framework, off for a plain
 * static site.
 */
const baseConfig: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "static", static_dir: "./public" },
}

describe("self-host: build.spa reaches the gateway", () => {
  it("emits SUPATYPE_APP_SPA_FALLBACK false when build.spa is false", () => {
    const compose = renderSelfHostCompose({ ...baseConfig, build: { spa: false } })
    expect(compose).toContain('SUPATYPE_APP_SPA_FALLBACK: "false"')
  })

  it("emits SUPATYPE_APP_SPA_FALLBACK true when build.spa is true", () => {
    const compose = renderSelfHostCompose({ ...baseConfig, build: { spa: true } })
    expect(compose).toContain('SUPATYPE_APP_SPA_FALLBACK: "true"')
  })

  it("leaves the gateway's own default (on) when build.spa is not set", () => {
    expect(renderSelfHostCompose(baseConfig)).not.toContain("SUPATYPE_APP_SPA_FALLBACK")
    expect(renderSelfHostCompose({ ...baseConfig, build: { framework: "static" } })).not.toContain("SUPATYPE_APP_SPA_FALLBACK")
  })

  it("emits nothing when the app is not a static one", () => {
    const compose = renderSelfHostCompose({ ...baseConfig, app: { mode: "none" }, build: { spa: false } })
    expect(compose).not.toContain("SUPATYPE_APP_SPA_FALLBACK")
  })
})

describe("Cloud deploy: the SPA default per framework", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-spa-"))
    mkdirSync(join(dir, "app"), { recursive: true })
    writeFileSync(join(dir, "app", "index.html"), "<html></html>")
    writeFileSync(join(dir, "app", "package.json"), "{}")
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const spaOf = (framework: AppFramework, spa?: boolean): boolean =>
    resolveAppConfig({ framework, directory: "app", ...(spa !== undefined && { spa }) }, dir).spa

  it("serves index.html for a missing page on a plain static site", () => {
    expect(spaOf("static")).toBe(true)
  })

  it("honours build.spa false on a plain static site", () => {
    expect(spaOf("static", false)).toBe(false)
  })

  it("leaves every other framework's default as it was", () => {
    expect(spaOf("vite")).toBe(true)
    expect(spaOf("remix-spa")).toBe(true)
    expect(spaOf("nextjs")).toBe(false)
    expect(spaOf("astro")).toBe(false)
    expect(spaOf("sveltekit")).toBe(false)
    expect(spaOf("nuxt")).toBe(false)
  })

  it("detects a plain static site by its index.html and defaults it to the fallback", () => {
    expect(resolveAppConfig({ directory: "app" }, dir).spa).toBe(true)
  })
})
