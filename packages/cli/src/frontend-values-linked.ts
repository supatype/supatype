/**
 * The front-end values a project's linked environment gives a production build (frontend-values.ts).
 *
 * Supatype Cloud: the environment's own address, which the link records, and the anon key from the
 * control plane's `GET /projects/:slug/environments/:name/keys`, which also returns the service role
 * key, dropped here. A self-hosted server: the link's address, and the anon key the server publishes
 * at `GET <apiUrl>/supatype-env.json` (`{ "url", "anonKey" }`), fetched over HTTPS only for an address
 * that is not local, so the key a build ships is the one the server it names actually holds.
 */

import { isShape, isString } from "@supatype/shared"
import { bodyReason, errorMessage } from "./error-message.js"
import { fetchWithin } from "./fetch-within.js"
import { isLocalUrl } from "./frontend-env.js"
import type { FrontendFinding, FrontendSourceRead, FrontendValueName, ResolveFrontendOptions } from "./frontend-values.js"
import { loadProjectLink, type ProjectLink } from "./link.js"
import { projectRequest, resolveTarget, type DeployTarget } from "./resolve-target.js"
import { targetFetch } from "./target-client.js"

/** How long a server or the control plane gets to answer for the anon key. */
const KEY_FETCH_TIMEOUT_MS = 15_000

/** The address a self-hosted server publishes its front-end values at. */
const PUBLIC_ENV_PATH = "/supatype-env.json"

const isPublicEnv = isShape({ anonKey: isString })

const NOT_LINKED = "the linked environment"

/** Both values unset, saying why. */
function neither(name: string, note: string): FrontendSourceRead {
  return { name, findings: { apiUrl: { note }, anonKey: { note } } }
}

/** The project's link, or a source read saying why there is none. */
function readLink(cwd: string): ProjectLink | FrontendSourceRead {
  try {
    return loadProjectLink(cwd) ?? neither(NOT_LINKED, "no .supatype/link.json (run `supatype link`)")
  } catch (err) {
    return neither(NOT_LINKED, errorMessage(err))
  }
}

/**
 * What the linked environment (`opts.env`, else the link's default) holds for the values `wanted`.
 * Never throws: a link that cannot be read, a session that has expired, a server that refuses, each
 * is a note on the source, for the refusal to list.
 */
export async function readLinkedFrontendValues(
  opts: ResolveFrontendOptions,
  wanted: readonly FrontendValueName[],
): Promise<FrontendSourceRead> {
  const link = readLink(opts.cwd)
  if (!("kind" in link)) return link
  let target: DeployTarget
  try {
    target = resolveTarget(opts.cwd, { env: opts.env, tokenOptional: true })
  } catch (err) {
    return neither(NOT_LINKED, errorMessage(err))
  }
  const cloud = target.mode === "cloud"
  const name = `linked environment "${target.environment}" (${cloud ? "Supatype Cloud" : "self-host"})`
  const apiUrl = cloud ? cloudEnvironmentUrl(link, target) : { value: target.apiBaseUrl, where: "the link" }
  if (!wanted.includes("anonKey")) return { name, findings: { apiUrl } }
  const anonKey = cloud
    ? await cloudAnonKey(target, link.environments[target.environment]?.apiUrl)
    : await publishedAnonKey(target.apiBaseUrl, opts.allowLocal === true)
  return { name, findings: { apiUrl, anonKey } }
}

/**
 * A Cloud environment's own address, as `supatype link` recorded it from the control plane. A link
 * made when the control plane did not list environments records the control plane's address in its
 * place, which a browser cannot use as the project's API.
 */
function cloudEnvironmentUrl(link: ProjectLink, target: DeployTarget): FrontendFinding {
  const recorded = link.environments[target.environment]?.apiUrl
  if (recorded === undefined) return { note: `the link records no address for "${target.environment}"` }
  if (recorded === link.cloudApiUrl) {
    return { note: `the link records the control plane's address (${recorded}) for "${target.environment}", not the project's: re-run \`supatype link\`` }
  }
  return { value: recorded, where: "the link" }
}

/** The environment's anon key from the control plane's keys route, which an owner or admin may read. */
async function cloudAnonKey(target: DeployTarget, deployment: string | undefined): Promise<FrontendFinding> {
  if (!target.token) return { note: "no Cloud session: run `supatype login`, or set SUPATYPE_ACCESS_TOKEN" }
  const subpath = `/environments/${encodeURIComponent(target.environment)}/keys`
  try {
    const request = { ...projectRequest(target, "GET", subpath), timeoutMs: KEY_FETCH_TIMEOUT_MS }
    const keys = await targetFetch(target.apiBaseUrl, target.apiPrefix, request, isPublicEnv)
    const where = `GET ${target.apiPrefix}/projects/${target.projectRef}${subpath}`
    // With no address recorded the key is for no URL this build can be sure of.
    return { value: keys.anonKey, where, deployment: deployment ?? target.apiBaseUrl }
  } catch (err) {
    return { note: `the control plane did not give the keys: ${errorMessage(err)}` }
  }
}

/**
 * The anon key the server at `apiUrl` publishes, read from {@link PUBLIC_ENV_PATH}: a self-hosted
 * server, or a Supatype Cloud environment's own address, which serves the same.
 */
export async function publishedAnonKey(apiUrl: string, allowLocal: boolean): Promise<FrontendFinding> {
  const url = `${apiUrl.replace(/\/$/, "")}${PUBLIC_ENV_PATH}`
  const local = isLocalUrl(apiUrl)
  if (local && !allowLocal) return { note: `not fetched from ${url}, a local address` }
  if (!local && !apiUrl.startsWith("https://")) {
    return { note: `not fetched from ${url}: the anon key is only fetched over HTTPS from an address that is not local` }
  }
  try {
    return await publishedKeyAnswer(await fetchWithin(url, KEY_FETCH_TIMEOUT_MS), url, apiUrl)
  } catch (err) {
    return { note: `${url} did not answer: ${errorMessage(err)}` }
  }
}

/**
 * What the server's answer at `url` says about its anon key. A 404 is the address switched off
 * (`server.public_env: false`); a 503 is a server not set up to publish it (no anon key, no URL, or
 * a service role key where the anon key goes), which names the missing setting in its body.
 */
async function publishedKeyAnswer(res: Response, url: string, apiUrl: string): Promise<FrontendFinding> {
  if (res.status === 404) {
    return { note: `${url} answered 404: the server has server.public_env set to false, or is older than the address` }
  }
  if (res.status === 503) {
    return { note: `the server at ${apiUrl} is not set up to publish its anon key: ${await oneLineReason(res)}` }
  }
  if (!res.ok) return { note: `${url} answered ${res.status} ${res.statusText}`.trimEnd() }
  const body: unknown = await res.json()
  return isPublicEnv(body) ? { value: body.anonKey, where: url, deployment: apiUrl } : { note: `${url} answered without an anonKey` }
}

/** Anything shaped like a JWT, so a key a misconfigured server quotes is never printed. */
const JWT_LIKE = /eyJ[\w-]*\.[\w-]+(\.[\w-]*)?/g

/** A response body's reason (its JSON `message`, else the text) on one line, with no JWT in it. */
async function oneLineReason(res: Response): Promise<string> {
  const text = await res.text().catch(() => "")
  let reason = text
  try {
    reason = bodyReason(JSON.parse(text)) ?? text
  } catch {
    // Not JSON: the text is the reason.
  }
  const line = reason.replace(JWT_LIKE, "<JWT withheld>").replace(/\s+/g, " ").trim()
  return line === "" ? "no reason given" : line
}
