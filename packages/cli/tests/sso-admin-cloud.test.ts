import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * `supatype sso` refused a project linked to Supatype Cloud: the CLI holds no service-role key for
 * one. It now goes through the control plane's proxy for the project with the caller's own session,
 * acting elevated, which the control plane allows owners and admins. `sso info` names the project's
 * own API, which the identity provider talks to, not the control plane.
 */
const target = vi.hoisted(() => ({
  mode: "cloud",
  environment: "production",
  projectRef: "acme-1",
  apiBaseUrl: "https://api.supatype.test",
  apiPrefix: "/api/v1",
  token: "session-jwt",
  orgId: "org-1",
  link: { kind: "cloud", environments: { production: { apiUrl: "https://abc123.supatype.test/" } } },
}))
const sent = vi.hoisted(() => ({ calls: [] as Array<{ base: string; prefix: string; opts: Record<string, unknown> }> }))

vi.mock("../src/link.js", async (original) => ({
  ...(await original<typeof import("../src/link.js")>()),
  loadProjectLink: () => ({ kind: "cloud" }),
}))
vi.mock("../src/resolve-target.js", async (original) => ({
  ...(await original<typeof import("../src/resolve-target.js")>()),
  resolveTarget: () => target,
  cloudAuthRefresh: () => undefined,
}))
vi.mock("../src/target-client.js", async (original) => ({
  ...(await original<typeof import("../src/target-client.js")>()),
  targetFetch: async (base: string, prefix: string, opts: Record<string, unknown>) => {
    sent.calls.push({ base, prefix, opts })
    return { items: [] }
  },
}))

const { listSsoProviders, resolveSsoEndpoint, ssoApiBaseUrl } = await import("../src/sso-admin.js")

afterEach(() => {
  sent.calls.length = 0
})

describe("supatype sso against a Cloud project", () => {
  it("calls the project's auth admin API through the control plane's proxy, acting elevated", async () => {
    await listSsoProviders(resolveSsoEndpoint("/nowhere", "list"))
    expect(sent.calls).toHaveLength(1)
    const [call] = sent.calls
    expect(call?.base).toBe("https://api.supatype.test/api/v1/projects/acme-1/proxy")
    expect(call?.prefix).toBe("/auth/v1")
    expect(call?.opts).toMatchObject({
      method: "GET",
      path: "/admin/sso/providers",
      token: "session-jwt",
      orgId: "org-1",
      environment: "production",
      actingMode: "elevated",
    })
  })

  it("names the project's own API for sso info, which the identity provider talks to", () => {
    expect(ssoApiBaseUrl("/nowhere")).toEqual({ baseUrl: "https://abc123.supatype.test", linked: true })
  })
})
