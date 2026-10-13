/**
 * Fetch wrapper with automatic retry, rate limit handling, and timeout.
 */

import { NetworkError, RateLimitError, SupatypeError, NetworkErrorCodes } from "./errors.js"

export interface FetchOptions {
  /** Maximum number of retries for transient errors. Default: 3. */
  maxRetries?: number | undefined
  /** Request timeout in milliseconds. Default: 30000. */
  timeout?: number | undefined
  /** Disable automatic retry. */
  retry?: boolean | undefined
  /**
   * Retry this request although its method is not GET or HEAD.
   *
   * Only GET and HEAD are retried by default. A POST, PUT, PATCH or DELETE that failed in flight may
   * still have been applied, and sending it again could apply it twice. Set this when the caller
   * knows repeating the request is harmless: a read sent as POST, or a write keyed so that a second
   * copy changes nothing.
   */
  idempotent?: boolean | undefined
}

/** How a request is sent: `fetch`, or the client's retrying fetch with its timeout. */
export type RequestTransport = (url: string, init: RequestInit & FetchOptions) => Promise<Response>

/** Plain `fetch`, for a client built without a transport. */
export const plainFetch: RequestTransport = (url, init) => fetch(url, init)

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_TIMEOUT = 30000
const RETRY_DELAYS = [200, 1000, 3000]
const SAFE_METHODS = new Set(["GET", "HEAD"])

/** Whether sending this request twice is harmless: GET, HEAD, or marked `idempotent`. */
function isRepeatable(init: (RequestInit & FetchOptions) | undefined): boolean {
  return SAFE_METHODS.has((init?.method ?? "GET").toUpperCase()) || init?.idempotent === true
}

/** How many times this request may be repeated: none unless it is safe to send twice. */
function allowedRetries(init: (RequestInit & FetchOptions) | undefined): number {
  if (init?.retry === false || !isRepeatable(init)) return 0
  return init?.maxRetries ?? DEFAULT_MAX_RETRIES
}

/** A failure that never produced a response, as the typed error callers branch on. */
function networkFailure(err: Error, url: string, timeout: number): NetworkError {
  if (err.name === "AbortError") {
    return new NetworkError(`Request timed out after ${timeout}ms`, NetworkErrorCodes.TIMEOUT)
  }
  const message = err.message.toLowerCase()
  if (message.includes("econnrefused")) {
    return new NetworkError(`Connection refused: ${url}`, NetworkErrorCodes.CONNECTION_REFUSED)
  }
  if (message.includes("enotfound") || message.includes("dns")) {
    return new NetworkError(`DNS lookup failed: ${url}`, NetworkErrorCodes.DNS_FAILURE)
  }
  return new NetworkError(err.message)
}

async function fetchWithTimeout(url: string, init: RequestInit | undefined, timeout: number): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Fetch with a timeout on every request, and retry for transient errors on requests safe to repeat.
 *
 * Retries GET and HEAD, and any request marked `idempotent`, on:
 * - network errors (connection refused, DNS), but never a timeout;
 * - 5xx server errors;
 * - 429, after its `Retry-After`, throwing `RateLimitError` once the retries run out.
 *
 * Does not retry 4xx client errors. Any other request (a POST, PUT, PATCH or DELETE not marked
 * `idempotent`) is sent once and its response returned as it came, a 429 included, so the caller
 * sees the server's own error rather than a `RateLimitError`.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit & FetchOptions,
): Promise<Response> {
  const maxRetries = allowedRetries(init)
  const timeout = init?.timeout ?? DEFAULT_TIMEOUT

  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < maxRetries
    let response: Response
    try {
      response = await fetchWithTimeout(url, init, timeout)
    } catch (err) {
      if (err instanceof SupatypeError) throw err
      const error = err instanceof Error ? err : new Error(String(err))
      if (error.name === "AbortError" || !canRetry) throw networkFailure(error, url, timeout)
      await sleep(RETRY_DELAYS[attempt] ?? 3000)
      continue
    }

    if (response.status === 429 && isRepeatable(init)) {
      const retryAfter = parseInt(response.headers.get("Retry-After") || "5", 10)
      if (!canRetry) throw new RateLimitError(retryAfter)
      await sleep(retryAfter * 1000)
      continue
    }
    if (response.status >= 500 && canRetry) {
      await sleep(RETRY_DELAYS[attempt] ?? 3000)
      continue
    }
    return response
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Serverless environment detection ────────────────────────────────────────

/**
 * Known serverless environment indicators keyed by platform name.
 * Each entry maps to an env-var check: either the var must exist (value `undefined`)
 * or it must equal the specified string.
 */
const SERVERLESS_ENV_VARS: ReadonlyArray<{ name: string; envVar: string; expected?: string }> = [
  { name: "Vercel",             envVar: "VERCEL",                     expected: "1"    },
  { name: "AWS Lambda",         envVar: "AWS_LAMBDA_FUNCTION_NAME"                     },
  { name: "Netlify",            envVar: "NETLIFY",                    expected: "true"  },
  { name: "Cloudflare Workers", envVar: "CF_PAGES"                                     },
  { name: "Google Cloud Functions", envVar: "FUNCTION_TARGET"                           },
  { name: "Azure Functions",    envVar: "FUNCTIONS_WORKER_RUNTIME"                     },
  { name: "Deno Deploy",        envVar: "DENO_DEPLOYMENT_ID"                           },
  { name: "Railway",            envVar: "RAILWAY_ENVIRONMENT"                          },
  { name: "Render",             envVar: "RENDER"                                       },
  { name: "Fly.io",             envVar: "FLY_APP_NAME"                                 },
]

export interface ServerlessDetectionResult {
  /** Whether a serverless environment was detected. */
  detected: boolean
  /** Name of the detected platform, or `null` when not detected. */
  platform: string | null
}

/**
 * Detect whether the SDK is running inside a known serverless environment by
 * inspecting well-known environment variables.
 *
 * Returns the platform name when detected so callers can include it in
 * diagnostics or warnings.
 */
export function detectServerlessEnvironment(): ServerlessDetectionResult {
  // Guard: `process` may not exist in browser/edge contexts.
  if (typeof process === "undefined" || process.env === undefined) {
    return { detected: false, platform: null }
  }

  for (const entry of SERVERLESS_ENV_VARS) {
    const value = process.env[entry.envVar]
    if (value === undefined) continue
    if (entry.expected === undefined || value === entry.expected) {
      return { detected: true, platform: entry.name }
    }
  }

  return { detected: false, platform: null }
}

const SERVERLESS_WARNING_ISSUED = { value: false }

/**
 * Log a one-time warning when the SDK detects a serverless environment **and**
 * the provided URL looks like a direct Postgres connection string rather than
 * the Supatype HTTP gateway.
 *
 * Direct database connections are problematic in serverless contexts because
 * each invocation may open a new TCP connection, quickly exhausting the
 * database's connection limit.
 *
 * The warning is emitted at most once per process to avoid log noise.
 */
export function warnIfServerlessDirectConnection(url: string): void {
  if (SERVERLESS_WARNING_ISSUED.value) return

  const { detected, platform } = detectServerlessEnvironment()
  if (!detected) return

  // Check if the URL resembles a direct Postgres connection string
  const lowerUrl = url.toLowerCase()
  const isDirectConnection =
    lowerUrl.startsWith("postgres://") ||
    lowerUrl.startsWith("postgresql://") ||
    // Port 5432 or 6543 (pgbouncer) on a bare hostname hints at direct PG access
    /:\d{4,5}\/\w/.test(url)

  if (!isDirectConnection) return

  SERVERLESS_WARNING_ISSUED.value = true

  const prefix = platform !== null ? `[Supatype] Serverless environment detected (${platform}). ` : "[Supatype] "
  console.warn(
    prefix +
    "Direct database connections are not recommended in serverless environments. " +
    "Use the Supatype client SDK instead."
  )
}
