// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import React, { act } from "react"
import { MemoryRouter } from "react-router-dom"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { mockConfig } from "../src/fixtures/mockConfig.js"
import { AuthManagement } from "../src/views/AuthManagement.js"
import { identityProviderLabel, parseSsoProvider, type SsoProvider } from "../src/lib/sso-providers.js"
import { isolateEachTest, mount, settle, testClient } from "./support.js"

/**
 * Issue 54: the auth server records a SAML identity's provider as `sso:<provider ID>`, and the Users
 * list showed that string as it came. A user is now labelled `sso:` and the provider's name, the one
 * `supatype sso add <name>` gave it, read through the same admin call the SSO page lists them with.
 * A provider that has gone, or one registered without a name, is shown by a short form of its ID.
 */

const PROXY = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: PROXY, token: "token" })
const ACME_ID = "ecca51f1-3696-4980-954f-565535b4876a"
const GONE_ID = "0badc0de-1111-4222-8333-444455556666"
const ACME = { id: ACME_ID, resource_id: "acme", saml: { entity_id: "https://idp.acme.test" }, domains: [] }

function samlUser(id: string, email: string, providerId: string): Record<string, unknown> {
  const identity = { provider: `sso:${providerId}`, id: `i-${id}`, identity_id: `i-${id}`, created_at: "2026-11-01T10:00:00Z" }
  return { id, email, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z", user_metadata: {}, identities: [identity] }
}

const ADA = samlUser("11111111-1111-1111-1111-111111111111", "ada@acme.test", ACME_ID)
const GRACE = samlUser("22222222-2222-2222-2222-222222222222", "grace@gone.test", GONE_ID)
const EMAIL_ONLY = { ...samlUser("33333333-3333-3333-3333-333333333333", "lin@example.com", ACME_ID), identities: [] }

isolateEachTest()

/** Stub the auth server with `users`, and return the URLs it was asked for. */
function stubFetch(users: Array<Record<string, unknown>>, settings: Record<string, unknown> = { mailer_autoconfirm: true }): string[] {
  const urls: string[] = []
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url)
    if (url.endsWith("/studio/auth/verify")) {
      return Response.json({ sub: "admin-id", role: "admin", mode: "self", permissions: { manageUsers: true } })
    }
    if (url.endsWith("/auth/v1/settings")) return Response.json(settings)
    if (url.endsWith("/auth/v1/admin/sso/providers")) return Response.json({ items: [ACME] })
    if (url.includes("/auth/v1/admin/users/")) return Response.json(users.find((u) => url.includes(String(u["id"]))) ?? users[0])
    if (url.includes("/auth/v1/admin/users")) return Response.json({ users, aud: "authenticated" })
    return Response.json({ rows: [], members: [], roles: [], sessions: [] })
  })
  return urls
}

async function renderUsers(entry: string): Promise<HTMLElement> {
  await mount(
    <MemoryRouter initialEntries={[entry]}>
      <AdminConfigContext.Provider value={mockConfig}>
        <AdminClientContext.Provider value={CLIENT}>
          <AuthManagement />
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await settle()
  return document.body
}

function badgeTexts(root: ParentNode): string[] {
  return [...root.querySelectorAll("[data-ui=badge]")].map((b) => b.textContent ?? "")
}

describe("a SAML user's provider badge", () => {
  it("names the provider in the Users list, and a gone provider by a short ID", async () => {
    stubFetch([ADA, GRACE])
    const badges = badgeTexts(await renderUsers("/auth/users"))
    expect(badges).toContain("sso:acme")
    expect(badges).toContain("sso:0badc0de")
    expect(badges.some((b) => b.includes(ACME_ID) || b.includes(GONE_ID))).toBe(false)
  })

  it("names the provider in the user's linked identities", async () => {
    stubFetch([ADA])
    await renderUsers(`/auth/users?user=${String(ADA["id"])}`)
    const dialog = document.body.querySelector<HTMLElement>("[role=dialog]")
    if (!dialog) throw new Error("no slide panel rendered")
    expect(badgeTexts(dialog)).toContain("sso:acme")
    expect(dialog.textContent).not.toContain(`sso:${ACME_ID}`)
  })

  it("does not ask for the SSO providers when no user on the page signed in through one", async () => {
    const urls = stubFetch([EMAIL_ONLY])
    await renderUsers("/auth/users")
    expect(urls.some((u) => u.includes("/admin/sso/providers"))).toBe(false)
  })
})

/** Issue 62: the provider filter offered only the switched-on providers, never a SAML one. */
describe("the Users provider filter", () => {
  function providerSelect(root: ParentNode): HTMLSelectElement {
    const select = [...root.querySelectorAll("select")].find((s) => s.options[0]?.textContent === "All providers")
    if (!select) throw new Error("no provider filter rendered")
    return select
  }

  it("offers each SAML provider by name, and filters by its identity provider", async () => {
    const urls = stubFetch([EMAIL_ONLY], { mailer_autoconfirm: true, saml_enabled: true, external: { email: true } })
    const select = providerSelect(await renderUsers("/auth/users"))
    const options = [...select.options].map((o) => [o.value, o.textContent])
    expect(options).toEqual([["all", "All providers"], ["email", "email"], [`sso:${ACME_ID}`, "sso:acme"]])

    await act(async () => {
      select.value = `sso:${ACME_ID}`
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await settle()
    expect(urls.some((u) => u.includes(`provider=sso%3A${ACME_ID}`))).toBe(true)
  })

  it("offers no SAML choice while SAML is off", async () => {
    stubFetch([EMAIL_ONLY], { mailer_autoconfirm: true, external: { email: true } })
    const select = providerSelect(await renderUsers("/auth/users"))
    expect([...select.options].map((o) => o.value)).toEqual(["all", "email"])
  })
})

describe("identityProviderLabel", () => {
  const providers = [ACME, { id: GONE_ID.replace("0bad", "fade"), saml: {} }]
    .map(parseSsoProvider)
    .filter((p): p is SsoProvider => p !== null)

  it("keeps a provider that is not SSO as it is", () => {
    expect(identityProviderLabel("github", providers)).toBe("github")
    expect(identityProviderLabel("email", null)).toBe("email")
  })

  it("names a known SSO provider, keeping sso: so it reads as single sign-on", () => {
    expect(identityProviderLabel(`sso:${ACME_ID}`, providers)).toBe("sso:acme")
  })

  it("shortens the ID while the providers are unread, unknown, or the provider has no name", () => {
    expect(identityProviderLabel(`sso:${ACME_ID}`, null)).toBe("sso:ecca51f1")
    expect(identityProviderLabel(`sso:${GONE_ID}`, providers)).toBe("sso:0badc0de")
    expect(identityProviderLabel(`sso:${GONE_ID.replace("0bad", "fade")}`, providers)).toBe("sso:fadec0de")
  })
})
