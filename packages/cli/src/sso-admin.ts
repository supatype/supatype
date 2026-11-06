/**
 * The auth server's SSO admin API (`/auth/v1/admin/sso/providers`), for `supatype sso`.
 *
 * A provider is addressed by the name given at `sso add`, stored as its `resource_id` and reached as
 * `resource_<name>`. Never by deleting and adding it again: a user who signed in through a provider
 * is keyed on the provider's id, so a new provider orphans every one of them.
 */
import { readFile } from "node:fs/promises"
import {
  isArrayOf,
  isBoolean,
  isRecordOf,
  isShape,
  isString,
  isUnknown,
  nullable,
  optional,
  type Guard,
} from "@supatype/shared"
import { configuredServiceRoleKey } from "./dev-api-keys.js"
import { errorMessage } from "./error-message.js"
import { loadProjectLink } from "./link.js"
import { requireLocalStackApi } from "./local-stack-guard.js"
import { resolveProjectApiUrl } from "./resolve-api-url.js"
import { resolveTarget, type DeployTarget } from "./resolve-target.js"
import { targetFetch } from "./target-client.js"

/** Where the admin API is, the key it is called with, and how to name it in what the CLI says. */
export interface SsoEndpoint {
  baseUrl: string
  token: string
  where: string
  /** What to do when nothing answers at `baseUrl`. */
  unreachableHint?: string
}

/** The NameID formats the server accepts, by the short names the CLI takes. */
export const NAME_ID_FORMATS = {
  persistent: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  emailAddress: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  transient: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
  unspecified: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
} as const

export type NameIdFormatName = keyof typeof NAME_ID_FORMATS

const isAttributeMapping = isShape({
  keys: isRecordOf(
    isShape({
      name: optional(isString),
      names: optional(isArrayOf(isString)),
      default: optional(isUnknown),
      array: optional(isBoolean),
    }),
  ),
})

/** How assertion attributes become user metadata: the admin API's `attribute_mapping`. */
export type SamlAttributeMapping = typeof isAttributeMapping extends Guard<infer T> ? T : never

const isSsoProvider = isShape({
  id: isString,
  resource_id: optional(nullable(isString)),
  disabled: optional(nullable(isBoolean)),
  saml: optional(
    isShape({
      entity_id: isString,
      metadata_url: optional(isString),
      name_id_format: optional(isString),
      attribute_mapping: optional(isUnknown),
    }),
  ),
  domains: optional(nullable(isArrayOf(isShape({ domain: isString })))),
  created_at: optional(isString),
  updated_at: optional(isString),
})

/** One identity provider as the admin API answers it. */
export type SsoProvider = typeof isSsoProvider extends Guard<infer T> ? T : never

const isProviderList = isShape({ items: nullable(isArrayOf(isSsoProvider)) })

/** What `add` and `update` send, read from their flags. */
export interface SsoProviderInput {
  metadataUrl?: string
  metadataXml?: string
  domains?: string[]
  attributeMapping?: SamlAttributeMapping
  nameIdFormat?: NameIdFormatName
}

/** The flags `add` and `update` take, as commander gives them. */
export interface SsoFlags {
  metadataUrl?: string
  metadataFile?: string
  domains?: string
  attributeMappingFile?: string
  nameIdFormat?: string
}

/** A provider name: what `resource_<name>` can carry in a URL path. */
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Refuse a name the admin API could not be addressed by. */
export function assertProviderName(name: string): void {
  if (PROVIDER_NAME.test(name)) return
  throw new Error(`"${name}" is not a provider name: use letters, digits, ".", "_" and "-", starting with a letter or digit`)
}

/** The provider input `flags` describe. `requireMetadata` for `add`, which needs the IdP's metadata. */
export async function ssoProviderInput(flags: SsoFlags, { requireMetadata }: { requireMetadata: boolean }): Promise<SsoProviderInput> {
  const metadata = await metadataInput(flags, requireMetadata)
  const domains = flags.domains === undefined ? undefined : parseDomains(flags.domains)
  const attributeMapping =
    flags.attributeMappingFile === undefined ? undefined : await readAttributeMapping(flags.attributeMappingFile)
  const nameIdFormat = flags.nameIdFormat === undefined ? undefined : parseNameIdFormat(flags.nameIdFormat)
  return {
    ...metadata,
    ...(domains !== undefined && { domains }),
    ...(attributeMapping !== undefined && { attributeMapping }),
    ...(nameIdFormat !== undefined && { nameIdFormat }),
  }
}

async function metadataInput(flags: SsoFlags, required: boolean): Promise<Pick<SsoProviderInput, "metadataUrl" | "metadataXml">> {
  if (flags.metadataUrl !== undefined && flags.metadataFile !== undefined) {
    throw new Error("Give the identity provider's metadata as --metadata-url or --metadata-file, not both")
  }
  if (flags.metadataUrl !== undefined) return { metadataUrl: parseMetadataUrl(flags.metadataUrl) }
  if (flags.metadataFile !== undefined) return { metadataXml: await readText(flags.metadataFile, "the metadata file") }
  if (required) throw new Error("Give the identity provider's metadata with --metadata-url or --metadata-file")
  return {}
}

/** An absolute http(s) URL. The server takes https only, and http too in dev mode. */
function parseMetadataUrl(value: string): string {
  let protocol = ""
  try {
    protocol = new URL(value).protocol
  } catch {
    throw new Error(`--metadata-url must be an absolute URL (got ${JSON.stringify(value)})`)
  }
  if (protocol !== "https:" && protocol !== "http:") throw new Error("--metadata-url must be an https URL")
  return value
}

function parseDomains(value: string): string[] {
  return value
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain !== "")
}

function parseNameIdFormat(value: string): NameIdFormatName {
  const known = Object.keys(NAME_ID_FORMATS)
  const found = known.find((name): name is NameIdFormatName => name === value)
  if (found !== undefined) return found
  throw new Error(`--name-id-format must be one of ${known.join(", ")} (got ${JSON.stringify(value)})`)
}

async function readText(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch (err) {
    throw new Error(`Could not read ${what} ${path}: ${errorMessage(err)}`, { cause: err })
  }
}

async function readAttributeMapping(path: string): Promise<SamlAttributeMapping> {
  const text = await readText(path, "the attribute mapping file")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`${path} is not JSON: ${errorMessage(err)}`, { cause: err })
  }
  if (isAttributeMapping(value)) return value
  throw new Error(
    `${path} is not an attribute mapping. It is the admin API's shape: ` +
      '{ "keys": { "<attribute>": { "name": ... } } }, each key naming the user metadata field, with ' +
      "name or names (the assertion attributes to read), and optional default and array.",
  )
}

/** What `input` changes, as the admin API names it. */
function changeBody(input: SsoProviderInput): Record<string, unknown> {
  return {
    ...(input.metadataUrl !== undefined && { metadata_url: input.metadataUrl }),
    ...(input.metadataXml !== undefined && { metadata_xml: input.metadataXml }),
    ...(input.domains !== undefined && { domains: input.domains }),
    ...(input.attributeMapping !== undefined && { attribute_mapping: input.attributeMapping }),
    ...(input.nameIdFormat !== undefined && { name_id_format: NAME_ID_FORMATS[input.nameIdFormat] }),
  }
}

/** The admin API's path for the provider called `name`. */
function providerPath(name: string): string {
  return `/admin/sso/providers/resource_${encodeURIComponent(name)}`
}

/** One call to the admin API. A metadata URL is fetched by the server, so it gets time for that. */
function adminCall<T>(endpoint: SsoEndpoint, method: string, path: string, guard: Guard<T>, body?: unknown): Promise<T> {
  const options = {
    method,
    path,
    token: endpoint.token,
    timeoutMs: 30_000,
    ...(body !== undefined && { body }),
    ...(endpoint.unreachableHint !== undefined && { unreachableHint: endpoint.unreachableHint }),
  }
  return targetFetch(endpoint.baseUrl, "/auth/v1", options, guard)
}

export async function listSsoProviders(endpoint: SsoEndpoint): Promise<SsoProvider[]> {
  const answer = await adminCall(endpoint, "GET", "/admin/sso/providers", isProviderList)
  return answer.items ?? []
}

export function getSsoProvider(endpoint: SsoEndpoint, name: string): Promise<SsoProvider> {
  return adminCall(endpoint, "GET", providerPath(name), isSsoProvider)
}

export function createSsoProvider(endpoint: SsoEndpoint, name: string, input: SsoProviderInput): Promise<SsoProvider> {
  const body = { type: "saml", resource_id: name, ...changeBody(input) }
  return adminCall(endpoint, "POST", "/admin/sso/providers", isSsoProvider, body)
}

/**
 * Change the provider called `name` in place. The NameID format goes with every update, the one it
 * has unless told otherwise: the server clears a format an update leaves out.
 */
export async function updateSsoProvider(endpoint: SsoEndpoint, name: string, input: SsoProviderInput): Promise<SsoProvider> {
  const current = await getSsoProvider(endpoint, name)
  const body = { ...changeBody(input) }
  if (input.nameIdFormat === undefined) body["name_id_format"] = current.saml?.name_id_format ?? ""
  return adminCall(endpoint, "PUT", providerPath(name), isSsoProvider, body)
}

export async function removeSsoProvider(endpoint: SsoEndpoint, name: string): Promise<void> {
  await adminCall(endpoint, "DELETE", providerPath(name), isUnknown)
}

// ---------------------------------------------------------------------------
// Where the admin API is
// ---------------------------------------------------------------------------

/** Cloud's per-environment server does not run SAML yet (a Cloud launch item). */
const CLOUD_NOT_YET =
  "SAML single sign-on is not available on Supatype Cloud yet. `supatype sso` works against the " +
  "local stack and self-hosted deployments."

const LOCAL_STACK_DOWN = "The local stack is not running: start it with `supatype dev`, then run this again."

/** The linked deployment's target, or undefined for a project that is not linked. Cloud is refused. */
function linkedSsoTarget(cwd: string, tokenOptional: boolean): DeployTarget | undefined {
  const link = loadProjectLink(cwd)
  if (link === null) return undefined
  if (link.kind === "cloud") throw new Error(CLOUD_NOT_YET)
  return resolveTarget(cwd, { tokenOptional })
}

/**
 * The admin API for `supatype sso <command>`: the linked deployment's, else the local stack's,
 * which has to be running. Called with the service-role key, the link's or `.env`'s.
 */
export function resolveSsoEndpoint(cwd: string, command: string): SsoEndpoint {
  const target = linkedSsoTarget(cwd, false)
  if (target !== undefined) {
    if (!target.token) throw new Error(`No token for environment "${target.environment}". Re-run supatype link --token ...`)
    const where = `${target.mode} project ${target.projectRef} (${target.environment})`
    return { baseUrl: target.apiBaseUrl, token: target.token, where }
  }
  requireLocalStackApi(cwd, `sso ${command}`)
  const token = configuredServiceRoleKey(cwd)
  if (token === undefined) throw new Error("SERVICE_ROLE_KEY not found in .env, run supatype dev or supatype keys")
  return { baseUrl: resolveProjectApiUrl(cwd), token, where: "the local stack", unreachableHint: LOCAL_STACK_DOWN }
}

/** The project's public API URL for `sso info`: the linked deployment's or the local stack's. */
export function ssoApiBaseUrl(cwd: string): { baseUrl: string; linked: boolean } {
  const target = linkedSsoTarget(cwd, true)
  if (target !== undefined) return { baseUrl: target.apiBaseUrl, linked: target.mode !== "local" }
  return { baseUrl: resolveProjectApiUrl(cwd), linked: false }
}

/** Whether the project is linked to a deployment other than this machine, for `rotate-key`. */
export function linkedToDeployment(cwd: string): boolean {
  const link = loadProjectLink(cwd)
  return link !== null && link.kind !== "local"
}
