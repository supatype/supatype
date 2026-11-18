import { afterEach, describe, expect, it, vi } from "vitest"

const sent = vi.hoisted(() => ({ calls: [] as Array<{ method: string; path: string; body?: unknown }> }))
const ORG = "org-1"
const MEMBERS = [
  { id: "m1", userId: "u-admin", email: "Ada@Example.com", role: "admin", createdAt: "2026-11-01T00:00:00Z" },
  { id: "m2", userId: "u-dev", email: "dev@example.com", role: "developer", createdAt: "2026-11-02T00:00:00Z" },
]
vi.mock("../src/target-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/target-client.js")>()
  return {
    ...actual,
    targetFetch: async (_base: string, _prefix: string, opts: { method: string; path: string; body?: unknown }, guard?: (v: unknown) => boolean) => {
      sent.calls.push({ method: opts.method, path: opts.path, ...(opts.body !== undefined && { body: opts.body }) })
      const answer = opts.path === `/organisations/${ORG}/members` && opts.method === "GET"
        ? MEMBERS
        : opts.path.endsWith("/studio-members") ? [{ id: "u-dev", role: "viewer", platformAccount: true, email: null }] : {}
      if (guard !== undefined && !guard(answer)) throw new Error("unexpected answer")
      return answer
    },
  }
})

const { effectiveStudioUsers, inviteCloudStudioUser, listCloudStudioUsers, setCloudStudioRole } = await import("../src/cloud-admin.js")

/**
 * `supatype admin` wrote the project's own database, which a Supatype Cloud project's CLI cannot
 * reach, so every command failed on Cloud. Cloud's Studio is entered with a Cloud account, whose
 * access is the organisation's membership narrowed per project, so the commands now go through the
 * control plane's member routes.
 */
const target = { mode: "cloud", environment: "production", projectRef: "demo", apiBaseUrl: "https://api.example.test", apiPrefix: "/api/v1", token: "t", orgId: ORG, link: null } as const

afterEach(() => {
  sent.calls.length = 0
})

describe("supatype admin on a Cloud project", () => {
  it("lists every org member with the role that applies here, a project row narrowing the org role", async () => {
    const users = await listCloudStudioUsers(target)
    expect(users.map(({ id, role, source }) => ({ id, role, source }))).toEqual([
      { id: "u-admin", role: "admin", source: "org" },
      { id: "u-dev", role: "viewer", source: "project" },
    ])
  })

  it("narrows a member's role on this project, found by email whatever its case", async () => {
    expect(await setCloudStudioRole(target, "ada@example.com", "editor")).toBe("u-admin")
    expect(sent.calls.at(-1)).toEqual({ method: "PATCH", path: "/projects/demo/studio-members/u-admin", body: { role: "editor" } })
  })

  it("says to invite first when nobody in the organisation has that email", async () => {
    await expect(setCloudStudioRole(target, "nobody@example.com", "editor")).rejects.toThrow(/create-user/)
    expect(sent.calls.some((call) => call.method === "PATCH")).toBe(false)
  })

  it("invites a new user to the organisation with the role, and refuses a password", async () => {
    await inviteCloudStudioUser(target, " New@Example.com ", "developer", undefined)
    expect(sent.calls.at(-1)).toEqual({ method: "POST", path: `/organisations/${ORG}/members`, body: { email: "new@example.com", role: "developer" } })
    await expect(inviteCloudStudioUser(target, "x@example.com", "admin", "hunter22")).rejects.toThrow(/--password/)
  })

  it("keeps an org role where no project row narrows it", () => {
    expect(effectiveStudioUsers([{ userId: "a", email: "a@x", role: "editor", createdAt: null }], [])).toEqual([
      { id: "a", email: "a@x", role: "editor", source: "org", createdAt: null },
    ])
  })
})
