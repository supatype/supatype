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
 * retried, and the retry never removes anything. A change that would drop data and was not agreed
 * to leaves the database as it was, so `dev` says why and carries on watching. Every other refusal
 * (an image Docker could not pull, access changed outside Supatype, another push holding the
 * engine) is read as `push-refusal.ts` reads it on every path, and `dev` stops saying what to do.
 * Anything else is the engine's answer, and `dev` stops with it. Resetting the database is
 * `supatype dev --reset-db`, which is asked for, confirmed, and removes only Postgres's volume.
 */
import { classifyPushRefusal, DevPushDeclined, engineOutputOf, explainRefusal, type PushRefusal } from "./push-refusal.js"
import { DEV_DESTRUCTIVE_POLICY } from "./destructive-consent.js"
import { fatalError } from "./ui/fatal.js"
import type { DockerBrandOptions } from "./docker-runtime.js"

/**
 * How the initial push ended.
 *
 * A refusal is its own outcome rather than a thrown error so a caller can act on it: the
 * unmanaged-tables case is the one an adopt walkthrough will pick up. `refusal` is what refused
 * it, or null for any other answer from the engine. A destructive refusal is a change that would
 * drop data and was not agreed to: the database still matches the last schema, so dev carries on.
 * So does a push declined in a terminal (access changed outside Supatype, kept on a no).
 */
export type InitialPushOutcome =
  | { kind: "applied" }
  | { kind: "refused"; refusal: PushRefusal | null; message: string }
  | { kind: "declined"; message: string }
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

/** One failed push: everything it said, and what refused it, read once from the error itself. */
interface FailedPush {
  message: string
  refusal: PushRefusal | null
  /** A person was asked and said no: nothing to retry or diagnose. */
  declined: boolean
}

/** Run one push, returning how it failed instead of throwing. */
async function attemptPush(push: () => Promise<void>): Promise<FailedPush | null> {
  try {
    await push()
    return null
  } catch (err: unknown) {
    // With the engine's stdout, where it names a refusal.
    return { message: engineOutputOf(err), refusal: classifyPushRefusal(err), declined: err instanceof DevPushDeclined }
  }
}

/**
 * Whether to start Postgres and push again. Never for a refusal: it is long prose, and it must not
 * be retried because a word in it looks like a connection error. A registry that refused a
 * connection is an image pull, and starting Postgres again would not pull the image.
 */
function isTransient(failure: FailedPush): boolean {
  return failure.refusal === null && TRANSIENT_PATTERNS.some((pattern) => pattern.test(failure.message))
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
    message = failure.message
    if (failure.declined) return { kind: "declined", message }
    const refused = { kind: "refused" as const, refusal: failure.refusal, message }
    // Not a failure to diagnose: the person was told what would be lost and the database is as it was.
    if (failure.refusal?.kind === "destructive") return refused
    console.error(`[supatype] Initial schema push failed (attempt ${attempt}/${maxAttempts}):`, message)
    steps.dumpLogs(`schema push attempt ${attempt}/${maxAttempts}`)

    if (!isTransient(failure)) return refused
    if (attempt < maxAttempts) {
      await steps.recoverDatabase()
      await steps.sleep(3000 * attempt)
    }
  }
  return { kind: "exhausted", attempts: maxAttempts, message }
}

/** dev never drops data itself: `push` is where that is done on purpose. */
const DEV_REFUSAL_CONTEXT = { command: "supatype dev", applyDestructive: DEV_DESTRUCTIVE_POLICY.apply }

/** Every refusal ends with this, because the old loop taught people a failure meant data loss. */
const DATABASE_KEPT = "Your local database was left as it was."

/** End `dev` with what the engine said, and what to do about it. */
export function exitInitialPushFailed(failure: InitialPushFailure, brand?: DockerBrandOptions): never {
  const opts = { ...(brand !== undefined && { brand }) }
  if (failure.kind === "declined") fatalError(failure.message, [DATABASE_KEPT], opts)
  if (failure.kind === "exhausted") {
    fatalError(
      `Initial schema push failed after ${failure.attempts} attempts: ${failure.message}`,
      ["Postgres did not become reachable. Check logs: supatype self-host compose logs db", DATABASE_KEPT],
      opts,
    )
  }
  if (failure.refusal !== null) {
    const { headline, hints } = explainRefusal(failure.refusal, DEV_REFUSAL_CONTEXT)
    fatalError(headline, [...hints, DATABASE_KEPT], opts)
  }
  fatalError(
    "The engine refused the schema push.",
    [failure.message, "Fix the schema and run `supatype dev` again.", DATABASE_KEPT],
    opts,
  )
}
