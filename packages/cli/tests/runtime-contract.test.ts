import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runtimeRouteSpec } from "../src/runtime-routes.js"
import { buildKongDeclarative } from "../src/kong-config.js"
import { renderSelfHostCompose, writeSelfHostCompose } from "../src/self-host-compose.js"
import { updateAppConfigInProject } from "../src/app-config.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { DENO_RELEASE_PIN } from "../src/release-pins.js"

const baseConfig: SupatypeProjectConfig = {
  project: { name: "acme" },
  database: { provider: "docker" },
  server: { mode: "dev" },
  app: { mode: "none" },
  versions: {
    engine: "0.4.2",
    server: "0.1.0",
    postgres: "17.2",
    deno: DENO_RELEASE_PIN,
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

  it("self-host kong routes studio auth and proxy to supatype-server before static studio", () => {
    const kong = buildKongDeclarative({ unifiedGateway: true })
    const studioAuthIdx = kong.indexOf("/studio/auth/")
    const studioProxyIdx = kong.indexOf("/studio/proxy/")
    const studioStaticIdx = kong.lastIndexOf("/studio/")
    expect(studioAuthIdx).toBeGreaterThan(-1)
    expect(studioProxyIdx).toBeGreaterThan(-1)
    expect(studioAuthIdx).toBeLessThan(studioStaticIdx)
    expect(studioProxyIdx).toBeLessThan(studioStaticIdx)
    expect(kong).toContain("name: supatype-server-studio-auth")
    expect(kong).toContain("name: supatype-server-studio-proxy")
  })

  it("self-host kong proxies exact /studio to studio UI", () => {
    const kong = buildKongDeclarative({ unifiedGateway: true })
    expect(kong).toContain("name: studio-exact")
    expect(kong).toContain("~/studio$")
    expect(kong).not.toContain("name: redirect")
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

  it("self-host compose includes schema-engine tools profile", () => {
    const compose = renderSelfHostCompose(baseConfig)
    expect(compose).toContain("\n  schema-engine:\n")
    expect(compose).toContain('profiles: ["tools"]')
    expect(compose).toContain("supatype/schema-engine:latest")
  })

  it("self-host compose mounts project root at /project (project-directory relative)", () => {
    const compose = renderSelfHostCompose(baseConfig)
    expect(compose).toContain("- .:/project")
    expect(compose).not.toMatch(/- \.\.\/\.\.:\/project/)
  })

  it("self-host compose mounts kong.yml from .supatype/self-host (project-directory relative)", () => {
    const compose = renderSelfHostCompose(baseConfig)
    expect(compose).toContain("- .supatype/self-host/kong.yml:/etc/kong/kong.yml:ro")
    expect(compose).not.toContain("- ./kong.yml:/etc/kong/kong.yml:ro")
  })

  it("devLocal compose omits host-published db and server ports", () => {
    const compose = renderSelfHostCompose(baseConfig, process.cwd(), { devLocal: true })
    expect(compose).not.toContain('"5432:5432"')
    expect(compose).not.toContain('"9999:9999"')
    expect(compose).toContain("${SUPATYPE_KONG_PORT:-18473}:8000")
    expect(compose).not.toContain("SUPATYPE_DEV_DB_PORT")
  })

  it("devLocal compose publishes db to host when overrides.engine is set", () => {
    const compose = renderSelfHostCompose(
      { ...baseConfig, overrides: { engine: "/tmp/supatype-engine" } },
      process.cwd(),
      { devLocal: true },
    )
    expect(compose).toContain("127.0.0.1:${SUPATYPE_DEV_DB_PORT:-54329}:5432")
    expect(compose).not.toContain('"5432:5432"')
  })

  it("devLocal proxy upstream rewrites localhost to host.docker.internal", () => {
    const compose = renderSelfHostCompose(
      { ...baseConfig, app: { mode: "proxy", upstream: "http://127.0.0.1:4321" } },
      process.cwd(),
      { devLocal: true },
    )
    expect(compose).toContain("SUPATYPE_APP_UPSTREAM: http://host.docker.internal:4321")
  })

  it("devLocal compose omits studio container when overrides.studio is set", () => {
    const compose = renderSelfHostCompose(
      { ...baseConfig, overrides: { studio: "../supatype/packages/studio" } },
      process.cwd(),
      { devLocal: true },
    )
    expect(compose).not.toContain("\n  studio:\n")
    expect(compose).not.toContain("depends_on:\n      - server\n      - studio")
  })

  it("devLocal kong routes studio to host Vite when overrides.studio is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "supatype-studio-host-"))
    try {
      writeSelfHostCompose(
        dir,
        { ...baseConfig, overrides: { studio: "../supatype/packages/studio" } },
        { devLocal: true },
      )
      const kong = readFileSync(join(dir, ".supatype", "self-host", "kong.yml"), "utf8")
      expect(kong).toContain("http://host.docker.internal:3002")
      expect(kong).not.toContain("http://studio:3002")
      expect(kong).toContain("strip_path: false")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("devLocal compose enables STUDIO_OPEN_DEV on supatype-server", () => {
    const compose = renderSelfHostCompose(baseConfig, process.cwd(), { devLocal: true })
    expect(compose).toContain('STUDIO_OPEN_DEV: "1"')
  })

  it("production self-host compose does not enable STUDIO_OPEN_DEV", () => {
    const compose = renderSelfHostCompose(baseConfig)
    expect(compose).not.toContain("STUDIO_OPEN_DEV")
  })

  it("self-host studio SUPATYPE_CLOUD_JSON omits serviceRoleKey", () => {
    const compose = renderSelfHostCompose(baseConfig)
    const match = compose.match(/SUPATYPE_CLOUD_JSON: '([^']+)'/)
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match![1]!) as Record<string, unknown>
    expect(parsed).toHaveProperty("url")
    expect(parsed).toHaveProperty("anonKey")
    expect(parsed).not.toHaveProperty("serviceRoleKey")
  })

  it("self-host compose runs per-project functions-worker and proxies via server", () => {
    const compose = renderSelfHostCompose(baseConfig)
    expect(compose).toContain("\n  functions-worker:\n")
    expect(compose).toContain("SUPATYPE_FUNCTIONS_WORKER_URL: http://functions-worker:8001")
    expect(compose).toContain("SUPATYPE_FUNCTIONS_ROOT: /project/functions")
    expect(compose).not.toContain("deploy/functions")
    expect(compose).not.toContain("supatype-functions")
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
      expect(compose).toContain("${SUPATYPE_POSTGRES_IMAGE:-supatype/postgres:latest}")
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
