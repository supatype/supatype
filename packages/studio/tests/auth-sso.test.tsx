// @vitest-environment jsdom
import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { SsoView } from "../src/views/auth/SsoView.js"
import { isJsonObject } from "../src/lib/json.js"
import { parseAttributeMapping, parseDomains } from "../src/lib/sso-providers.js"
import { asking, press } from "./dialog-support.js"
import { act, button, elementOf, findButton, isolateEachTest, mount, settle, testClient } from "./support.js"

/**
 * The SSO page: the project's SAML identity providers, through the auth admin API at
 * `/auth/v1/admin/sso/providers`, addressed as `resource_<name>` where a provider has a name.
 *
 * Studio said SSO was coming soon while the server could already register identity providers. The
 * page lists them, adds one from a metadata URL or an uploaded XML file, edits one in place (never
 * removing and re-adding it, which would cut its users off), disables and enables it, and removes
 * it after saying what that does to the users who sign in through it. It shows the values an
 * identity provider is given, read from the server's own SP metadata, and says when SAML is off.
 */

const access = vi.hoisted(() => {
  const admin = () => ({ role: "admin" as string | null, permissions: { administer: true, manageMembers: true } as Record<string, boolean>, settled: true })
  return { admin, current: admin() }
})

vi.mock("../src/hooks/useStudioCapability.js", () => ({
  useStudioCapability: () => ({
    userId: null,
    mode: "studio",
    canElevate: false,
    canManageMembers: false,
    seesDrafts: false,
    identityLink: null,
    ...access.current,
  }),
}))

isolateEachTest()

// Each test that plays another role sets it; every test starts as an admin.
afterEach(() => {
  access.current = access.admin()
})

const API = "http://localhost:8000/studio/proxy"
const CLIENT = testClient({ url: API, token: "token" })
const PROVIDERS_URL = `${API}/auth/v1/admin/sso/providers`
const PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"
const EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"

const ACME = {
  id: "0b4a7c1e-0000-4000-8000-000000000001",
  resource_id: "acme",
  disabled: null,
  saml: {
    entity_id: "https://idp.acme.test/metadata",
    metadata_url: "https://idp.acme.test/metadata",
    name_id_format: EMAIL_FORMAT,
    attribute_mapping: { keys: { email: { name: "mail" } } },
  },
  domains: [
    { domain: "acme.test", verified: true, verified_at: "2026-11-06T12:00:00Z" },
    { domain: "acme.example", verified: false, verified_at: null },
  ],
}

/** ACME once acme.example has been verified. */
const ACME_VERIFIED = {
  ...ACME,
  domains: [
    { domain: "acme.test", verified: true, verified_at: "2026-11-06T12:00:00Z" },
    { domain: "acme.example", verified: true, verified_at: "2026-11-06T13:00:00Z" },
  ],
}

const LEGACY = {
  id: "0b4a7c1e-0000-4000-8000-000000000002",
  disabled: true,
  saml: { entity_id: "https://legacy.test/saml" },
  domains: [{ domain: "legacy.test", verified: false, verified_at: null }],
}

const CHALLENGE_VALUE = "st-verify-6c1f0a"

const SP_METADATA = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="http://localhost:18500/auth/v1/sso/saml/metadata">
  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="http://localhost:18500/auth/v1/sso/saml/acs" index="1"></AssertionConsumerService>
  </SPSSODescriptor>
</EntityDescriptor>`

const IDP_XML = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.new.test"></EntityDescriptor>`

interface Call {
  method: string
  url: string
  body: Record<string, unknown> | null
}

interface World {
  samlEnabled: boolean
  providers: unknown[]
  refuse?: { status: number; body: unknown }
  /** What DNS holds at a domain's challenge name, as the verify endpoint reports it. */
  dns?: { verified: boolean; found: string[] | null }
}

let calls: Call[] = []

function bodyOf(init: RequestInit | undefined): Record<string, unknown> | null {
  if (typeof init?.body !== "string") return null
  const parsed: unknown = JSON.parse(init.body)
  return isJsonObject(parsed) ? parsed : null
}

/** The verify endpoint's answer for `domain`: the challenge record, and what DNS holds there. */
function verification(world: World, domain: string): Response {
  const dns = world.dns ?? { verified: false, found: null }
  return Response.json({
    domain,
    verified: dns.verified,
    verified_at: dns.verified ? "2026-11-06T13:00:00Z" : null,
    challenge: { name: `_supatype-challenge.${domain}`, value: CHALLENGE_VALUE },
    found: dns.found,
  })
}

/** The auth server, as the view reaches it through the Studio proxy. */
function answer(world: World, call: Call): Response {
  if (call.url.endsWith("/auth/v1/settings")) return Response.json({ external: {}, saml_enabled: world.samlEnabled })
  if (call.url.endsWith("/auth/v1/sso/saml/metadata")) {
    return world.samlEnabled ? new Response(SP_METADATA, { headers: { "Content-Type": "application/xml" } }) : Response.json({ msg: "SAML 2.0 is disabled" }, { status: 404 })
  }
  if (call.method !== "GET" && world.refuse) return Response.json(world.refuse.body, { status: world.refuse.status })
  if (call.method === "GET") return Response.json({ items: world.providers })
  const verify = /\/domains\/([^/]+)\/verify$/.exec(call.url)
  if (verify) return verification(world, decodeURIComponent(verify[1] ?? ""))
  return Response.json(ACME, { status: call.method === "POST" ? 201 : 200 })
}

async function render(world: World): Promise<HTMLElement> {
  calls = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", url, body: bodyOf(init) }
    calls.push(call)
    return answer(world, call)
  })
  const { container } = await mount(
    <AdminClientContext.Provider value={CLIENT}>
      <SsoView />
    </AdminClientContext.Provider>,
  )
  await settle()
  return container
}

function writes(): Call[] {
  return calls.filter((c) => c.method !== "GET")
}

/** The table row whose first cell reads `name`. */
function row(container: HTMLElement, name: string): HTMLTableRowElement {
  const found = [...container.querySelectorAll("tbody tr")].find((r) => r.querySelector("td")?.textContent === name)
  if (!(found instanceof HTMLTableRowElement)) throw new Error(`no row for ${name}`)
  return found
}

function dialog(): HTMLElement {
  return elementOf(document.body, '[role="dialog"]', HTMLElement)
}

async function type(selector: string, text: string): Promise<void> {
  const field = elementOf(dialog(), selector, HTMLElement)
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
  const event = field instanceof HTMLSelectElement ? "change" : "input"
  await act(() => { setter?.call(field, text); field.dispatchEvent(new Event(event, { bubbles: true })) })
}

async function choose(input: HTMLInputElement, files: File[]): Promise<void> {
  Object.defineProperty(input, "files", { configurable: true, value: Object.assign([...files], { item: (i: number) => files[i] ?? null }) })
  await act(() => { input.dispatchEvent(new Event("change", { bubbles: true })) })
  await settle()
}

describe("the SSO page lists the project's SAML providers", () => {
  it("reads them from the auth admin API through the Studio proxy", async () => {
    await render({ samlEnabled: true, providers: [ACME] })
    expect(calls.map((c) => c.url)).toContain(PROVIDERS_URL)
  })

  it("shows each one's name, entity ID, domains and whether it is enabled", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME, LEGACY] })
    const acme = row(container, "acme")
    expect(acme.textContent).toContain("https://idp.acme.test/metadata")
    expect(acme.textContent).toContain("acme.test")
    expect(acme.textContent).toContain("acme.example")
    expect(acme.textContent).toContain("Enabled")
    const legacy = row(container, LEGACY.id)
    expect(legacy.textContent).toContain("Disabled")
  })

  it("says so when there are none", async () => {
    const container = await render({ samlEnabled: true, providers: [] })
    expect(container.textContent).toContain("No SAML providers yet")
  })

  it("says why when the list is refused", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ msg: "forbidden" }, { status: 403 }))
    const { container } = await mount(<AdminClientContext.Provider value={CLIENT}><SsoView /></AdminClientContext.Provider>)
    await settle()
    expect(container.textContent).toContain("forbidden")
  })
})

describe("what the identity provider is given", () => {
  it("shows the entity ID, metadata URL and ACS URL from the server's own SP metadata", async () => {
    const container = await render({ samlEnabled: true, providers: [] })
    expect(calls.map((c) => c.url)).toContain(`${API}/auth/v1/sso/saml/metadata`)
    expect(container.textContent).toContain("http://localhost:18500/auth/v1/sso/saml/metadata")
    expect(container.textContent).toContain("http://localhost:18500/auth/v1/sso/saml/acs")
  })

  it("says SAML is off, and still lets providers be set up first", async () => {
    const container = await render({ samlEnabled: false, providers: [] })
    expect(container.textContent).toContain("SAML is off for this project")
    expect(container.textContent).toContain("auth.sso.saml.enabled")
    expect(container.textContent).toContain("supatype.config.ts")
    expect(container.textContent).toContain("SUPATYPE_SAML_ENABLED")
    expect(container.textContent).not.toContain("/auth/v1/sso/saml/acs")
    expect(findButton(container, "Add provider")).toBeDefined()
  })
})

describe("adding a provider", () => {
  it("registers it from a metadata URL, named by its resource ID", async () => {
    const container = await render({ samlEnabled: true, providers: [] })
    await press("Add provider", container)
    await type("#sso-name", "acme")
    await type("#sso-metadata-url", "https://idp.acme.test/metadata")
    await type("#sso-domains", "Acme.test, acme.example acme.test")
    await type("#sso-name-id-format", EMAIL_FORMAT)
    await type("#sso-attribute-mapping", '{"keys":{"email":{"name":"mail"}}}')
    await press("Add provider", dialog())
    expect(writes()).toEqual([{
      method: "POST",
      url: PROVIDERS_URL,
      body: {
        type: "saml",
        resource_id: "acme",
        metadata_url: "https://idp.acme.test/metadata",
        domains: ["acme.test", "acme.example"],
        name_id_format: EMAIL_FORMAT,
        attribute_mapping: { keys: { email: { name: "mail" } } },
      },
    }])
  })

  it("registers it from an uploaded metadata XML file", async () => {
    const container = await render({ samlEnabled: true, providers: [] })
    await press("Add provider", container)
    await type("#sso-name", "newco")
    await press("Metadata XML", dialog())
    await choose(elementOf(dialog(), "[data-ui=file-input]", HTMLInputElement), [new File([IDP_XML], "idp.xml", { type: "text/xml" })])
    await press("Add provider", dialog())
    expect(writes()[0]?.body).toEqual({ type: "saml", resource_id: "newco", metadata_xml: IDP_XML, domains: [], name_id_format: "" })
  })

  it("refuses attribute mapping that is not JSON before sending anything", async () => {
    const container = await render({ samlEnabled: true, providers: [] })
    await press("Add provider", container)
    await type("#sso-name", "acme")
    await type("#sso-metadata-url", "https://idp.acme.test/metadata")
    await type("#sso-attribute-mapping", "{email: mail}")
    await press("Add provider", dialog())
    expect(writes()).toEqual([])
    expect(dialog().textContent).toContain("Attribute mapping is not valid JSON")
  })

  it("shows the server's refusal in the form and keeps it open", async () => {
    const container = await render({ samlEnabled: true, providers: [], refuse: { status: 422, body: { msg: "SAML Identity Provider with this EntityID (x) already exists" } } })
    await press("Add provider", container)
    await type("#sso-name", "acme")
    await type("#sso-metadata-url", "https://idp.acme.test/metadata")
    await press("Add provider", dialog())
    expect(dialog().textContent).toContain("already exists")
  })
})

describe("changing a provider in place", () => {
  it("edits it with a PUT to its resource ID, keeping its NameID format and leaving the metadata alone", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME] })
    await press("Edit", row(container, "acme"))
    expect(elementOf(dialog(), "#sso-name", HTMLInputElement).disabled).toBe(true)
    await type("#sso-domains", "acme.test")
    await press("Save changes", dialog())
    expect(writes()).toEqual([{
      method: "PUT",
      url: `${PROVIDERS_URL}/resource_acme`,
      body: { domains: ["acme.test"], name_id_format: EMAIL_FORMAT, attribute_mapping: { keys: { email: { name: "mail" } } } },
    }])
  })

  it("clears the attribute mapping when the field is emptied", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME] })
    await press("Edit", row(container, "acme"))
    await type("#sso-attribute-mapping", "")
    await type("#sso-name-id-format", PERSISTENT)
    await press("Save changes", dialog())
    expect(writes()[0]?.body).toMatchObject({ attribute_mapping: { keys: {} }, name_id_format: PERSISTENT })
  })

  it("sends a changed metadata URL, so the server fetches it again", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME] })
    await press("Edit", row(container, "acme"))
    await type("#sso-metadata-url", "https://idp.acme.test/metadata?v=2")
    await press("Save changes", dialog())
    expect(writes()[0]?.body).toMatchObject({ metadata_url: "https://idp.acme.test/metadata?v=2" })
  })

  it("addresses a provider with no name by its ID", async () => {
    const container = await render({ samlEnabled: true, providers: [LEGACY] })
    await press("Enable", row(container, LEGACY.id))
    expect(writes()).toEqual([{ method: "PUT", url: `${PROVIDERS_URL}/${LEGACY.id}`, body: { disabled: false } }])
  })

  it("disables an enabled one", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME] })
    await press("Disable", row(container, "acme"))
    expect(writes()).toEqual([{ method: "PUT", url: `${PROVIDERS_URL}/resource_acme`, body: { disabled: true } }])
  })

  it("never removes and re-adds a provider to change it", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME] })
    await press("Edit", row(container, "acme"))
    await press("Save changes", dialog())
    expect(writes().map((c) => c.method)).toEqual(["PUT"])
  })
})

/** The badge texts in a row, in order. */
function badges(scope: ParentNode): string[] {
  return [...scope.querySelectorAll("[data-ui=badge]")].map((b) => b.textContent ?? "")
}

const VERIFY_URL = `${PROVIDERS_URL}/resource_acme/domains/acme.example/verify`

describe("verifying a provider's domains", () => {
  it("shows whether each domain is verified", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME] })
    expect(badges(row(container, "acme"))).toEqual(["Verified", "Unverified", "Enabled"])
  })

  it("offers Verify only for a domain that is not verified yet", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME] })
    expect(findButton(row(container, "acme"), "Verify acme.example")).toBeDefined()
    expect(findButton(row(container, "acme"), "Verify acme.test")).toBeUndefined()
  })

  it("says what verifying changes for a SAML login whose email already has an account", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME] })
    expect(container.textContent).toContain("Until a domain is verified, a SAML login whose email already has an account is refused")
    expect(container.textContent).toContain("Once it is verified, such logins link to the existing account")
  })

  it("asks the server to check the domain and shows the TXT record to add", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME] })
    await press("Verify acme.example", row(container, "acme"))
    expect(writes()).toEqual([{ method: "POST", url: VERIFY_URL, body: null }])
    const text = dialog().textContent ?? ""
    expect(text).toContain("_supatype-challenge.acme.example")
    expect(text).toContain(CHALLENGE_VALUE)
    expect(text).toContain("TXT")
    expect(text).toContain("No TXT record was found")
  })

  it("shows what DNS holds when it is not the record asked for", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME], dns: { verified: false, found: ["old-token"] } })
    await press("Verify acme.example", row(container, "acme"))
    expect(dialog().textContent).toContain("old-token")
  })

  it("checks again on request, and once verified says logins now link and shows it in the list", async () => {
    const world: World = { samlEnabled: true, providers: [ACME] }
    const container = await render(world)
    await press("Verify acme.example", row(container, "acme"))
    world.dns = { verified: true, found: [CHALLENGE_VALUE] }
    world.providers = [ACME_VERIFIED]
    await press("Check again", dialog())
    expect(writes().map((c) => c.url)).toEqual([VERIFY_URL, VERIFY_URL])
    expect(dialog().textContent).toContain("acme.example is verified")
    expect(dialog().textContent).toContain("now link")
    expect(findButton(dialog(), "Check again")).toBeUndefined()
    await press("Close", dialog())
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(badges(row(container, "acme"))).toEqual(["Verified", "Verified", "Enabled"])
  })

  it("shows the server's refusal in the dialog", async () => {
    const refuse = { status: 404, body: { code: 404, error_code: "sso_domain_not_found", msg: 'Domain "acme.example" is not a domain of this SSO provider' } }
    const container = await render({ samlEnabled: true, providers: [ACME], refuse })
    await press("Verify acme.example", row(container, "acme"))
    expect(dialog().textContent).toContain("is not a domain of this SSO provider")
  })

  it("addresses a provider with no name by its ID", async () => {
    const container = await render({ samlEnabled: true, providers: [LEGACY] })
    await press("Verify legacy.test", row(container, LEGACY.id))
    expect(writes()[0]?.url).toBe(`${PROVIDERS_URL}/${LEGACY.id}/domains/legacy.test/verify`)
  })

  it("keeps the domain names when a provider is edited", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME] })
    await press("Edit", row(container, "acme"))
    await press("Save changes", dialog())
    expect(writes()[0]?.body).toMatchObject({ domains: ["acme.test", "acme.example"] })
  })

  it("shows the state but offers no Verify to a viewer", async () => {
    access.current = { role: "viewer", permissions: { administer: false }, settled: true }
    const container = await render({ samlEnabled: true, providers: [ACME] })
    expect(badges(row(container, "acme"))).toEqual(["Verified", "Unverified", "Enabled"])
    expect(findButton(container, "Verify acme.example")).toBeUndefined()
  })
})

describe("removing a provider", () => {
  it("asks first, saying its users can no longer sign in that way", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME] })
    await press("Remove", row(container, "acme"))
    expect(asking()).toContain("can no longer sign in")
    expect(writes()).toEqual([])
    await press("Remove provider")
    expect(writes()).toEqual([{ method: "DELETE", url: `${PROVIDERS_URL}/resource_acme`, body: null }])
  })
})

describe("roles", () => {
  it("shows a developer the page read-only: only owners and admins change SSO providers", async () => {
    access.current = { role: "developer", permissions: { administer: true, manageUsers: true, manageMembers: false }, settled: true }
    const container = await render({ samlEnabled: true, providers: [ACME] })
    expect(row(container, "acme").textContent).toContain("acme.example")
    for (const label of ["Add provider", "Edit", "Disable", "Remove", "Verify acme.example"]) expect(findButton(container, label)).toBeUndefined()
    expect(container.textContent).toContain("Only owners and admins can change SSO providers.")
  })

  it("offers no changes to a viewer", async () => {
    access.current = { role: "viewer", permissions: { administer: false }, settled: true }
    const container = await render({ samlEnabled: true, providers: [ACME] })
    expect(row(container, "acme").textContent).toContain("acme.test")
    for (const label of ["Add provider", "Edit", "Disable", "Remove"]) expect(findButton(container, label)).toBeUndefined()
  })

  it("builds the page from the shared primitives", async () => {
    const container = await render({ samlEnabled: true, providers: [ACME] })
    expect(container.querySelector("[data-ui=table-card]")).not.toBeNull()
    expect(button(container, "Add provider").dataset["ui"]).toBe("button")
    expect(row(container, "acme").querySelector("[data-ui=badge]")).not.toBeNull()
  })
})

describe("reading the form's fields", () => {
  it("splits domains on commas and spaces, lower-cased, each once", () => {
    expect(parseDomains(" Acme.test,acme.example  ACME.test\n")).toEqual(["acme.test", "acme.example"])
    expect(parseDomains("")).toEqual([])
  })

  it("takes attribute mapping in the server's { keys } shape, empty for none", () => {
    expect(parseAttributeMapping("")).toEqual({ ok: true, mapping: null })
    expect(parseAttributeMapping('{"keys":{"email":{"name":"mail"}}}')).toEqual({ ok: true, mapping: { keys: { email: { name: "mail" } } } })
    expect(parseAttributeMapping('{"email":"mail"}')).toEqual({ ok: false, error: 'Attribute mapping needs a "keys" object, as in {"keys": {"email": {"name": "mail"}}}' })
    expect(parseAttributeMapping("nope")).toEqual({ ok: false, error: "Attribute mapping is not valid JSON" })
  })
})
