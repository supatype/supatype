/**
 * Cloud credentials for the CLI and the control plane: the personal access token `supatype login`
 * stores, or the session (access + refresh) an older CLI stored.
 * Self-host links keep using long-lived SERVICE_ROLE_KEY and ignore this store.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  loadProjectLink,
  saveProjectLink,
  type ProjectLink,
} from "./link.js"
import { isOneOf, isShape, isString, optional } from "@supatype/shared"
import { trimApiUrl } from "./api-url.js"
import { responseFailureText } from "./error-message.js"
import { fetchWithin } from "./fetch-within.js"
import { isPersonalAccessToken } from "./personal-access-token.js"
import { readJsonFile } from "./json-file.js"

export const CREDENTIALS_VERSION = 1 as const

/** What a stored token is: a personal access token, which is never renewed, or a session, which is. */
export type CredentialKind = "pat" | "session"

export interface CloudCredentials {
  version: typeof CREDENTIALS_VERSION
  apiUrl: string
  accessToken: string
  /** Absent in a file an older CLI wrote; read it through {@link credentialKind}. */
  kind?: CredentialKind
  refreshToken?: string
  email?: string
  updatedAt: string
}

/**
 * The file as it may be on disk. Only the URL and token are needed to use it: a file written by
 * hand, or by an older CLI, may lack the version and timestamp, and was always accepted without them.
 */
const isStoredCredentials = isShape({
  version: optional(isOneOf([CREDENTIALS_VERSION])),
  apiUrl: isString,
  accessToken: isString,
  kind: optional(isOneOf(["pat", "session"] as const)),
  refreshToken: optional(isString),
  email: optional(isString),
  updatedAt: optional(isString),
})

/** The kind of `creds`: as stored, else by the token's shape for a file written before the kind was stored. */
export function credentialKind(creds: CloudCredentials): CredentialKind {
  return creds.kind ?? (isPersonalAccessToken(creds.accessToken) ? "pat" : "session")
}

export function credentialsPath(): string {
  return join(homedir(), ".supatype", "credentials.json")
}

export function loadCloudCredentials(): CloudCredentials | null {
  const path = credentialsPath()
  if (!existsSync(path)) return null
  const raw = readJsonFile(path, isStoredCredentials)
  if (!raw?.accessToken || !raw.apiUrl) return null
  return { ...raw, version: CREDENTIALS_VERSION, updatedAt: raw.updatedAt ?? "" }
}

export function saveCloudCredentials(creds: CloudCredentials): void {
  const dir = join(homedir(), ".supatype")
  mkdirSync(dir, { recursive: true })
  // It holds the session's tokens, so it is created readable by its owner alone. Only the CLI reads
  // it, unlike a project's `.env`, which the stack's containers read as another user.
  writeFileSync(credentialsPath(), `${JSON.stringify(creds, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
}

export function clearCloudCredentials(): void {
  const path = credentialsPath()
  if (!existsSync(path)) return
  try {
    unlinkSync(path)
  } catch {
    /* ignore */
  }
}

/** Prefer link tokens; fall back to ~/.supatype/credentials.json for cloud. */
export function resolveCloudAccessToken(link: ProjectLink): string | undefined {
  if (link.token) return link.token
  if (link.kind !== "cloud") return undefined
  const creds = loadCloudCredentials()
  if (!creds) return undefined
  const linkApi = trimApiUrl(link.cloudApiUrl ?? "")
  const credApi = trimApiUrl(creds.apiUrl)
  if (linkApi && credApi && linkApi !== credApi) return undefined
  return creds.accessToken
}

export function resolveCloudRefreshToken(link: ProjectLink): string | undefined {
  if (link.refreshToken) return link.refreshToken
  if (link.kind !== "cloud") return undefined
  const creds = loadCloudCredentials()
  if (!creds?.refreshToken) return undefined
  const linkApi = trimApiUrl(link.cloudApiUrl ?? "")
  const credApi = trimApiUrl(creds.apiUrl)
  if (linkApi && credApi && linkApi !== credApi) return undefined
  return creds.refreshToken
}

/** Write tokens to global credentials and the current project's cloud link (if any). */
export function persistCloudSession(
  cwd: string,
  params: {
    apiUrl: string
    accessToken: string
    kind: CredentialKind
    refreshToken?: string
    email?: string
  },
): void {
  const apiUrl = trimApiUrl(params.apiUrl)
  const existing = loadCloudCredentials()
  // A personal access token replaces the session whole: the old refresh token belongs to a session
  // that no longer signs anything in, and a token that cannot be renewed must not be offered one.
  const pat = params.kind === "pat"
  const refreshToken = pat ? undefined : (params.refreshToken ?? existing?.refreshToken)
  const email = params.email ?? existing?.email
  saveCloudCredentials({
    version: CREDENTIALS_VERSION,
    apiUrl,
    accessToken: params.accessToken,
    kind: params.kind,
    updatedAt: new Date().toISOString(),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(email !== undefined ? { email } : {}),
  })

  const link = loadProjectLink(cwd)
  if (!link || link.kind !== "cloud") return
  link.token = params.accessToken
  if (pat) {
    delete link.refreshToken
  } else if (params.refreshToken !== undefined) {
    link.refreshToken = params.refreshToken
  }
  saveProjectLink(cwd, link)
}

/** How long asking who a token belongs to may take. */
const WHOAMI_TIMEOUT_MS = 10_000

const isWhoami = isShape({ user: isShape({ email: isString }) })

/** The email `accessToken` signs in as, from the control plane's `/auth/me`; throws when it is refused or unreachable. */
export async function fetchCloudEmail(apiUrl: string, accessToken: string): Promise<string> {
  const res = await fetchWithin(`${trimApiUrl(apiUrl)}/auth/me`, WHOAMI_TIMEOUT_MS, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`The control plane did not accept the token: ${await responseFailureText(res)}`)
  const body: unknown = await res.json().catch(() => undefined)
  if (!isWhoami(body)) throw new Error("The control plane did not say whose token this is.")
  return body.user.email
}

/** What the control plane says about a stored session. */
export type CloudSessionCheck =
  | { state: "valid" }
  | { state: "rejected" }
  | { state: "unreachable"; reason: string }

/**
 * Ask the control plane (`GET /auth/me`) whether `accessToken` still opens a session. Only a 401 or
 * 403 is a rejection: a network failure or a 5xx says nothing about the token, so it is reported as
 * unreachable and the caller does not sign the user out on it.
 */
export async function checkCloudSession(apiUrl: string, accessToken: string): Promise<CloudSessionCheck> {
  const base = apiUrl.replace(/\/$/, "")
  try {
    const res = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (res.ok) return { state: "valid" }
    if (res.status === 401 || res.status === 403) return { state: "rejected" }
    return { state: "unreachable", reason: `${base} answered ${res.status}` }
  } catch (err) {
    return { state: "unreachable", reason: `${base} did not answer (${err instanceof Error ? err.message : String(err)})` }
  }
}

/**
 * A Cloud access token set in the environment, for CI: SUPATYPE_ACCESS_TOKEN, else SUPATYPE_TOKEN,
 * its older name; undefined when neither holds anything. Every command reads it here, so a linked
 * project's commands take the same token `supatype link` and the cloud commands do.
 */
export function envAccessToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of ["SUPATYPE_ACCESS_TOKEN", "SUPATYPE_TOKEN"]) {
    const token = env[name]?.trim()
    if (token) return token
  }
  return undefined
}
