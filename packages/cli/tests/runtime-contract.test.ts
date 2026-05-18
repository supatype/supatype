import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runtimeRouteSpec } from "../src/runtime-routes.js"
import { buildKongDeclarative } from "../src/kong-config.js"
import { renderSelfHostCompose, writeSelfHostCompose } from "../src/self-host-compose.js"
import { updateAppConfigInProject } from "../src/app-config.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

const baseConfig: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
  versions: {
    engine: "0.4.2",
    server: "0.1.0",
    postgres: "17.2",
    deno: "2.2.0",
  },
}

describe("runtime contract", () => {
  it("includes core route families", () => {
    const paths = runtimeRouteSpec().flatMap((r) => r.paths)
    for (const path of ["/rest/v1/", "/auth/v1/", "/storage/v1/", "/realtime/v1/", "/functions/v1/"]) {
      expect(paths).toContain(path)
    }
  })

  it("renders app root route when upstream is provided", () => {
    const paths = runtimeRouteSpec({ appUpstream: "http://app:3000" }).flatMap((r) => r.paths)
    expect(paths).toContain("/")
  })

  it("renders app root route for static service URL", () => {
    const paths = runtimeRouteSpec({ staticAppServiceUrl: "http://static-app:8080" }).flatMap((r) => r.paths)
    expect(paths).toContain("/")
  })

  it("self-host kong uses unified supatype-server gateway", () => {
    const kong = buildKongDeclarative({ unifiedGateway: true })
    expect(kong).toContain("http://server:9999")
    expect(kong).toContain("/rest/v1/")
    expect(kong).toContain("/auth/v1/")
    expect(kong).toContain("/storage/v1/")
    expect(kong).toContain("/realtime/v1/")
    expect(kong).toContain("/functions/v1/")
    expect(kong).not.toContain("http://postgrest:3000")
    expect(kong).not.toContain("http://storage:5000")
  })

  it("kong declarative output contains route contract paths", () => {
    const kong = buildKongDeclarative({ appUpstream: "http://app:3000" })
    expect(kong).toContain("/rest/v1/")
    expect(kong).toContain("/auth/v1/")
    expect(kong).toContain("/storage/v1/")
    expect(kong).toContain("/realtime/v1/")
    expect(kong).toContain("/functions/v1/")
    expect(kong).toContain("- /")
  })

  it("self-host compose render is deterministic for same config", () => {
    const first = renderSelfHostCompose({ ...baseConfig, app: { mode: "proxy", upstream: "http://app:3000" } })
    const second = renderSelfHostCompose({ ...baseConfig, app: { mode: "proxy", upstream: "http://app:3000" } })
    expect(first).toBe(second)
  })

  it("self-host compose does not inject a synthetic app-proxy service", () => {
    const compose = renderSelfHostCompose({ ...baseConfig, app: { mode: "proxy", upstream: "http://app:3000" } })
    expect(compose).not.toContain("ghcr.io/supatype/app-proxy")
    expect(compose).not.toContain("\n  app:\n")
  })

  it("self-host compose configures static app on supatype-server", () => {
    const compose = renderSelfHostCompose({ ...baseConfig, app: { mode: "static", static_dir: "./public" } })
    expect(compose).toContain('SUPATYPE_APP_MODE: static')
    expect(compose).toContain("SUPATYPE_APP_STATIC_DIR: /project/public")
    expect(compose).not.toContain("static-app:")
  })

  it("app config updater writes proxy mode intent", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-app-config-"))
    try {
      const configPath = join(dir, "supatype.config.ts")
      writeFileSync(
        configPath,
        `export default {
  project: { name: "x" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: {
    mode: "none",
    // mode: "static", static_dir: "./dist",
    // mode: "proxy", upstream: "http://localhost:3000",
  },
  versions: { engine: "0", server: "0", postgres: "0", deno: "0" },
}
`,
        "utf8",
      )
      updateAppConfigInProject(dir, { mode: "proxy", upstream: "http://localhost:7777" })
      const next = readFileSync(configPath, "utf8")
      expect(next).toContain(`mode: "proxy"`)
      expect(next).toContain(`upstream: "http://localhost:7777"`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("app config updater handles defineConfig wrappers", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-app-config-"))
    try {
      const configPath = join(dir, "supatype.config.ts")
      writeFileSync(
        configPath,
        `import { defineConfig } from "@supatype/cli"

export default defineConfig({
  project: { name: "x" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
  versions: { engine: "0", server: "0", postgres: "0", deno: "0" },
})
`,
        "utf8",
      )
      updateAppConfigInProject(dir, { mode: "static", staticDir: "./site" })
      const next = readFileSync(configPath, "utf8")
      expect(next).toContain(`mode: "static"`)
      expect(next).toContain(`static_dir: "./site"`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("app config updater inserts app block when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-app-config-"))
    try {
      const configPath = join(dir, "supatype.config.ts")
      writeFileSync(
        configPath,
        `export default {
  project: { name: "x" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  versions: { engine: "0", server: "0", postgres: "0", deno: "0" },
}
`,
        "utf8",
      )
      updateAppConfigInProject(dir, { mode: "none" })
      const next = readFileSync(configPath, "utf8")
      expect(next).toContain("app:")
      expect(next).toContain(`mode: "none"`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("app config updater preserves unrelated app keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-app-config-"))
    try {
      const configPath = join(dir, "supatype.config.ts")
      writeFileSync(
        configPath,
        `export default {
  project: { name: "x" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: {
    mode: "proxy",
    upstream: "http://localhost:3000",
    headers: { "x-feature": "on" },
  },
  versions: { engine: "0", server: "0", postgres: "0", deno: "0" },
}
`,
        "utf8",
      )
      updateAppConfigInProject(dir, { mode: "proxy", upstream: "http://localhost:8080" })
      const next = readFileSync(configPath, "utf8")
      expect(next).toContain(`upstream: "http://localhost:8080"`)
      expect(next).toContain(`headers`)
      expect(next).toContain(`"x-feature"`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writes self-host compose artifacts under .supatype/self-host", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-compose-"))
    try {
      const out = writeSelfHostCompose(dir, { ...baseConfig, app: { mode: "none" } })
      expect(out.composePath).toContain(".supatype")
      expect(readFileSync(out.composePath, "utf8")).toContain("services:")
      expect(readFileSync(out.kongPath, "utf8")).toContain("/rest/v1/")
      const compose = readFileSync(out.composePath, "utf8")
      expect(compose).toContain("${SUPATYPE_POSTGRES_IMAGE:-supatype/postgres:17-latest}")
      expect(compose).toContain("${SUPATYPE_SERVER_IMAGE:-${SUPATYPE_AUTH_IMAGE:-supatype/server:latest}}")
      expect(compose).toContain("${SUPATYPE_STORAGE_IMAGE:-supatype/storage:latest}")
      expect(compose).toContain("${SUPATYPE_STUDIO_IMAGE:-supatype/studio:latest}")
      expect(compose).toContain("SUPATYPE_POSTGREST_URL: http://postgrest:3000")
      expect(compose).toContain("unified gateway")
      const kong = readFileSync(out.kongPath, "utf8")
      expect(kong).toContain("http://server:9999")
      expect(kong).not.toContain("http://postgrest:3000")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writes default manifest when missing for compose", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-manifest-"))
    try {
      writeSelfHostCompose(dir, { ...baseConfig, app: { mode: "none" } })
      const manifest = readFileSync(join(dir, ".supatype", "manifest.json"), "utf8")
      expect(manifest).toContain("postgrest_url")
      expect(manifest).toContain("http://postgrest:3000")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
