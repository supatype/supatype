import { isJsonObject, isUnknown, type Guard } from "@supatype/shared"
import { readAuthAnswer } from "./auth-answer.js"

export interface TargetFetchOptions {
  method: string
  path: string
  body?: unknown
  token: string
  orgId?: string | undefined
  environment?: string | undefined
  /**
   * Cloud-only: renew short-lived access JWT via control-plane `/auth/refresh`.
   * Self-host SERVICE_ROLE_KEY links omit this.
   */
  authRefresh?: {
    cloudApiUrl: string
    refreshToken: string
    onRefreshed: (tokens: { accessToken: string; refreshToken?: string }) => void
  }
}

export class TargetApiError extends Error {
  readonly status: number
  readonly code?: string
  /**
   * The server's whole error body. A refusal names what it is about there (the drifted objects,
   * the unmanaged tables), as the engine binary does on its stdout.
   */
  readonly details?: Readonly<Record<string, unknown>>

  constructor(message: string, status: number, code?: string, details?: Readonly<Record<string, unknown>>) {
    super(message)
    this.name = "TargetApiError"
    this.status = status
    if (code !== undefined) this.code = code
    if (details !== undefined) this.details = details
  }
}

function isAuthExpiry(status: number, code?: string, message?: string): boolean {
  if (status !== 401) return false
  if (code === "TOKEN_EXPIRED" || code === "NO_SESSION" || code === "INVALID_TOKEN") return true
  const m = (message ?? "").toLowerCase()
  return m.includes("token expired") || m.includes("authentication required")
}

async function refreshAccessToken(
  authRefresh: NonNullable<TargetFetchOptions["authRefresh"]>,
): Promise<string> {
  const base = authRefresh.cloudApiUrl.replace(/\/$/, "")
  const res = await fetch(`${base}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: authRefresh.refreshToken }),
  })
  const answer = readAuthAnswer(await res.json().catch(() => ({})))
  if (!res.ok || !answer.accessToken) {
    throw new Error(`${answer.failure ?? "Token refresh failed"}. Run: supatype login`)
  }
  authRefresh.onRefreshed({
    accessToken: answer.accessToken,
    ...(answer.refreshToken !== undefined ? { refreshToken: answer.refreshToken } : {}),
  })
  return answer.accessToken
}

/** One response: its status and its body, which is `{}` when the body is not JSON. */
interface FetchAnswer {
  ok: boolean
  status: number
  json: unknown
}

/** A string field of the body, for reading an error's `message`, `error` and `code`. */
function bodyString(json: unknown, key: string): string | undefined {
  const value = isJsonObject(json) ? json[key] : undefined
  return typeof value === "string" ? value : undefined
}

async function fetchOnce(url: string, opts: TargetFetchOptions, token: string): Promise<FetchAnswer> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  }
  if (opts.orgId) headers["X-Org-Id"] = opts.orgId
  if (opts.environment) headers["X-Supatype-Environment"] = opts.environment

  const res = await fetch(url, {
    method: opts.method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) }
}

/** The error a refused request throws, naming an expired session when that is the reason. */
function refusal(result: FetchAnswer, url: string, opts: TargetFetchOptions): TargetApiError {
  const code = bodyString(result.json, "code")
  const message =
    bodyString(result.json, "message") ?? bodyString(result.json, "error") ?? `API error: ${result.status} ${url}`
  if (isAuthExpiry(result.status, code, message) && !opts.authRefresh) {
    return new TargetApiError(`${message}. Session expired, run: supatype login`, result.status, code)
  }
  return new TargetApiError(message, result.status, code, isJsonObject(result.json) ? result.json : undefined)
}

/**
 * A request to the control plane or a project's API. The answer is the body's `data` when it has
 * one, else the body. Without a guard it is `unknown`; with one, an answer the guard refuses throws.
 */
export async function targetFetch(
  baseUrl: string,
  apiPrefix: "/api/v1" | "/platform/v1",
  opts: TargetFetchOptions,
): Promise<unknown>
export async function targetFetch<T>(
  baseUrl: string,
  apiPrefix: "/api/v1" | "/platform/v1",
  opts: TargetFetchOptions,
  guard: Guard<T>,
): Promise<T>
export async function targetFetch(
  baseUrl: string,
  apiPrefix: "/api/v1" | "/platform/v1",
  opts: TargetFetchOptions,
  guard: Guard<unknown> = isUnknown,
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, "")}${apiPrefix}${opts.path}`
  let result = await fetchOnce(url, opts, opts.token)
  const reason = bodyString(result.json, "message") ?? bodyString(result.json, "error")
  if (!result.ok && opts.authRefresh && isAuthExpiry(result.status, bodyString(result.json, "code"), reason)) {
    result = await fetchOnce(url, opts, await refreshAccessToken(opts.authRefresh))
  }
  if (!result.ok) throw refusal(result, url, opts)

  const answer = isJsonObject(result.json) && result.json["data"] !== undefined ? result.json["data"] : result.json
  if (!guard(answer)) throw new Error(`Unexpected response from ${url} (HTTP ${result.status})`)
  return answer
}
