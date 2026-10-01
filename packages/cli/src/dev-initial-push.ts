/**
 * The first schema push of `supatype dev`, and what a failed one is allowed to do.
 *
 * This loop used to answer every failure the same way: `docker compose down -v`, start Postgres
 * again, push again. `-v` removes every volume in the stack, so a push the engine refused on
 * purpose (a table Supatype does not manage, a destructive change) cost the developer their local
 * database and their uploaded files, and the second attempt then succeeded against an empty one.
 * A refusal is deterministic. The same schema against the same database is refused again, and the
 * only thing a reset changed was that there was no longer anything to refuse.
 *
 * So a failure is classified before anything else happens. A database that is not reachable yet is
 * retried, and the retry never removes anything. Everything else is the engine's answer, and `dev`
 * stops with it. Resetting the database is `supatype dev --reset-db`, which is asked for, confirmed,
 * and removes only Postgres's volume.
 */
import { unmanagedTables } from "./adopt-walkthrough.js"
import { fatalError } from "./ui/fatal.js"
import type { DockerBrandOptions } from "./docker-runtime.js"

/** What one failed push means for the next step. */
export type PushFailureKind = "transient" | "unmanaged-tables" | "engine"

/**
 * How the initial push ended.
 *
 * A refusal is its own outcome rather than a thrown error so a caller can act on it: the
 * unmanaged-tables case is the one an adopt walkthrough will pick up.
 */
export type InitialPushOutcome =
  | { kind: "applied" }
  | { kind: "refused"; reason: Exclude<PushFailureKind, "transient">; message: string }
  | { kind: "exhausted"; attempts: number; message: string }

export type InitialPushFailure = Exclude<InitialPushOutcome, { kind: "applied" }>

export interface InitialPushSteps {
  /** One push. Throws with the engine's output when it fails. */
  push: () => Promise<void>
  /** Start Postgres if it is not running and wait for it. Must never remove anything. */
  recoverDatabase: () => Promise<void>
  /** Capture the database logs while they still describe the failure. */
  dumpLogs: (reason: string) => void
  sleep: (ms: number) => Promise<void>
}

/**
 * Output that means "Postgres is not reachable yet", not "the schema is wrong".
 *
 * The same vocabulary as `packages/realtime/src/db-retry.ts` and its storage twin, which match a
 * driver's error codes. The engine reports through its exit output rather than an error object, so
 * here the codes and their messages are matched as text. Narrow on purpose: whatever matches is
 * retried, and a loose pattern would turn a refusal back into the retry that hid it.
 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN)\b/,
  /connection (refused|reset)/i,
  /connection terminated unexpectedly/i,
  /the database system is (starting up|shutting down|in recovery)/i,
  /too many clients already/i,
  /timeout expired|timed out/i,
]

function classifyPushFailure(message: string): PushFailureKind {
  // Checked first: the refusal is long prose, and it must not be retried because a word in it
  // happens to look like a connection error. Read from the engine's JSON reason, with its wording
  // only as the fallback for an engine that predates the JSON.
  if (unmanagedTables(message) !== null) return "unmanaged-tables"
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) return "transient"
  return "engine"
}

/** Run one push, returning the failure message instead of throwing it. */
async function attemptPush(push: () => Promise<void>): Promise<string | null> {
  try {
    await push()
    return null
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** Push the schema, retrying only while Postgres is unreachable. */
export async function pushInitialSchema(
  steps: InitialPushSteps,
  maxAttempts = 3,
): Promise<InitialPushOutcome> {
  let message = ""
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const failure = await attemptPush(steps.push)
    if (failure === null) return { kind: "applied" }
    message = failure
    console.error(`[supatype] Initial schema push failed (attempt ${attempt}/${maxAttempts}):`, failure)
    steps.dumpLogs(`schema push attempt ${attempt}/${maxAttempts}`)

    const kind = classifyPushFailure(failure)
    if (kind !== "transient") return { kind: "refused", reason: kind, message }
    if (attempt < maxAttempts) {
      await steps.recoverDatabase()
      await steps.sleep(3000 * attempt)
    }
  }
  return { kind: "exhausted", attempts: maxAttempts, message }
}

/** Every refusal ends with this, because the old loop taught people a failure meant data loss. */
const DATABASE_KEPT = "Your local database was left as it was."

/** End `dev` with what the engine said, and what to do about it. */
export function exitInitialPushFailed(failure: InitialPushFailure, brand?: DockerBrandOptions): never {
  const opts = { ...(brand !== undefined && { brand }) }
  if (failure.kind === "exhausted") {
    fatalError(
      `Initial schema push failed after ${failure.attempts} attempts: ${failure.message}`,
      ["Postgres did not become reachable. Check logs: supatype self-host compose logs db", DATABASE_KEPT],
      opts,
    )
  }
  if (failure.reason === "unmanaged-tables") {
    fatalError(
      "The engine refused the schema push. Nothing was applied.",
      [
        failure.message,
        "Run `supatype adopt` to bring those tables under management, then run `supatype dev` again.",
        DATABASE_KEPT,
      ],
      opts,
    )
  }
  fatalError(
    "The engine refused the schema push.",
    [failure.message, "Fix the schema and run `supatype dev` again.", DATABASE_KEPT],
    opts,
  )
}
