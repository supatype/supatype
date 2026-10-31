import { isJsonObject, isUnknown, type Guard } from "@supatype/shared"
import { readAuthAnswer } from "./auth-answer.js"
import { fetchWithin } from "./fetch-within.js"
import { bodyReason, httpFailureText } from "./error-message.js"

export interface TargetFetchOptions {
  method: string
  path: string
  body?: unknown
  token: string
  orgId?: string | undefined
  environment?: string | undefined
  /**
   * Give up after this many milliseconds, with an error saying so. None when unset: a push can run
   * for minutes, and a stream ({@link targetStream}) until it is stopped. Both sends of a request
   * whose session is renewed share it; the renewal has its own limit.
   */
  timeoutMs?: number
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

/** How long renewing a Cloud session may take, apart from the request it was renewed for. */
const REFRESH_TIMEOUT_MS = 10_000

async function refreshAccessToken(
  authRefresh: NonNullable<TargetFetchOptions["authRefresh"]>,
): Promise<string> {
  const url = `${authRefresh.cloudApiUrl.replace(/\/$/, "")}/auth/refresh`
  let res: Response
  let body: unknown
  try {
    res = await fetchWithin(url, REFRESH_TIMEOUT_MS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: authRefresh.refreshToken }),
    })
    body = await res.json().catch((err: unknown) => {
      if (isTimeout(err)) throw err
      return {}
    })
  } catch (err) {
    if (!isTimeout(err)) throw err
    throw new Error(`Renewing the Cloud session: ${url} did not answer within ${REFRESH_TIMEOUT_MS / 1000} s. Run: supatype login`, { cause: err })
  }
  const answer = readAuthAnswer(body)
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

/** One request with `token`, its body unread, aborted by `signal` when one is given. */
function send(url: string, opts: TargetFetchOptions, token: string, signal: AbortSignal | undefined): Promise<Response> {
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
    ...(signal !== undefined ? { signal } : {}),
  })
}

/** Whether `err` is the abort of a request that ran out of time. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === "TimeoutError"
}

/** A response's status and body, read whole. */
async function answerOf(res: Response): Promise<FetchAnswer> {
  const text = await res.text().catch((err: unknown) => {
    if (isTimeout(err)) throw err
    return ""
  })
  return { ok: res.ok, status: res.status, statusText: res.statusText, text, json: parsedBody(text) }
}

/**
 * The accepted response to a request, its body unread. A session that expired is renewed once and
 * the request sent again, when the target can renew it; a refusal throws, saying why. The two sends
 * share `opts.timeoutMs`, the renewal timed apart, so a renewed request ends within that and the
 * renewal's own limit.
 */
async function acceptedResponse(url: string, opts: TargetFetchOptions, signal?: AbortSignal): Promise<Response> {
  const started = Date.now()
  let res = await send(url, opts, opts.token, signal ?? budgetSignal(opts.timeoutMs))
  if (res.ok) return res
  let answer = await answerOf(res)
  if (opts.authRefresh && isAuthExpiry(answer.status, bodyString(answer.json, "code"), bodyReason(answer.json))) {
    const spent = Date.now() - started
    const token = await refreshAccessToken(opts.authRefresh)
    res = await send(url, opts, token, signal ?? budgetSignal(opts.timeoutMs === undefined ? undefined : opts.timeoutMs - spent))
    if (res.ok) return res
    answer = await answerOf(res)
  }
  throw refusal(answer, url, opts)
}

/** A signal that aborts after `ms` (at least 1), or none without a limit. */
function budgetSignal(ms: number | undefined): AbortSignal | undefined {
  return ms === undefined ? undefined : AbortSignal.timeout(Math.max(ms, 1))
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
  const result = await timedAnswer(url, opts)
  const answer = isJsonObject(result.json) && result.json["data"] !== undefined ? result.json["data"] : result.json
  if (!guard(answer)) throw new Error(`Unexpected response from ${url} (HTTP ${result.status})`)
  return answer
}

/** The whole answer to a request, within `opts.timeoutMs` when it is set. */
async function timedAnswer(url: string, opts: TargetFetchOptions): Promise<FetchAnswer> {
  try {
    return await answerOf(await acceptedResponse(url, opts))
  } catch (err) {
    if (!isTimeout(err) || opts.timeoutMs === undefined) throw err
    throw new Error(`${opts.method} ${url} did not answer within ${opts.timeoutMs / 1000} s`, { cause: err })
  }
}

/**
 * A request whose answer is a stream, such as a live log tail: the body as it arrives. The request
 * is made, renewed and refused as `targetFetch` does, so a refusal says the same things. Its
 * `timeoutMs` covers the wait for the answer to start, never the body, which runs until stopped.
 */
export async function targetStream(
  baseUrl: string,
  apiPrefix: "/api/v1" | "/platform/v1" | "/admin/v1",
  opts: TargetFetchOptions,
): Promise<ReadableStream<Uint8Array>> {
  const url = `${baseUrl.replace(/\/$/, "")}${apiPrefix}${opts.path}`
  const res = await streamStart(url, opts)
  if (res.body === null) throw new Error(`${url} answered with no body to stream`)
  return res.body
}

/**
 * The accepted response to a stream's request, within `opts.timeoutMs` when it is set. Its own
 * controller, not a timeout signal, so nothing aborts the body once the answer has started.
 */
async function streamStart(url: string, opts: TargetFetchOptions): Promise<Response> {
  const limit = opts.timeoutMs
  if (limit === undefined) return acceptedResponse(url, opts)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), limit)
  try {
    return await acceptedResponse(url, opts, controller.signal)
  } catch (err) {
    if (!isTimeout(err)) throw err
    throw new Error(`${opts.method} ${url} did not answer within ${limit / 1000} s`, { cause: err })
  } finally {
    clearTimeout(timer)
  }
}
