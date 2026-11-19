import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { tempProject } from "./support/command-run.js"
import { projectConfig } from "./support/project-config.js"

/**
 * A build is given the site's public values under each framework's prefix: the ones
 * `build.publicEnv` gives the environment, and on Cloud the ones set in Studio, the config winning.
 */
let config: SupatypeProjectConfig = projectConfig()
vi.mock("../src/config.js", async (importOriginal) => ({ ...(await importOriginal<object>()), loadConfig: () => config }))

const { buildPublicVars, resolveBuildPublicEnv, PublicEnvUnavailable } = await import("../src/site-public-env.js")

let project: { dir: string; remove: () => void }
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  project = tempProject("build-public-env")
  // The config is mocked; the file only has to be there for the project to have one.
  writeFileSync(join(project.dir, "supatype.config.ts"), "export default {}\n")
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "")
  vi.stubEnv("SUPATYPE_TOKEN", "")
  config = projectConfig()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  project.remove()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

function linkToCloud(): void {
  mkdirSync(join(project.dir, ".supatype"), { recursive: true })
  const env = { name: "production", apiUrl: "https://acme.supatype.dev", linkedAt: "2026-01-01T00:00:00Z" }
  writeFileSync(join(project.dir, ".supatype", "link.json"), JSON.stringify({
    version: 1, kind: "cloud", projectRef: "acme", defaultEnvironment: "production", cloudApiUrl: "https://cp.example", token: "user-jwt",
    environments: { production: env, staging: { ...env, name: "staging" } },
  }))
}

describe("resolveBuildPublicEnv", () => {
  it("takes the config of a project that has none to be empty, so an app folder can build", async () => {
    rmSync(join(project.dir, "supatype.config.ts"))
    expect(await resolveBuildPublicEnv(project.dir, {})).toEqual({ config: {}, studio: {} })
  })

  it("has nothing for a project that sets none, and asks no server", async () => {
    expect(await resolveBuildPublicEnv(project.dir, {})).toEqual({ config: {}, studio: {} })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("gives the config's values for the environment named, with no link", async () => {
    config = projectConfig({ build: { publicEnv: { A: "1", B: { production: "p", staging: "s" } } } })
    expect(await resolveBuildPublicEnv(project.dir, { env: "staging" })).toMatchObject({ config: { A: "1", B: "s" } })
    expect(await resolveBuildPublicEnv(project.dir, {})).toMatchObject({ config: { A: "1", B: "p" } })
  })

  it("keeps what is set in Studio apart from the config's, a name both set left to the config", async () => {
    linkToCloud()
    config = projectConfig({ build: { publicEnv: { A: "config" } } })
    fetchMock.mockResolvedValue(json({ data: { entries: [
      { name: "A", value: "config", source: "config" },
      { name: "S", value: "studio", source: "studio" },
    ] } }))
    expect(await resolveBuildPublicEnv(project.dir, {})).toEqual({ config: { A: "config" }, studio: { S: "studio" } })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://cp.example/api/v1/projects/acme/site/env")
    expect(new Headers(init?.headers).get("X-Supatype-Environment")).toBe("production")
  })

  it("asks for the environment --env names", async () => {
    linkToCloud()
    fetchMock.mockResolvedValue(json({ data: { entries: [] } }))
    await resolveBuildPublicEnv(project.dir, { env: "staging" })
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Supatype-Environment")).toBe("staging")
  })

  it("refuses to build without the values Studio sets when Cloud cannot give them", async () => {
    linkToCloud()
    fetchMock.mockResolvedValue(json({ error: "forbidden", message: "not a member" }, 403))
    const err: unknown = await resolveBuildPublicEnv(project.dir, {}).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(PublicEnvUnavailable)
    expect(err instanceof Error ? err.message : "").toContain("not a member")
  })

  it("leaves a server that predates public values to the config's", async () => {
    linkToCloud()
    config = projectConfig({ build: { publicEnv: { A: "1" } } })
    fetchMock.mockResolvedValue(json({ error: "not_found", message: "Route not found" }, 404))
    expect(await resolveBuildPublicEnv(project.dir, {})).toEqual({ config: { A: "1" }, studio: {} })
  })
})

describe("buildPublicVars: config, then the shell, then Studio", () => {
  const values = { config: { MAPS: "from-config" }, studio: { MAPS: "from-studio", ANALYTICS: "studio-a", FLAG: "studio-f" } }

  it("gives each value under every prefix", () => {
    expect(buildPublicVars({ config: { A: "1" }, studio: {} }, {})).toEqual({ VITE_A: "1", PUBLIC_A: "1", NEXT_PUBLIC_A: "1", EXPO_PUBLIC_A: "1" })
  })

  it("lets the config beat the shell, name for name", () => {
    expect(buildPublicVars(values, { VITE_MAPS: "from-shell" })["VITE_MAPS"]).toBe("from-config")
  })

  it("lets a same-named shell value beat Studio's, and only for that name", () => {
    const vars = buildPublicVars(values, { VITE_ANALYTICS: "from-shell" })
    expect(vars["VITE_ANALYTICS"]).toBeUndefined()
    expect(vars["PUBLIC_ANALYTICS"]).toBe("studio-a")
    expect(vars["VITE_FLAG"]).toBe("studio-f")
  })

  it("gives Studio's value when the shell sets none", () => {
    expect(buildPublicVars(values, {})["NEXT_PUBLIC_ANALYTICS"]).toBe("studio-a")
  })
})
