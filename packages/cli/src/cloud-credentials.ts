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
import { isJsonObject, isOneOf, isShape, isString, optional } from "@supatype/shared"
import { responseFailureText } from "./error-message.js"
import { isPersonalAccessToken } from "./personal-access-token.js"
import { readJsonFile } from "./json-file.js"

export const CREDENTIALS_VERSION = 1 as const

export interface CloudCredentials {
  version: typeof CREDENTIALS_VERSION
  apiUrl: string
  accessToken: string
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
  refreshToken: optional(isString),
  email: optional(isString),
  updatedAt: optional(isString),
})

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
  const linkApi = (link.cloudApiUrl ?? "").replace(/\/$/, "")
  const credApi = creds.apiUrl.replace(/\/$/, "")
  if (linkApi && credApi && linkApi !== credApi) return undefined
  return creds.accessToken
}

export function resolveCloudRefreshToken(link: ProjectLink): string | undefined {
  if (link.refreshToken) return link.refreshToken
  if (link.kind !== "cloud") return undefined
  const creds = loadCloudCredentials()
  if (!creds?.refreshToken) return undefined
  const linkApi = (link.cloudApiUrl ?? "").replace(/\/$/, "")
  const credApi = creds.apiUrl.replace(/\/$/, "")
  if (linkApi && credApi && linkApi !== credApi) return undefined
  return creds.refreshToken
}

/** Write tokens to global credentials and the current project's cloud link (if any). */
export function persistCloudSession(
  cwd: string,
  params: {
    apiUrl: string
    accessToken: string
    refreshToken?: string
    email?: string
  },
): void {
  const apiUrl = params.apiUrl.replace(/\/$/, "")
  const existing = loadCloudCredentials()
  // A personal access token replaces the session whole: the old refresh token belongs to a session
  // that no longer signs anything in, and a token that cannot be renewed must not be offered one.
  const pat = isPersonalAccessToken(params.accessToken)
  const refreshToken = pat ? undefined : (params.refreshToken ?? existing?.refreshToken)
  saveCloudCredentials({
    version: CREDENTIALS_VERSION,
    apiUrl,
    accessToken: params.accessToken,
    updatedAt: new Date().toISOString(),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(params.email !== undefined
      ? { email: params.email }
      : existing?.email !== undefined
        ? { email: existing.email }
        : {}),
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

/** The email `accessToken` signs in as, from the control plane's `/auth/me`; throws when it is refused or unreachable. */
export async function fetchCloudEmail(apiUrl: string, accessToken: string): Promise<string> {
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`The control plane did not accept the token: ${await responseFailureText(res)}`)
  const body: unknown = await res.json().catch(() => ({}))
  const user = isJsonObject(body) ? body["user"] : undefined
  const email = isJsonObject(user) ? user["email"] : undefined
  if (!isString(email)) throw new Error("The control plane did not say whose token this is.")
  return email
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
