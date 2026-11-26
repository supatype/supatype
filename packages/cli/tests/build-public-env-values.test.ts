import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PublicEnvEntry } from "@supatype/types"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { tempProject } from "./support/command-run.js"
import { projectConfig } from "./support/project-config.js"

/**
 * A build is given the site's public values under each framework's prefix: the ones
 * `build.publicEnv` gives the environment, and on Cloud the ones set in Studio. The config wins, then
 * a variable the shell already sets, then Studio.
 */
let config: SupatypeProjectConfig = projectConfig()
const loadConfig = vi.fn((): SupatypeProjectConfig => config)
vi.mock("../src/config.js", async (importOriginal) => ({ ...(await importOriginal<object>()), loadConfig }))

const { buildPublicVars, publicValueCount, resolveBuildPublicEnv, siteScope, PublicEnvUnavailable } = await import("../src/site-public-env.js")
const { siteBuildEnv } = await import("../src/site-build-env.js")
const { BuildRefused } = await import("../src/build-refused.js")
const { FrontendValuesRefused } = await import("../src/frontend-values.js")

let project: { dir: string; remove: () => void }
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  project = tempProject("build-public-env")
  // The config is mocked; the file only has to be there for the project to have one.
  writeFileSync(join(project.dir, "supatype.config.ts"), "export default {}\n")
  fetchMock.mockReset()
  loadConfig.mockClear()
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
const scopeOf = (env?: string) => siteScope(project.dir, { env, tokenOptional: true })

function linkToCloud(): void {
  mkdirSync(join(project.dir, ".supatype"), { recursive: true })
  const env = { name: "production", apiUrl: "https://acme.supatype.dev", linkedAt: "2026-01-01T00:00:00Z" }
  writeFileSync(join(project.dir, ".supatype", "link.json"), JSON.stringify({
    version: 1, kind: "cloud", projectRef: "acme", defaultEnvironment: "production", cloudApiUrl: "https://cp.example", token: "user-jwt",
    environments: { production: env, staging: { ...env, name: "staging" } },
  }))
}

describe("siteScope", () => {
  it("is production, with the config's values and no Cloud target, when there is no link", () => {
    config = projectConfig({ build: { publicEnv: { A: "1", B: { production: "p", staging: "s" } } } })
    expect(scopeOf()).toEqual({ environment: "production", cloud: undefined, config: { A: "1", B: "p" } })
    expect(scopeOf("staging").config).toEqual({ A: "1", B: "s" })
  })

  it("takes a project with no config file to have none, so an app folder can build", () => {
    rmSync(join(project.dir, "supatype.config.ts"))
    expect(scopeOf().config).toEqual({})
    expect(loadConfig).not.toHaveBeenCalled()
  })

  it("names the Cloud target of a Cloud link, for the environment asked for", () => {
    linkToCloud()
    const scope = scopeOf("staging")
    expect(scope.environment).toBe("staging")
    expect(scope.cloud?.projectRef).toBe("acme")
  })

  it("reads the config once", () => {
    scopeOf()
    expect(loadConfig).toHaveBeenCalledTimes(1)
  })
})

describe("resolveBuildPublicEnv", () => {
  it("is empty for a project that sets none, and asks no server", async () => {
    expect(await resolveBuildPublicEnv(scopeOf())).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("lists the config's values as set in the config", async () => {
    config = projectConfig({ build: { publicEnv: { A: "1" } } })
    expect(await resolveBuildPublicEnv(scopeOf())).toEqual([{ name: "A", value: "1", source: "config" }])
  })

  it("adds what Studio set on a Cloud link, for the names the config does not set", async () => {
    linkToCloud()
    config = projectConfig({ build: { publicEnv: { A: "config" } } })
    fetchMock.mockResolvedValue(json({ data: { entries: [
      { name: "A", value: "config", source: "config" },
      { name: "S", value: "studio", source: "studio" },
    ] } }))
    expect(await resolveBuildPublicEnv(scopeOf())).toEqual([
      { name: "A", value: "config", source: "config" },
      { name: "S", value: "studio", source: "studio" },
    ])
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://cp.example/api/v1/projects/acme/site/env")
    expect(new Headers(init?.headers).get("X-Supatype-Environment")).toBe("production")
  })

  it("asks for the environment --env names", async () => {
    linkToCloud()
    fetchMock.mockResolvedValue(json({ data: { entries: [] } }))
    await resolveBuildPublicEnv(scopeOf("staging"))
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Supatype-Environment")).toBe("staging")
  })

  it("refuses to build without the values Studio sets when Cloud cannot give them", async () => {
    linkToCloud()
    fetchMock.mockResolvedValue(json({ error: "forbidden", message: "not a member" }, 403))
    const err: unknown = await resolveBuildPublicEnv(scopeOf()).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(PublicEnvUnavailable)
    expect(err instanceof Error ? err.message : "").toContain("not a member")
  })

  it("leaves a server that predates public values to the config's", async () => {
    linkToCloud()
    config = projectConfig({ build: { publicEnv: { A: "1" } } })
    fetchMock.mockResolvedValue(json({ error: "not_found", message: "Route not found" }, 404))
    expect(await resolveBuildPublicEnv(scopeOf())).toEqual([{ name: "A", value: "1", source: "config" }])
  })
})

describe("buildPublicVars: config, then the shell, then Studio", () => {
  const entries: PublicEnvEntry[] = [
    { name: "MAPS", value: "from-config", source: "config" },
    { name: "ANALYTICS", value: "studio-a", source: "studio" },
    { name: "FLAG", value: "studio-f", source: "studio" },
  ]

  it("gives each value under every prefix", () => {
    expect(buildPublicVars([{ name: "A", value: "1", source: "config" }], {})).toEqual({ VITE_A: "1", PUBLIC_A: "1", NEXT_PUBLIC_A: "1", EXPO_PUBLIC_A: "1" })
  })

  it("lets the config beat the shell, name for name", () => {
    expect(buildPublicVars(entries, { VITE_MAPS: "from-shell" })["VITE_MAPS"]).toBe("from-config")
  })

  it("lets a same-named shell value beat Studio's, and only for that name", () => {
    const vars = buildPublicVars(entries, { VITE_ANALYTICS: "from-shell" })
    expect(vars["VITE_ANALYTICS"]).toBeUndefined()
    expect(vars["PUBLIC_ANALYTICS"]).toBe("studio-a")
    expect(vars["VITE_FLAG"]).toBe("studio-f")
  })

  it("gives Studio's value when the shell sets none", () => {
    expect(buildPublicVars(entries, {})["NEXT_PUBLIC_ANALYTICS"]).toBe("studio-a")
  })
})

describe("siteBuildEnv", () => {
  it("is the public values and the address and anon key, under every prefix, and says how many values", async () => {
    config = projectConfig({ build: { publicEnv: { A: "1" } } })
    const built = await siteBuildEnv(project.dir, { shell: { SUPATYPE_URL: "https://api.example.com", SUPATYPE_ANON_KEY: "anon-key-value" } })
    expect(built.vars["VITE_A"]).toBe("1")
    expect(built.vars["NEXT_PUBLIC_SUPATYPE_URL"]).toBe("https://api.example.com")
    expect(built.vars["EXPO_PUBLIC_SUPATYPE_ANON_KEY"]).toBe("anon-key-value")
    expect(built.publicCount).toBe(1)
  })

  it("refuses with a BuildRefused when the address or key is missing, and when Studio's values cannot be read", async () => {
    const missing: unknown = await siteBuildEnv(project.dir, { shell: {} }).then(() => undefined, (e: unknown) => e)
    expect(missing).toBeInstanceOf(FrontendValuesRefused)
    expect(missing).toBeInstanceOf(BuildRefused)
    linkToCloud()
    fetchMock.mockResolvedValue(json({ error: "forbidden", message: "not a member" }, 403))
    const unavailable: unknown = await siteBuildEnv(project.dir, { shell: { SUPATYPE_URL: "https://api.example.com", SUPATYPE_ANON_KEY: "k" } }).then(() => undefined, (e: unknown) => e)
    expect(unavailable).toBeInstanceOf(PublicEnvUnavailable)
    expect(unavailable).toBeInstanceOf(BuildRefused)
  })
})

describe("publicValueCount", () => {
  it("says how many values, the same way everywhere", () => {
    expect(publicValueCount(1)).toBe("1 public value(s)")
    expect(publicValueCount(3)).toBe("3 public value(s)")
  })
})
