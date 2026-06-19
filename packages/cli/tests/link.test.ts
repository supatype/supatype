import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolveTarget, targetSchemaRollback } from "../src/resolve-target.js"
import { loadProjectLink, migrateLegacyLinkFiles } from "../src/link.js"
import { scaffold } from "../src/commands/init.js"

function writePlainConfig(dir: string): void {
  writeFileSync(
    join(dir, "supatype.config.ts"),
    `export default ${JSON.stringify({
      project: { name: "demo" },
      database: { provider: "docker" },
      server: { mode: "dev" },
      app: { mode: "none" },
      schema: { path: "schema/index.ts", pg_schema: "public" },
    })}
`,
  )
}

describe("link model", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "supatype-link-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("migrates cloud.json into link.json", () => {
    scaffold(tmp, "demo")
    mkdirSync(join(tmp, ".supatype"), { recursive: true })
    writeFileSync(join(tmp, ".supatype", "cloud.json"), JSON.stringify({
      apiUrl: "https://api.example.com",
      token: "pat",
      projectSlug: "myproj",
      orgId: "org1",
    }), { encoding: "utf8" })

    migrateLegacyLinkFiles(tmp)
    const link = loadProjectLink(tmp)
    expect(link?.kind).toBe("cloud")
    expect(link?.projectRef).toBe("myproj")
    expect(link?.environments.production?.apiUrl).toBe("https://api.example.com")
  })

  it("resolveTarget returns cloud mode with /api/v1 prefix", () => {
    writePlainConfig(tmp)
    mkdirSync(join(tmp, ".supatype"), { recursive: true })
    writeFileSync(join(tmp, ".supatype", "link.json"), JSON.stringify({
      version: 1,
      kind: "cloud",
      projectRef: "myproj",
      defaultEnvironment: "production",
      token: "pat",
      orgId: "org1",
      cloudApiUrl: "https://api.example.com",
      linkedAt: new Date().toISOString(),
      environments: {
        production: {
          name: "production",
          apiUrl: "https://myproj.supatype.dev",
          linkedAt: new Date().toISOString(),
        },
      },
    }))

    const target = resolveTarget(tmp)
    expect(target.mode).toBe("cloud")
    expect(target.apiPrefix).toBe("/api/v1")
    expect(target.apiBaseUrl).toBe("https://api.example.com")
  })

  it("resolveTarget returns self-host mode with /platform/v1 prefix", () => {
    writePlainConfig(tmp)
    mkdirSync(join(tmp, ".supatype"), { recursive: true })
    writeFileSync(join(tmp, ".supatype", "link.json"), JSON.stringify({
      version: 1,
      kind: "self-host",
      projectRef: "demo",
      defaultEnvironment: "production",
      linkedAt: new Date().toISOString(),
      environments: {
        production: {
          name: "production",
          apiUrl: "https://app.example.com",
          token: "srk",
          linkedAt: new Date().toISOString(),
        },
      },
    }))

    const target = resolveTarget(tmp)
    expect(target.mode).toBe("self-host")
    expect(target.apiPrefix).toBe("/platform/v1")
    expect(target.token).toBe("srk")
  })

  it("targetSchemaRollback posts to /platform/v1 when linked", async () => {
    writePlainConfig(tmp)
    mkdirSync(join(tmp, ".supatype"), { recursive: true })
    writeFileSync(join(tmp, ".supatype", "link.json"), JSON.stringify({
      version: 1,
      kind: "self-host",
      projectRef: "demo",
      defaultEnvironment: "production",
      linkedAt: new Date().toISOString(),
      environments: {
        production: {
          name: "production",
          apiUrl: "https://app.example.com",
          token: "srk",
          linkedAt: new Date().toISOString(),
        },
      },
    }))

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          status: "rolled_back",
          name: "push_test",
          message: "Rolled back migration push_test.",
        },
      }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const target = resolveTarget(tmp)
    await targetSchemaRollback(target, { schema: "public" })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://app.example.com/platform/v1/projects/demo/schema/rollback")
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({
      Authorization: "Bearer srk",
      "Content-Type": "application/json",
    })

    vi.unstubAllGlobals()
  })
})
