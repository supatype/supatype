/**
 * Cloud session credentials (access + refresh) for CLI ↔ control plane.
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
import { readAuthAnswer } from "./auth-answer.js"
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
  writeFileSync(credentialsPath(), `${JSON.stringify(creds, null, 2)}\n`, "utf8")
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
  saveCloudCredentials({
    version: CREDENTIALS_VERSION,
    apiUrl,
    accessToken: params.accessToken,
    updatedAt: new Date().toISOString(),
    ...(params.refreshToken !== undefined
      ? { refreshToken: params.refreshToken }
      : existing?.refreshToken !== undefined
        ? { refreshToken: existing.refreshToken }
        : {}),
    ...(params.email !== undefined
      ? { email: params.email }
      : existing?.email !== undefined
        ? { email: existing.email }
        : {}),
  })

  const link = loadProjectLink(cwd)
  if (!link || link.kind !== "cloud") return
  link.token = params.accessToken
  if (params.refreshToken !== undefined) {
    link.refreshToken = params.refreshToken
  }
  saveProjectLink(cwd, link)
}

export interface CloudLoginResult {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
  email?: string
}

/** Password login against control-plane `/auth/login` (not `/api/v1`). */
export async function cloudPasswordLogin(
  apiUrl: string,
  email: string,
  password: string,
): Promise<CloudLoginResult> {
  const base = apiUrl.replace(/\/$/, "")
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.toLowerCase(), password }),
  })
  const answer = readAuthAnswer(await res.json().catch(() => ({})))
  if (!res.ok || !answer.accessToken) {
    throw new Error(answer.failure ?? `Login failed (${res.status})`)
  }
  const { accessToken, refreshToken, expiresIn } = answer
  return {
    accessToken,
    ...(refreshToken !== undefined && { refreshToken }),
    ...(expiresIn !== undefined && { expiresIn }),
    email: answer.email ?? email.toLowerCase(),
  }
}

export async function cloudRefreshSession(
  apiUrl: string,
  refreshToken: string,
): Promise<CloudLoginResult> {
  const base = apiUrl.replace(/\/$/, "")
  const res = await fetch(`${base}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  const answer = readAuthAnswer(await res.json().catch(() => ({})))
  if (!res.ok || !answer.accessToken) {
    throw new Error(answer.failure ?? `Token refresh failed (${res.status})`)
  }
  const { accessToken, refreshToken: next, expiresIn } = answer
  return { accessToken, ...(next !== undefined && { refreshToken: next }), ...(expiresIn !== undefined && { expiresIn }) }
}
