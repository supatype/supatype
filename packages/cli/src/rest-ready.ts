/**
 * Waiting, after a push, for the stack's REST API to answer.
 *
 * PostgREST 14 refuses to serve while it cannot build its schema cache, and it cannot while a schema
 * it is configured to expose (`draft`, `api`, `supatype`, a custom one) does not exist yet. A fresh
 * self-host stack therefore answers 503 (PGRST002) on every REST request until the first push
 * creates them, and after that push PostgREST only notices on its next retry, which backs off to
 * about 32 s. A push that reported success while REST still answered 503 sent people looking for a
 * fault that was only a wait (PU1). So the push waits, bounded, for REST to stop answering 503.
 */

import { setTimeout as sleep } from "node:timers/promises"

/** About 32 s of PostgREST backoff, plus room for the request that follows it. */
export const REST_READY_WITHIN_MS = 40_000

const POLL_MS = 1_000
const REQUEST_TIMEOUT_MS = 2_000

/** What the wait needs from the outside world, so a test can stand in for each. */
export interface RestReadyDeps {
  /** The HTTP status `url` answers with; throws when nothing answers at all. */
  fetchStatus: (url: string, headers: Record<string, string>) => Promise<number>
  sleep: (ms: number) => Promise<void>
  now: () => number
  log: (line: string) => void
}

const liveDeps: RestReadyDeps = {
  fetchStatus: async (url, headers) =>
    (await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).status,
  sleep: (ms) => sleep(ms),
  now: () => Date.now(),
  log: (line) => console.log(line),
}

/** True when REST is still on its way up: a 503, or no answer at all. */
async function restStillLoading(url: string, headers: Record<string, string>, deps: RestReadyDeps): Promise<boolean> {
  try {
    return (await deps.fetchStatus(url, headers)) === 503
  } catch {
    return true
  }
}

/**
 * Wait until `baseUrl`'s `/rest/v1/` stops answering 503, for at most `withinMs`. Says nothing
 * when REST already answers, one line while it waits, and what to do if it never does. Only 503 is
 * waited on: any other answer is REST's own and belongs to whoever asked. Never fails the push,
 * which has already been applied; true when REST answered in time.
 */
export async function waitForRestReady(
  baseUrl: string,
  anonKey: string | undefined,
  deps: RestReadyDeps = liveDeps,
  withinMs: number = REST_READY_WITHIN_MS,
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/+$/, "")}/rest/v1/`
  const headers: Record<string, string> = anonKey ? { apikey: anonKey } : {}
  if (!(await restStillLoading(url, headers, deps))) return true
  deps.log("[supatype] Waiting for the REST API to load the new schema (PostgREST answers 503 until it does)...")
  const deadline = deps.now() + withinMs
  while (deps.now() < deadline) {
    await deps.sleep(POLL_MS)
    if (!(await restStillLoading(url, headers, deps))) return true
  }
  deps.log(
    `[supatype] The REST API at ${url} still answered 503 after ${Math.round(withinMs / 1000)} s. ` +
      "The schema is applied; PostgREST retries on its own and should catch up. If it does not, " +
      "see `supatype self-host compose logs --service postgrest`.",
  )
  return false
}
