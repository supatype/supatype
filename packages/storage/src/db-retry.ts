/**
 * Wait for Postgres instead of exiting when it is not there yet.
 *
 * Storage used to `process.exit(1)` the moment `ensureSchema()` failed. In a Compose stack the `db`
 * healthcheck hid that: `depends_on: service_healthy` held the container back until Postgres
 * answered. Two things break the arrangement — a `database.external` stack, which has no `db`
 * container to wait on, and a database that restarts *after* boot, which no healthcheck ever
 * covered. Both looked the same from the outside: storage dead, one line in the log.
 *
 * A connection that cannot be established is retried indefinitely, because the operator's remedy is
 * to fix the database and the service should then recover on its own. Anything else — a syntax
 * error, a missing privilege — is fatal on the first attempt, since retrying it forever would bury
 * the one message that explains what is wrong.
 *
 * `packages/realtime/src/db-retry.ts` is the same logic for the same reason; a fix to the error
 * classification here belongs there too.
 */

/** Postgres and libpq error codes that mean "not reachable yet", not "wrong". */
const TRANSIENT_CODES = new Set([
  // Node/libuv socket failures.
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  // Postgres class 08 — connection exception.
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
  // The server is up but still starting, shutting down, or out of connections.
  "57P03",
  "57P01",
  "57P02",
  "53300",
])

const FIRST_DELAY_MS = 500
const MAX_DELAY_MS = 10_000

export function isTransientConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true

  // Some drivers surface a startup refusal only as a message. Narrow patterns only: matching
  // loosely here would turn a real misconfiguration into an infinite wait.
  const message = error instanceof Error ? error.message : String(error ?? "")
  return (
    /the database system is (starting up|shutting down|in recovery)/i.test(message) ||
    /connection terminated unexpectedly/i.test(message) ||
    /timeout expired/i.test(message)
  )
}

export interface RetryOptions {
  /** What is being attempted, for the log line. */
  label: string
  /**
   * Checked before each retry. Returning false stops the loop and rethrows the last error, so a
   * shutdown mid-retry does not leave a loop running against a service that is going away.
   */
  shouldContinue?: () => boolean
  log?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run `attempt` until it succeeds, retrying only transient connection failures.
 *
 * Every attempt is logged with the elapsed total, so a database that has been unreachable for ten
 * minutes reads as exactly that rather than as a service that has quietly stopped trying.
 */
export async function withDatabaseRetry<T>(
  attempt: () => Promise<T>,
  { label, shouldContinue = () => true, log = console.warn, sleep = defaultSleep }: RetryOptions,
): Promise<T> {
  const startedAt = Date.now()
  let delay = FIRST_DELAY_MS

  for (let tries = 1; ; tries++) {
    try {
      return await attempt()
    } catch (error) {
      if (!isTransientConnectionError(error)) throw error
      if (!shouldContinue()) throw error

      const waited = Math.round((Date.now() - startedAt) / 1000)
      const reason = error instanceof Error ? error.message : String(error)
      log(
        `[supatype] ${label}: database not reachable (attempt ${tries}, ${waited}s elapsed): ` +
          `${reason} — retrying in ${delay}ms`,
      )
      await sleep(delay)
      if (!shouldContinue()) throw error
      delay = Math.min(delay * 2, MAX_DELAY_MS)
    }
  }
}
