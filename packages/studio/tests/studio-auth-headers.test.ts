import { describe, expect, it } from "vitest"
import type { SupatypeClient } from "@supatype/client"
import { studioAuthHeaders, usesSessionProxy } from "../src/lib/studio-auth-headers.js"

function clientWithToken(token: string | null): SupatypeClient {
  return {
    url: "http://localhost:18473/studio/proxy",
    auth: { currentAccessToken: token },
  } as unknown as SupatypeClient
}

describe("studioAuthHeaders", () => {
  // Regression: Studio accepted a service role key in the browser and sent it on
  // every privileged call. That is unrestricted database access to anyone who
  // opens devtools, and it bypasses Studio membership, the role's permissions,
  // the acting identity and the audit trail — every control the server applies.
  it("never sends a service role key, even when one is attached to the client", () => {
    const client = {
      url: "http://localhost:18473/studio/proxy",
      serviceRoleKey: "service-role-key",
      auth: { currentAccessToken: "user-token" },
    } as unknown as SupatypeClient

    const headers = studioAuthHeaders(client)
    expect(headers["Authorization"]).toBe("Bearer user-token")
    expect(JSON.stringify(headers)).not.toContain("service-role-key")
  })

  it("sends the signed-in user's token", () => {
    expect(studioAuthHeaders(clientWithToken("abc"))).toEqual({
      Authorization: "Bearer abc",
      apikey: "abc",
    })
  })

  // No token means no headers — an unauthenticated request must be refused by the
  // server rather than quietly succeeding with some ambient privilege.
  it("sends nothing when there is no session", () => {
    expect(studioAuthHeaders(clientWithToken(null))).toEqual({})
    expect(studioAuthHeaders(clientWithToken(""))).toEqual({})
  })
})

describe("usesSessionProxy", () => {
  it("recognises the proxy path", () => {
    expect(usesSessionProxy({ url: "http://localhost:18473/studio/proxy" })).toBe(true)
    expect(usesSessionProxy({ url: "http://localhost:18473/studio/proxy/" })).toBe(true)
    expect(usesSessionProxy({ url: "https://api.example.com/projects/x/proxy" })).toBe(true)
  })

  // A direct URL means privileged calls would go straight to the data plane with
  // no server-side capability check in front of them.
  it("does not treat a direct API URL as proxied", () => {
    expect(usesSessionProxy({ url: "http://localhost:18473" })).toBe(false)
  })
})
