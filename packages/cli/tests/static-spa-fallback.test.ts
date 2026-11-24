import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resolveAppConfig, resolveSpaFallback, spaIndexError } from "../src/app/framework.js"
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

  it.each([
    ["vite", "true"],
    ["remix-spa", "true"],
    ["static", "true"],
    ["nextjs", "false"],
    ["astro", "false"],
    ["sveltekit", "false"],
    ["nuxt", "false"],
  ] as const)("emits Cloud's default for %s when build.spa is not set: %s", (framework, value) => {
    const compose = renderSelfHostCompose({ ...baseConfig, build: { framework } })
    expect(compose).toContain(`SUPATYPE_APP_SPA_FALLBACK: "${value}"`)
  })

  it("emits on when there is no build section and no framework to take a default from", () => {
    expect(renderSelfHostCompose(baseConfig)).toContain('SUPATYPE_APP_SPA_FALLBACK: "true"')
  })

  it("lets build.spa override the framework default", () => {
    expect(renderSelfHostCompose({ ...baseConfig, build: { framework: "nextjs", spa: true } })).toContain('SUPATYPE_APP_SPA_FALLBACK: "true"')
  })

  it("says the config set it only when build.spa is set", () => {
    expect(renderSelfHostCompose({ ...baseConfig, build: { spa: false } })).toContain('SUPATYPE_APP_SPA_FALLBACK_FROM_CONFIG: "true"')
    expect(renderSelfHostCompose({ ...baseConfig, build: { framework: "vite" } })).not.toContain("SUPATYPE_APP_SPA_FALLBACK_FROM_CONFIG")
    expect(renderSelfHostCompose(baseConfig)).not.toContain("SUPATYPE_APP_SPA_FALLBACK_FROM_CONFIG")
  })

  it("emits nothing when the app is not a static one", () => {
    const compose = renderSelfHostCompose({ ...baseConfig, app: { mode: "none" }, build: { spa: false } })
    expect(compose).not.toContain("SUPATYPE_APP_SPA_FALLBACK")
  })

  it("detects the framework from the app directory when asked to resolve for a folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-spa-resolve-"))
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "15.0.0" } }))
      expect(resolveSpaFallback(undefined, dir)).toBe(false)
      expect(resolveSpaFallback({ spa: true }, dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("a deploy with the fallback on needs a root index.html", () => {
  let out: string

  beforeEach(() => {
    out = mkdtempSync(join(tmpdir(), "supatype-spa-out-"))
  })

  afterEach(() => {
    rmSync(out, { recursive: true, force: true })
  })

  it("refuses, naming index.html and build.spa: false, when it is missing", () => {
    mkdirSync(join(out, "docs"))
    writeFileSync(join(out, "docs", "index.html"), "<html></html>")
    const message = spaIndexError(out, true)
    expect(message).toMatch(/index.html/)
    expect(message).toMatch(/build.spa: false/)
  })

  it("passes when index.html is at the root", () => {
    writeFileSync(join(out, "index.html"), "<html></html>")
    expect(spaIndexError(out, true)).toBeNull()
  })

  it("passes without one when the fallback is off", () => {
    expect(spaIndexError(out, false)).toBeNull()
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
