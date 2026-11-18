import { afterEach, describe, expect, it, vi } from "vitest"
import { projectConfig } from "./support/project-config.js"

const sent = vi.hoisted(() => ({ calls: [] as Array<{ method: string; path: string; body?: unknown }>, refuse: false }))
vi.mock("../src/target-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/target-client.js")>()
  return {
    ...actual,
    targetFetch: async (_base: string, _prefix: string, opts: { method: string; path: string; body?: unknown }) => {
      sent.calls.push({ method: opts.method, path: opts.path, body: opts.body })
      if (sent.refuse) throw new actual.TargetApiError("Forbidden", 403)
      return {}
    },
  }
})

const { pushCorsOrigins } = await import("../src/cors-origins-push.js")

/**
 * `api.corsOrigins` reached a self-hosted server as `SUPATYPE_CORS_ALLOW_ORIGINS` and never reached a
 * Cloud project, whose browsers were refused by an allowlist the config said included them. A push
 * now saves the config's list on Cloud, replacing whatever Studio saved: the config wins.
 */
const target = (mode: "cloud" | "self-host") =>
  ({ mode, environment: "production", projectRef: "demo", apiBaseUrl: "https://api.example.test", apiPrefix: "/api/v1", token: "t", link: null }) as const

afterEach(() => {
  sent.calls.length = 0
  sent.refuse = false
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe("pushCorsOrigins", () => {
  it("saves the config's origins on a Cloud project, trimmed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const failed = await pushCorsOrigins(target("cloud"), projectConfig({ api: { corsOrigins: [" https://app.example.com ", "https://admin.example.com"] } }))
    expect(failed).toBe(false)
    expect(sent.calls).toEqual([
      { method: "PUT", path: "/projects/demo/cors-origins", body: { origins: ["https://app.example.com", "https://admin.example.com"] } },
    ])
  })

  it("clears the list when the config sets it empty", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    await pushCorsOrigins(target("cloud"), projectConfig({ api: { corsOrigins: [] } }))
    expect(sent.calls).toEqual([{ method: "PUT", path: "/projects/demo/cors-origins", body: { origins: [] } }])
  })

  it("leaves the list alone when the config does not set it", async () => {
    expect(await pushCorsOrigins(target("cloud"), projectConfig())).toBe(false)
    expect(sent.calls).toEqual([])
  })

  it("sends nothing to a self-hosted stack, which reads the list from its environment", async () => {
    expect(await pushCorsOrigins(target("self-host"), projectConfig({ api: { corsOrigins: ["https://app.example.com"] } }))).toBe(false)
    expect(sent.calls).toEqual([])
  })

  it("reports a refusal as a step after the schema that failed, and ends non-zero", async () => {
    sent.refuse = true
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    expect(await pushCorsOrigins(target("cloud"), projectConfig({ api: { corsOrigins: ["https://app.example.com"] } }))).toBe(true)
    expect(process.exitCode).toBe(1)
    expect(errors.mock.calls.flat().join("\n")).toMatch(/allowed origins/)
  })
})
