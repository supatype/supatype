import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * `supatype sso rotate-key` against a Cloud project said there was nothing to rotate: Cloud made one
 * key and kept it. It now asks the control plane to take each of self-host's two steps.
 */
const sent = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string; body?: unknown }>, outcome: "created", applied: true }))
vi.mock("../src/resolve-target.js", async (original) => ({
  ...(await original<typeof import("../src/resolve-target.js")>()),
  resolveTarget: () => ({ mode: "cloud", environment: "production", projectRef: "acme-1", apiBaseUrl: "https://api.supatype.test", apiPrefix: "/api/v1", token: "t", link: null }),
}))
vi.mock("../src/target-client.js", async (original) => ({
  ...(await original<typeof import("../src/target-client.js")>()),
  targetFetch: async (_b: string, _p: string, opts: { path: string; method: string; body?: unknown }) => {
    sent.calls.push({ path: opts.path, method: opts.method, body: opts.body })
    return { outcome: sent.outcome, applied: sent.applied }
  },
}))

const { rotateCloudSamlKey } = await import("../src/cloud-saml-key.js")

afterEach(() => {
  sent.calls.length = 0
})

describe("rotate-key on a Cloud project", () => {
  it("asks for a next key, and says to promote once identity providers have its certificate", async () => {
    sent.outcome = "created"
    const said = await rotateCloudSamlKey("/nowhere", false)
    expect(sent.calls).toEqual([{ method: "POST", path: "/projects/acme-1/environments/production/auth/saml-key", body: { step: "next" } }])
    expect(said).toContain("--promote")
  })

  it("promotes, and says when the auth server has yet to pick it up", async () => {
    sent.outcome = "promoted"
    sent.applied = false
    const said = await rotateCloudSamlKey("/nowhere", true)
    expect(sent.calls[0]?.body).toEqual({ step: "promote" })
    expect(said).toContain("now the current one")
    expect(said).toContain("within a minute")
  })
})
