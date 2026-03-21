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
}

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_TIMEOUT = 30000
const RETRY_DELAYS = [200, 1000, 3000]

/**
 * Fetch with automatic retry for transient errors and rate limit handling.
 *
 * Retries on:
 * - Network errors (connection refused, timeout, DNS)
 * - 5xx server errors
 *
 * Does NOT retry:
 * - 4xx client errors (except 429 which is handled specially)
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit & FetchOptions,
): Promise<Response> {
  const maxRetries = init?.retry === false ? 0 : (init?.maxRetries ?? DEFAULT_MAX_RETRIES)
  const timeout = init?.timeout ?? DEFAULT_TIMEOUT
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("Retry-After") || "5", 10)
        if (attempt < maxRetries) {
          await sleep(retryAfter * 1000)
          continue
        }
        throw new RateLimitError(retryAfter)
      }

      // Retry on 5xx server errors
      if (response.status >= 500 && attempt < maxRetries) {
        await sleep(RETRY_DELAYS[attempt] ?? 3000)
        continue
      }

      return response
    } catch (err) {
      if (err instanceof RateLimitError) throw err
      if (err instanceof SupatypeError) throw err

      lastError = err instanceof Error ? err : new Error(String(err))

      // Classify the error
      if (lastError.name === "AbortError") {
        throw new NetworkError(
          `Request timed out after ${timeout}ms`,
          NetworkErrorCodes.TIMEOUT,
        )
      }

      // Retry on network errors
      if (attempt < maxRetries) {
        await sleep(RETRY_DELAYS[attempt] ?? 3000)
        continue
      }

      // Classify and throw
      const message = lastError.message.toLowerCase()
      if (message.includes("econnrefused")) {
        throw new NetworkError(
          `Connection refused: ${url}`,
          NetworkErrorCodes.CONNECTION_REFUSED,
        )
      }
      if (message.includes("enotfound") || message.includes("dns")) {
        throw new NetworkError(
          `DNS lookup failed: ${url}`,
          NetworkErrorCodes.DNS_FAILURE,
        )
      }
      throw new NetworkError(lastError.message)
    }
  }

  throw new NetworkError(lastError?.message || "Request failed after retries")
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
  // Guard: `process` may not exist in browser/edge contexts. Access via
  // globalThis to avoid a TS error when lib doesn't include Node types.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  if (proc === undefined || proc.env === undefined) {
    return { detected: false, platform: null }
  }

  for (const entry of SERVERLESS_ENV_VARS) {
    const value = proc.env[entry.envVar]
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
