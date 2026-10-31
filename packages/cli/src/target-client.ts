import { isJsonObject, isUnknown, type Guard } from "@supatype/shared"
import { readAuthAnswer } from "./auth-answer.js"
import { bodyReason, httpFailureText } from "./error-message.js"

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

/** One response: its status, its body as sent, and that body read as JSON (`{}` when it is not). */
interface FetchAnswer {
  ok: boolean
  status: number
  statusText: string
  text: string
  json: unknown
}

/** A body read as JSON, or `{}` when it is not JSON. */
function parsedBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** A string field of the body, for reading an error's `message`, `error` and `code`. */
function bodyString(json: unknown, key: string): string | undefined {
  const value = isJsonObject(json) ? json[key] : undefined
  return typeof value === "string" ? value : undefined
}

/** One request with `token`, its body unread. */
function send(url: string, opts: TargetFetchOptions, token: string): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  }
  if (opts.orgId) headers["X-Org-Id"] = opts.orgId
  if (opts.environment) headers["X-Supatype-Environment"] = opts.environment
  return fetch(url, {
    method: opts.method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
}

/** A response's status and body, read whole. */
async function answerOf(res: Response): Promise<FetchAnswer> {
  const text = await res.text().catch(() => "")
  return { ok: res.ok, status: res.status, statusText: res.statusText, text, json: parsedBody(text) }
}

/**
 * The accepted response to a request, its body unread. A session that expired is renewed once and
 * the request sent again, when the target can renew it; a refusal throws, saying why.
 */
async function acceptedResponse(url: string, opts: TargetFetchOptions): Promise<Response> {
  let res = await send(url, opts, opts.token)
  if (res.ok) return res
  let answer = await answerOf(res)
  if (opts.authRefresh && isAuthExpiry(answer.status, bodyString(answer.json, "code"), bodyReason(answer.json))) {
    res = await send(url, opts, await refreshAccessToken(opts.authRefresh))
    if (res.ok) return res
    answer = await answerOf(res)
  }
  throw refusal(answer, url, opts)
}

/**
 * The error a refused request throws, naming an expired session when that is the reason. It says
 * the status, then the body's message when it is JSON with one, else the body as sent, or that it
 * was empty: a plain-text or empty refusal used to show only `API error: 500 <url>`. The URL is
 * added when the body names no reason of its own, so an anonymous failure says where it came from.
 */
function refusal(result: FetchAnswer, url: string, opts: TargetFetchOptions): TargetApiError {
  const code = bodyString(result.json, "code")
  const said = httpFailureText(result.status, result.statusText, result.text)
  const message = bodyReason(result.json) === undefined ? `${said} (${url})` : said
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
  const result = await answerOf(await acceptedResponse(url, opts))
  const answer = isJsonObject(result.json) && result.json["data"] !== undefined ? result.json["data"] : result.json
  if (!guard(answer)) throw new Error(`Unexpected response from ${url} (HTTP ${result.status})`)
  return answer
}

/**
 * A request whose answer is a stream, such as a live log tail: the body as it arrives. The request
 * is made, renewed and refused as `targetFetch` does, so a refusal says the same things.
 */
export async function targetStream(
  baseUrl: string,
  apiPrefix: "/api/v1" | "/platform/v1" | "/admin/v1",
  opts: TargetFetchOptions,
): Promise<ReadableStream<Uint8Array>> {
  const url = `${baseUrl.replace(/\/$/, "")}${apiPrefix}${opts.path}`
  const res = await acceptedResponse(url, opts)
  if (res.body === null) throw new Error(`${url} answered with no body to stream`)
  return res.body
}
