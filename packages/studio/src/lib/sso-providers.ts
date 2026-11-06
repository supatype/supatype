import type { SupatypeClient } from "@supatype/client"
import { authRefusalText } from "./auth-refusal.js"
import { isJsonObject, isString, readJsonObject } from "./json.js"
import { studioAuthHeaders } from "./studio-auth-headers.js"
import { studioGatewayHeaders } from "./studio-gateway-headers.js"

/**
 * The project's SAML identity providers, through the auth admin API at
 * `/auth/v1/admin/sso/providers` (supatype-auth `internal/auth/ssoadmin.go`).
 *
 * A provider is addressed as `resource_<name>` when it has a name (its `resource_id`, the stable key
 * the CLI and infrastructure as code use), else by its ID. A user who signed in through a provider
 * is keyed on that ID, so a provider is changed in place and never removed and added again.
 */

/** The server's attribute mapping: SAML attribute names for each user field. */
export interface AttributeMapping {
  keys: Record<string, unknown>
}

export interface SsoProvider {
  id: string
  /** The provider's name, or null for one registered without one. */
  resourceId: string | null
  entityId: string
  metadataUrl: string | null
  domains: string[]
  disabled: boolean
  /** The NameID format asked for, or "" for the server's default (persistent). */
  nameIdFormat: string
  attributeMapping: AttributeMapping | null
}

/** The NameID formats the server accepts (`CreateSSOProviderParams.validate`), "" its default. */
export const NAME_ID_FORMATS = [
  { value: "", label: "Server default (persistent)" },
  { value: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", label: "Persistent" },
  { value: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", label: "Email address" },
  { value: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient", label: "Transient" },
  { value: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified", label: "Unspecified" },
] as const

/** Where the provider's metadata comes from, or `keep` to leave what the server holds. */
export type MetadataSource = { kind: "url"; url: string } | { kind: "xml"; xml: string } | { kind: "keep" }

/** What the add and edit form sends. */
export interface SsoProviderDraft {
  name: string
  metadata: MetadataSource
  domains: string[]
  nameIdFormat: string
  attributeMapping: AttributeMapping | null
}

/** A write's outcome: null when it went through, else the server's reason in its own words. */
export type WriteOutcome = string | null

function stringOr<T>(value: unknown, fallback: T): string | T {
  return isString(value) && value !== "" ? value : fallback
}

function domainsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((d) => (isJsonObject(d) && isString(d["domain"]) ? [d["domain"]] : []))
}

function mappingOf(raw: unknown): AttributeMapping | null {
  if (!isJsonObject(raw) || !isJsonObject(raw["keys"])) return null
  return Object.keys(raw["keys"]).length > 0 ? { keys: raw["keys"] } : null
}

/** One provider as the server sends it, read defensively; null when it has no ID. */
export function parseSsoProvider(raw: unknown): SsoProvider | null {
  if (!isJsonObject(raw) || !isString(raw["id"])) return null
  const saml = isJsonObject(raw["saml"]) ? raw["saml"] : {}
  return {
    id: raw["id"],
    resourceId: stringOr(raw["resource_id"], null),
    entityId: stringOr(saml["entity_id"], ""),
    metadataUrl: stringOr(saml["metadata_url"], null),
    domains: domainsOf(raw["domains"]),
    disabled: raw["disabled"] === true,
    nameIdFormat: stringOr(saml["name_id_format"], ""),
    attributeMapping: mappingOf(saml["attribute_mapping"]),
  }
}

/** The name a provider is shown by: its resource ID, else its ID. */
export function providerName(provider: SsoProvider): string {
  return provider.resourceId ?? provider.id
}

/** The path segment that addresses `provider` in the admin API. */
export function providerAddress(provider: SsoProvider): string {
  return provider.resourceId !== null ? `resource_${encodeURIComponent(provider.resourceId)}` : encodeURIComponent(provider.id)
}

/** The domains typed in a field: split on commas and white space, lower-cased, each once. */
export function parseDomains(text: string): string[] {
  const all = text.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter((d) => d !== "")
  return [...new Set(all)]
}

export type ParsedMapping = { ok: true; mapping: AttributeMapping | null } | { ok: false; error: string }

/** The attribute mapping typed in a field, in the server's `{ "keys": {...} }` shape; empty for none. */
export function parseAttributeMapping(text: string): ParsedMapping {
  if (text.trim() === "") return { ok: true, mapping: null }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, error: "Attribute mapping is not valid JSON" }
  }
  if (!isJsonObject(value) || !isJsonObject(value["keys"])) {
    return { ok: false, error: 'Attribute mapping needs a "keys" object, as in {"keys": {"email": {"name": "mail"}}}' }
  }
  return { ok: true, mapping: { keys: value["keys"] } }
}

function metadataFields(source: MetadataSource): Record<string, string> {
  if (source.kind === "url") return { metadata_url: source.url }
  if (source.kind === "xml") return { metadata_xml: source.xml }
  return {}
}

/** The POST body that registers `draft`, named by its resource ID. */
export function createBody(draft: SsoProviderDraft): Record<string, unknown> {
  return {
    type: "saml",
    resource_id: draft.name,
    ...metadataFields(draft.metadata),
    domains: draft.domains,
    name_id_format: draft.nameIdFormat,
    ...(draft.attributeMapping !== null && { attribute_mapping: draft.attributeMapping }),
  }
}

/**
 * The PUT body that changes a provider to `draft`. Domains, NameID format and attribute mapping are
 * always sent: the server reads an absent `name_id_format` as "clear it", and an empty mapping is
 * how one is cleared. Metadata goes only when it changed, since sending it makes the server fetch
 * or parse it again.
 */
export function updateBody(draft: SsoProviderDraft): Record<string, unknown> {
  return {
    ...metadataFields(draft.metadata),
    domains: draft.domains,
    name_id_format: draft.nameIdFormat,
    attribute_mapping: draft.attributeMapping ?? { keys: {} },
  }
}

function adminHeaders(client: SupatypeClient): Record<string, string> {
  return { ...studioGatewayHeaders(), ...studioAuthHeaders(client), "Content-Type": "application/json" }
}

function providersUrl(client: SupatypeClient, address?: string): string {
  const base = `${client.url}/auth/v1/admin/sso/providers`
  return address === undefined ? base : `${base}/${address}`
}

async function refusal(res: Response, doing: string): Promise<string> {
  return authRefusalText(await readJsonObject(res)) ?? `Could not ${doing} (HTTP ${res.status})`
}

/** The reason a request that never reached the server gives. */
export function unreachable(err: unknown): string {
  return `Could not reach the auth server: ${err instanceof Error ? err.message : String(err)}`
}

/** Every provider the project has, or the reason the list could not be read. */
export async function listSsoProviders(client: SupatypeClient): Promise<{ providers: SsoProvider[] } | { error: string }> {
  try {
    const res = await fetch(providersUrl(client), { headers: adminHeaders(client), credentials: "include" })
    if (!res.ok) return { error: await refusal(res, "list the SSO providers") }
    const items = (await readJsonObject(res))["items"]
    const providers = Array.isArray(items) ? items.map(parseSsoProvider).filter((p): p is SsoProvider => p !== null) : []
    return { providers }
  } catch (err) {
    return { error: unreachable(err) }
  }
}

/** One write to the admin API: the method, the provider it addresses (none to create), its body. */
export interface ProviderWrite {
  method: "POST" | "PUT" | "DELETE"
  address?: string
  body?: Record<string, unknown>
}

/** Send one write; null when the server took it, else its reason. A request that throws is reported. */
export async function writeSsoProvider(client: SupatypeClient, write: ProviderWrite): Promise<WriteOutcome> {
  try {
    const res = await fetch(providersUrl(client, write.address), {
      method: write.method,
      headers: adminHeaders(client),
      credentials: "include",
      ...(write.body !== undefined && { body: JSON.stringify(write.body) }),
    })
    return res.ok ? null : await refusal(res, "save the SSO provider")
  } catch (err) {
    return unreachable(err)
  }
}

/** The values an identity provider is given, as the server's own SP metadata states them. */
export interface ServiceProviderValues {
  entityId: string
  acsUrl: string
}

const POST_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"

/** The entity ID and the HTTP-POST ACS URL in SP metadata XML, or null when they are not there. */
export function serviceProviderValues(xml: string): ServiceProviderValues | null {
  const doc = new DOMParser().parseFromString(xml, "application/xml")
  const entityId = doc.getElementsByTagNameNS("*", "EntityDescriptor")[0]?.getAttribute("entityID")
  const services = [...doc.getElementsByTagNameNS("*", "AssertionConsumerService")]
  const acsUrl = (services.find((s) => s.getAttribute("Binding") === POST_BINDING) ?? services[0])?.getAttribute("Location")
  return entityId && acsUrl ? { entityId, acsUrl } : null
}

/** The SP metadata the server publishes, read through the proxy as every auth call is. */
export async function fetchServiceProvider(client: SupatypeClient): Promise<ServiceProviderValues | { error: string }> {
  try {
    const res = await fetch(`${client.url}/auth/v1/sso/saml/metadata`, {
      headers: { ...studioGatewayHeaders(), ...studioAuthHeaders(client) },
      credentials: "include",
    })
    if (!res.ok) return { error: `Could not read the SAML metadata (HTTP ${res.status})` }
    return serviceProviderValues(await res.text()) ?? { error: "The SAML metadata names no entity ID or ACS URL" }
  } catch (err) {
    return { error: unreachable(err) }
  }
}
