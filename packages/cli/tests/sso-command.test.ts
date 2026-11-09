import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createSsoProvider,
  listSsoProviders,
  removeSsoProvider,
  ssoProviderInput,
  updateSsoProvider,
  type SsoEndpoint,
} from "../src/sso-admin.js"
import { samlOffWarning, serviceProviderInfo } from "../src/commands/sso.js"
import { createNextSamlKey, promoteNextSamlKey } from "../src/saml-key-rotation.js"
import type { SupatypeProjectConfig } from "../src/project-config.js"

/**
 * `supatype sso`: registering SAML identity providers through the auth server's admin API, and the
 * service provider's values and signing key.
 *
 * A user signed in through a provider is keyed on the provider's id, so a provider deleted and added
 * again orphans every such user. The CLI addresses providers by the name given at `add` (stored as
 * `resource_id`) and always updates in place.
 */

const ENDPOINT: SsoEndpoint = { baseUrl: "http://localhost:18500", token: "service-role", where: "the local stack" }

interface Sent {
  url: string
  method: string
  body: unknown
  auth: string | undefined
}

let sent: Sent[] = []

function stubFetch(answer: (req: Sent) => unknown): void {
  sent = []
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    const req: Sent = {
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      auth: headers.get("Authorization") ?? undefined,
    }
    sent.push(req)
    return Response.json(answer(req))
  })
}

const PROVIDER = {
  id: "0b8f1f4e-0000-4000-8000-000000000001",
  resource_id: "acme",
  disabled: false,
  saml: {
    entity_id: "https://idp.acme.test/metadata",
    metadata_url: "https://idp.acme.test/metadata",
    name_id_format: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  },
  domains: [{ domain: "acme.test" }],
  created_at: "2026-11-06T00:00:00Z",
  updated_at: "2026-11-06T00:00:00Z",
}

afterEach(() => vi.unstubAllGlobals())

describe("sso add", () => {
  it("posts a SAML provider to the admin API, named by resource_id, with the service-role key", async () => {
    stubFetch(() => PROVIDER)
    await createSsoProvider(ENDPOINT, "acme", {
      metadataUrl: "https://idp.acme.test/metadata",
      domains: ["acme.test", "acme.example"],
      nameIdFormat: "persistent",
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe("http://localhost:18500/auth/v1/admin/sso/providers")
    expect(sent[0]?.method).toBe("POST")
    expect(sent[0]?.auth).toBe("Bearer service-role")
    expect(sent[0]?.body).toEqual({
      type: "saml",
      resource_id: "acme",
      metadata_url: "https://idp.acme.test/metadata",
      domains: ["acme.test", "acme.example"],
      name_id_format: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    })
  })
})

describe("sso flags", () => {
  let dir = ""
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-sso-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("takes exactly one of --metadata-url and --metadata-file", async () => {
    await expect(ssoProviderInput({}, { requireMetadata: true })).rejects.toThrow(/--metadata-url or --metadata-file/)
    const file = join(dir, "idp.xml")
    writeFileSync(file, "<EntityDescriptor/>")
    await expect(
      ssoProviderInput({ metadataUrl: "https://x.test/m", metadataFile: file }, { requireMetadata: true }),
    ).rejects.toThrow(/not both/)
  })

  it("reads the metadata file, the domains and the attribute mapping", async () => {
    const xml = join(dir, "idp.xml")
    const mapping = join(dir, "mapping.json")
    writeFileSync(xml, "<EntityDescriptor/>")
    writeFileSync(mapping, JSON.stringify({ keys: { email: { name: "mail" } } }))
    const input = await ssoProviderInput(
      { metadataFile: xml, domains: " acme.test, ACME.example ,", attributeMappingFile: mapping },
      { requireMetadata: true },
    )
    expect(input).toEqual({
      metadataXml: "<EntityDescriptor/>",
      domains: ["acme.test", "acme.example"],
      attributeMapping: { keys: { email: { name: "mail" } } },
    })
  })

  it("refuses an attribute mapping that is not the admin API's shape", async () => {
    const mapping = join(dir, "mapping.json")
    writeFileSync(mapping, JSON.stringify({ email: "mail" }))
    await expect(ssoProviderInput({ attributeMappingFile: mapping }, { requireMetadata: false })).rejects.toThrow(
      /\{ "keys": \{ "<attribute>": \{ "name": \.\.\. \} \} \}/,
    )
  })

  it("refuses a NameID format the server does not have", async () => {
    await expect(ssoProviderInput({ nameIdFormat: "email" }, { requireMetadata: false })).rejects.toThrow(
      /persistent, emailAddress, transient, unspecified/,
    )
  })
})

describe("sso update", () => {
  it("puts the change in place and keeps the NameID format it was not told to change", async () => {
    stubFetch((req) => (req.method === "GET" ? PROVIDER : { ...PROVIDER, domains: [{ domain: "acme.org" }] }))
    await updateSsoProvider(ENDPOINT, "acme", { domains: ["acme.org"] })
    expect(sent.map((r) => r.method)).toEqual(["GET", "PUT"])
    expect(sent[1]?.url).toBe("http://localhost:18500/auth/v1/admin/sso/providers/resource_acme")
    expect(sent[1]?.body).toEqual({
      domains: ["acme.org"],
      name_id_format: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    })
  })
})

describe("sso list and remove", () => {
  it("lists the providers the server answers with", async () => {
    stubFetch(() => ({ items: [PROVIDER] }))
    const providers = await listSsoProviders(ENDPOINT)
    expect(providers.map((p) => p.resource_id)).toEqual(["acme"])
  })

  it("removes by name", async () => {
    stubFetch(() => PROVIDER)
    await removeSsoProvider(ENDPOINT, "acme")
    expect(sent[0]).toMatchObject({ method: "DELETE", url: "http://localhost:18500/auth/v1/admin/sso/providers/resource_acme" })
  })
})

describe("sso info", () => {
  it("gives an IdP the entity ID, ACS URL, NameID and the subject-id attribute", () => {
    const text = serviceProviderInfo("http://localhost:18500/auth/v1").join("\n")
    expect(text).toContain("Entity ID / metadata URL  http://localhost:18500/auth/v1/sso/saml/metadata")
    expect(text).toContain("ACS URL                   http://localhost:18500/auth/v1/sso/saml/acs")
    expect(text).toContain("http://localhost:18500/auth/v1/sso/saml/metadata?download=true")
    expect(text).toContain("urn:oasis:names:tc:SAML:2.0:nameid-format:persistent")
    expect(text).toContain("urn:oasis:names:tc:SAML:attribute:subject-id")
  })

  it("warns when the project has not turned SAML on", () => {
    const config: SupatypeProjectConfig = {
      project: { name: "acme" },
      database: { provider: "docker" },
      server: { mode: "dev" },
      app: { mode: "none" },
    }
    expect(samlOffWarning(config)).toMatch(/auth\.sso\.saml\.enabled/)
    expect(samlOffWarning({ ...config, auth: { sso: { saml: { enabled: true } } } })).toBeUndefined()
  })
})

describe("sso rotate-key", () => {
  let dir = ""
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "supatype-sso-rotate-"))
    writeFileSync(join(dir, ".env"), "JWT_SECRET=kept\nSUPATYPE_SAML_PRIVATE_KEY=current\n")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const env = (): string => readFileSync(join(dir, ".env"), "utf8")

  it("creates the next key once, beside the current one", () => {
    expect(createNextSamlKey(dir)).toBe("created")
    const first = env()
    expect(first).toContain("SUPATYPE_SAML_PRIVATE_KEY=current")
    expect(/^SUPATYPE_SAML_NEXT_PRIVATE_KEY=(.{1000,})$/m.test(first)).toBe(true)
    expect(createNextSamlKey(dir)).toBe("exists")
    expect(env()).toBe(first)
  })

  it("promotes the next key to current and removes it", () => {
    writeFileSync(join(dir, ".env"), "JWT_SECRET=kept\nSUPATYPE_SAML_PRIVATE_KEY=current\nSUPATYPE_SAML_NEXT_PRIVATE_KEY=next\n")
    expect(promoteNextSamlKey(dir)).toBe("promoted")
    expect(env()).toBe("JWT_SECRET=kept\nSUPATYPE_SAML_PRIVATE_KEY=next\n")
  })

  it("has nothing to promote without a next key", () => {
    expect(promoteNextSamlKey(dir)).toBe("no-next-key")
    expect(env()).toContain("SUPATYPE_SAML_PRIVATE_KEY=current")
  })
})
