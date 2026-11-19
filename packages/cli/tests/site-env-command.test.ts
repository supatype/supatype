import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { tempProject } from "./support/command-run.js"
import { projectConfig } from "./support/project-config.js"

/**
 * `supatype site env pull | list | set | unset [--env <name>]`. On Cloud the values are the
 * control plane's, with where each is set; anywhere else they are `build.publicEnv`'s alone.
 */
let config: SupatypeProjectConfig = projectConfig()
vi.mock("../src/config.js", async (importOriginal) => ({ ...(await importOriginal<object>()), loadConfig: () => config }))

const { listSiteEnv, pullSiteEnv, setSiteEnv, unsetSiteEnv, pullFileName, siteEnvLines } = await import("../src/commands/site.js")

let project: { dir: string; remove: () => void }
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const ENTRIES = [
  { name: "MAPS_KEY", value: "from-config", source: "config" },
  { name: "ANALYTICS", value: "a1", source: "studio" },
]

beforeEach(() => {
  project = tempProject("site-env-command")
  writeFileSync(join(project.dir, "supatype.config.ts"), "export default {}\n")
  config = projectConfig({ build: { publicEnv: { MAPS_KEY: "from-config" } } })
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("SUPATYPE_ACCESS_TOKEN", "")
  vi.stubEnv("SUPATYPE_TOKEN", "")
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  project.remove()
})

function linkToCloud(): void {
  mkdirSync(join(project.dir, ".supatype"), { recursive: true })
  const env = { name: "production", apiUrl: "https://acme.supatype.dev", linkedAt: "2026-01-01T00:00:00Z" }
  writeFileSync(join(project.dir, ".supatype", "link.json"), JSON.stringify({
    version: 1, kind: "cloud", projectRef: "acme", defaultEnvironment: "production", cloudApiUrl: "https://cp.example", token: "user-jwt",
    environments: { production: env, staging: { ...env, name: "staging" } },
  }))
}

describe("pullFileName", () => {
  it("is .env.<environment>.local", () => {
    expect(pullFileName("production")).toBe(".env.production.local")
    expect(pullFileName("staging")).toBe(".env.staging.local")
  })
  it("keeps a branch environment's colon out of a file name", () => {
    expect(pullFileName("branch:abc")).toBe(".env.branch-abc.local")
  })
})

describe("supatype site env pull", () => {
  it("writes the values set in Studio under every prefix, and skips those the config sets", async () => {
    linkToCloud()
    fetchMock.mockResolvedValue(json({ data: { entries: ENTRIES } }))
    const pulled = await pullSiteEnv(project.dir, {})
    expect(pulled.file).toBe(".env.production.local")
    expect(pulled.names).toEqual(["ANALYTICS"])
    const text = readFileSync(join(project.dir, ".env.production.local"), "utf8")
    for (const prefix of ["VITE_", "PUBLIC_", "NEXT_PUBLIC_", "EXPO_PUBLIC_"]) expect(text).toContain(`${prefix}ANALYTICS=a1`)
    expect(text).not.toContain("MAPS_KEY")
  })

  it("includes the config's values when asked", async () => {
    linkToCloud()
    fetchMock.mockResolvedValue(json({ data: { entries: ENTRIES } }))
    const pulled = await pullSiteEnv(project.dir, { includeConfig: true })
    expect(pulled.names).toEqual(["ANALYTICS", "MAPS_KEY"])
    expect(readFileSync(join(project.dir, ".env.production.local"), "utf8")).toContain("VITE_MAPS_KEY=from-config")
  })

  it("names the environment --env gives", async () => {
    linkToCloud()
    fetchMock.mockResolvedValue(json({ data: { entries: ENTRIES } }))
    const pulled = await pullSiteEnv(project.dir, { env: "staging" })
    expect(pulled.file).toBe(".env.staging.local")
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Supatype-Environment")).toBe("staging")
  })

  it("updates the names it writes and keeps what else the file holds", async () => {
    linkToCloud()
    writeFileSync(join(project.dir, ".env.production.local"), "OTHER=keep\nVITE_ANALYTICS=old\nVITE_GONE=old\n")
    fetchMock.mockResolvedValue(json({ data: { entries: ENTRIES } }))
    await pullSiteEnv(project.dir, {})
    const text = readFileSync(join(project.dir, ".env.production.local"), "utf8")
    expect(text).toContain("OTHER=keep")
    expect(text).toContain("VITE_ANALYTICS=a1")
    expect(text).toContain("VITE_GONE=old")
  })

  it("writes no file when nothing is set in Studio", async () => {
    linkToCloud()
    fetchMock.mockResolvedValue(json({ data: { entries: [ENTRIES[0]] } }))
    const pulled = await pullSiteEnv(project.dir, {})
    expect(pulled.names).toEqual([])
    expect(existsSync(join(project.dir, ".env.production.local"))).toBe(false)
  })

  it("without a Cloud link has only the config's values to give, which are skipped", async () => {
    const pulled = await pullSiteEnv(project.dir, {})
    expect(pulled.names).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("supatype site env list", () => {
  it("says where each value is set", async () => {
    linkToCloud()
    fetchMock.mockResolvedValue(json({ data: { entries: ENTRIES } }))
    const lines = siteEnvLines(await listSiteEnv(project.dir, {}))
    expect(lines.join("\n")).toMatch(/MAPS_KEY\s+from-config\s+set in supatype\.config\.ts/)
    expect(lines.join("\n")).toMatch(/ANALYTICS\s+a1\s+set in Studio/)
  })

  it("lists the config's values for a project with no Cloud link", async () => {
    const entries = await listSiteEnv(project.dir, {})
    expect(entries).toEqual([{ name: "MAPS_KEY", value: "from-config", source: "config" }])
  })
})

describe("supatype site env set and unset", () => {
  it("set sends the value to Cloud for the environment", async () => {
    linkToCloud()
    fetchMock.mockResolvedValue(json({ data: { name: "ANALYTICS", value: "a2", source: "studio" } }))
    await setSiteEnv(project.dir, "ANALYTICS", "a2", { env: "staging" })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe("https://cp.example/api/v1/projects/acme/site/env/ANALYTICS")
    expect(init?.method).toBe("PUT")
    expect(new Headers(init?.headers).get("X-Supatype-Environment")).toBe("staging")
  })

  it("unset removes it", async () => {
    linkToCloud()
    fetchMock.mockResolvedValue(json({ data: { name: "ANALYTICS" } }))
    await unsetSiteEnv(project.dir, "ANALYTICS", {})
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE")
  })

  it("refuse, without a request, a target that is not Supatype Cloud, saying where to set values", async () => {
    await expect(setSiteEnv(project.dir, "A", "1", {})).rejects.toThrow(/build\.publicEnv/)
    await expect(unsetSiteEnv(project.dir, "A", {})).rejects.toThrow(/build\.publicEnv/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
