import { afterEach, describe, expect, it, vi } from "vitest"
import { verifySsoDomain, type SsoEndpoint, type SsoProvider } from "../src/sso-admin.js"
import { describeDomains, domainVerificationReport } from "../src/commands/sso.js"

/**
 * `supatype sso verify-domain <name> <domain>`: proving the project owns a domain a provider signs
 * people in for, with a DNS TXT record `_supatype-challenge.<domain>` holding a per-domain token.
 *
 * A verified domain is what lets a SAML sign-in link to an existing account with the same email.
 * The server keeps the token and the verdict; the CLI prints the record to add and asks the server to
 * check it, and running it again checks again.
 */

const ENDPOINT: SsoEndpoint = { baseUrl: "http://localhost:18500", token: "service-role", where: "the local stack" }

let sent: { url: string; method: string; auth: string | null }[] = []

function stubFetch(answer: unknown): void {
  sent = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method ?? "GET", auth: new Headers(init.headers).get("Authorization") })
    return Response.json(answer)
  })
}

afterEach(() => vi.unstubAllGlobals())

const PENDING = {
  domain: "acme.com",
  verified: false,
  verified_at: null,
  challenge: { name: "_supatype-challenge.acme.com", type: "TXT", value: "st-verify-3f9a" },
  found: ["some-other-value"],
}

describe("sso verify-domain", () => {
  it("asks the admin API to check the domain of the provider called <name>", async () => {
    stubFetch(PENDING)
    const result = await verifySsoDomain(ENDPOINT, "acme", "ACME.com")
    expect(sent).toEqual([
      {
        url: "http://localhost:18500/auth/v1/admin/sso/providers/resource_acme/domains/acme.com/verify",
        method: "POST",
        auth: "Bearer service-role",
      },
    ])
    expect(result.challenge.value).toBe("st-verify-3f9a")
  })

  it("prints the TXT record to add and what DNS answered instead, when it is not verified yet", () => {
    const text = domainVerificationReport(PENDING).join("\n")
    expect(text).toContain("acme.com is not verified yet")
    expect(text).toMatch(/_supatype-challenge\.acme\.com\s+TXT\s+st-verify-3f9a/)
    expect(text).toContain("some-other-value")
    expect(text).toContain("supatype sso verify-domain")
  })

  it("says when no TXT record was found at all", () => {
    const text = domainVerificationReport({ ...PENDING, found: [] }).join("\n")
    expect(text).toContain("No TXT record was found at _supatype-challenge.acme.com")
  })

  it("says a domain is verified, and when", () => {
    const text = domainVerificationReport({ ...PENDING, verified: true, verified_at: "2026-11-06T12:00:00Z" }).join("\n")
    expect(text).toContain("acme.com is verified (since 2026-11-06T12:00:00Z)")
    expect(text).not.toContain("TXT")
  })

  it("mentions that a *.supatype.test domain counts as verified on a dev stack", () => {
    const text = domainVerificationReport({ ...PENDING, domain: "acme.supatype.test" }).join("\n")
    expect(text).toMatch(/\.supatype\.test.*verified.*dev/s)
  })

  it("refuses something that is not a domain before calling anything", async () => {
    stubFetch(PENDING)
    await expect(verifySsoDomain(ENDPOINT, "acme", "not a domain")).rejects.toThrow(/not a domain/)
    expect(sent).toEqual([])
  })
})

describe("domain verification state in sso show and sso list", () => {
  const provider = (domains: NonNullable<SsoProvider["domains"]>): SsoProvider => ({
    id: "p1",
    resource_id: "acme",
    domains,
  })

  it("marks each domain verified or not", () => {
    expect(
      describeDomains(provider([{ domain: "acme.com", verified: true }, { domain: "acme.org", verified: false }])),
    ).toBe("acme.com (verified), acme.org (not verified)")
  })

  it("says nothing about verification for a server that does not report it", () => {
    expect(describeDomains(provider([{ domain: "acme.com" }]))).toBe("acme.com")
  })
})
