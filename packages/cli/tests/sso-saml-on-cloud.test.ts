import { describe, expect, it, vi } from "vitest"
import { projectConfig } from "./support/project-config.js"

/**
 * `supatype sso` on a Cloud project said SAML was off whenever supatype.config.ts did not turn it on,
 * even after Studio had switched it on, and `sso info` then skipped the signing certificate. On Cloud
 * the control plane holds the setting in force, so the CLI asks it.
 */
const answer = vi.hoisted(() => ({ enabled: true as boolean | null, calls: [] as Array<{ path: string; method: string }> }))
vi.mock("../src/resolve-target.js", async (original) => ({
  ...(await original<typeof import("../src/resolve-target.js")>()),
  resolveTarget: () => ({ mode: "cloud", environment: "production", projectRef: "acme-1", apiBaseUrl: "https://api.supatype.test", apiPrefix: "/api/v1", token: "t", link: null }),
}))
vi.mock("../src/target-client.js", async (original) => ({
  ...(await original<typeof import("../src/target-client.js")>()),
  targetFetch: async (_b: string, _p: string, opts: { path: string; method: string }) => {
    answer.calls.push({ path: opts.path, method: opts.method })
    return { fields: { "auth.sso.saml.enabled": { value: answer.enabled } } }
  },
}))
vi.mock("../src/sso-admin.js", async (original) => ({
  ...(await original<typeof import("../src/sso-admin.js")>()),
  linkedToCloud: () => true,
}))

const { samlIsOn } = await import("../src/commands/sso.js")

describe("whether SAML is on for a Cloud project", () => {
  it("is on when Studio switched it on, though the config does not", async () => {
    answer.enabled = true
    expect(await samlIsOn("/nowhere", projectConfig())).toBe(true)
    expect(answer.calls).toEqual([{ method: "GET", path: "/projects/acme-1/environments/production/auth" }])
  })

  it("is off when the control plane has no value for it", async () => {
    answer.enabled = null
    expect(await samlIsOn("/nowhere", projectConfig())).toBe(false)
  })
})
