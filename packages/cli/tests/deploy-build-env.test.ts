import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SupatypeProjectConfig } from "../src/project-config.js"
import { signJwt } from "../src/jwt.js"
import { tempProject } from "./support/command-run.js"
import { projectConfig } from "./support/project-config.js"

/**
 * `deploy` built a linked project's app with the URL copies and never the anon key, so the site it
 * uploaded rendered a blank page (issue 29). Its build now gets both through the same resolver as
 * `supatype build`, and the service role key never.
 */
const loadConfig = vi.fn((): SupatypeProjectConfig => projectConfig({ project: { name: "acme" } }))
vi.mock("../src/config.js", async (importOriginal) => ({ ...(await importOriginal<object>()), loadConfig }))

const { deployBuildEnv } = await import("../src/commands/deploy.js")

const SECRET = "deploy-build-env-test-secret-32-chars!"
const ANON = signJwt({ iss: "supatype", role: "anon" }, SECRET)
const SERVICE = signJwt({ iss: "supatype", role: "service_role" }, SECRET)
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
let project: { dir: string; remove: () => void }

beforeEach(() => {
  project = tempProject("deploy-build-env")
  mkdirSync(join(project.dir, ".supatype"), { recursive: true })
  writeFileSync(join(project.dir, ".supatype", "link.json"), JSON.stringify({
    version: 1, kind: "cloud", projectRef: "acme", defaultEnvironment: "production", token: "user-jwt",
    cloudApiUrl: "https://cp.example",
    environments: { production: { name: "production", apiUrl: "https://acme.supatype.dev", linkedAt: "2026-01-01T00:00:00Z" } },
  }))
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { anonKey: ANON, serviceRoleKey: SERVICE } }), { status: 200 }))
  vi.stubGlobal("fetch", fetchMock)
  for (const name of Object.keys(process.env)) if (/SUPATYPE_(URL|ANON_KEY|ACCESS_TOKEN|TOKEN)$/.test(name)) vi.stubEnv(name, "")
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  project.remove()
})

describe("deployBuildEnv", () => {
  it("gives a linked Cloud project's build the environment's address and anon key under every prefix", async () => {
    const env = await deployBuildEnv(project.dir, { env: "production", appEnv: {} })
    for (const prefix of ["VITE_", "PUBLIC_", "NEXT_PUBLIC_", "EXPO_PUBLIC_"]) {
      expect(env[`${prefix}SUPATYPE_URL`], `${prefix}SUPATYPE_URL`).toBe("https://acme.supatype.dev")
      expect(env[`${prefix}SUPATYPE_ANON_KEY`], `${prefix}SUPATYPE_ANON_KEY`).toBe(ANON)
    }
    expect(Object.values(env)).not.toContain(SERVICE)
  })

  it("keeps the app's own build.env values, which the resolver reads first", async () => {
    const env = await deployBuildEnv(project.dir, {
      env: "production",
      appEnv: { VITE_SUPATYPE_URL: "https://custom.example", VITE_SUPATYPE_ANON_KEY: ANON, OTHER: "x" },
    })
    expect(env["NEXT_PUBLIC_SUPATYPE_URL"]).toBe("https://custom.example")
    expect(env["OTHER"]).toBe("x")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
