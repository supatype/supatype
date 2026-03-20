/**
 * Retry configuration module.
 *
 * Re-exports the core fetchWithRetry and provides a factory that binds
 * client-level retry/timeout options so callers don't repeat them.
 */

import { fetchWithRetry, type FetchOptions } from "./fetch-with-retry.js"

export type { FetchOptions } from "./fetch-with-retry.js"

export interface RetryConfig {
  /** Disable automatic retry. When false, no retries are attempted. */
  retry?: boolean | undefined
  /** Request timeout in milliseconds. Default: 30000. */
  timeout?: number | undefined
}

/**
 * Create a fetch function pre-configured with client-level retry/timeout.
 *
 * ```ts
 * const doFetch = createRetryFetch({ retry: true, timeout: 10000 })
 * const res = await doFetch('https://api.example.com/data', { method: 'GET' })
 * ```
 */
export function createRetryFetch(config: RetryConfig) {
  return (url: string, init?: RequestInit & Partial<FetchOptions>): Promise<Response> => {
    return fetchWithRetry(url, {
      ...init,
      retry: init?.retry ?? config.retry,
      timeout: init?.timeout ?? config.timeout,
    })
  }
}
