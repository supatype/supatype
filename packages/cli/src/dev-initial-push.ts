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
 * retried, and the retry never removes anything. Any answer from the engine (a change that would
 * drop data, access changed outside Supatype, tables it does not manage, another push holding it,
 * or a schema it could not apply) leaves the database as it was, and the engine records the
 * refusal for Studio to show. So `dev` brings the stack up on the schema the database already has,
 * says what refused the push and what resolves it, and keeps watching: the save that fixes it is
 * pushed like any other. It used to stop instead, which took the whole stack down over a hand edit
 * to one policy.
 *
 * `dev` still stops when there is nothing to run on: Postgres never answered, or Docker could not
 * pull the image the engine runs in, so the engine never ran, recorded nothing, and no save can
 * change that. Resetting the database is `supatype dev --reset-db`, which is asked for, confirmed,
 * and removes only Postgres's volume.
 */
import {
  classifyPushRefusal,
  DEV_REFUSAL_CONTEXT,
  DevPushDeclined,
  engineOutputOf,
  explainRefusal,
  type PushRefusal,
  type RefusalExplanation,
} from "./push-refusal.js"
import { fatalError } from "./ui/fatal.js"
import type { DockerBrandOptions } from "./docker-runtime.js"

/**
 * How the initial push ended.
 *
 * A refusal is its own outcome rather than a thrown error so a caller can act on it: the
 * unmanaged-tables case is the one an adopt walkthrough will pick up. `refusal` is what refused
 * it, or null for any other answer from the engine. `declined` is a push a person said no to in a
 * terminal (access changed outside Supatype, kept).
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
    // Not a failure to diagnose from the database's logs: it is explained once dev settles it.
    if (failure.refusal !== null) return refused
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

/** Every refusal ends with this, because the old loop taught people a failure meant data loss. */
const DATABASE_KEPT = "Your local database was left as it was."

/**
 * What dev does once its first push has ended. True when the push applied; false when it was not
 * applied and dev carries on, having said why and what resolves it. Ends dev (after `beforeExit`)
 * when there is nothing to run on.
 */
export function settleInitialPush(
  outcome: InitialPushOutcome,
  opts: { brand?: DockerBrandOptions; beforeExit: () => void },
): boolean {
  if (outcome.kind === "applied") return true
  const stop = stopReason(outcome)
  if (stop === null) {
    for (const line of notAppliedLines(explainNotApplied(outcome))) console.warn(line)
    return false
  }
  opts.beforeExit()
  fatalError(stop.headline, [...stop.hints, DATABASE_KEPT], { ...(opts.brand !== undefined && { brand: opts.brand }) })
}

/**
 * Why dev cannot come up, or null when it can. Postgres never answering leaves nothing to run on.
 * An image Docker could not pull means the engine never ran: it recorded nothing for Studio to
 * show, and no save in this session changes the registry, so dev stops and says to run it again.
 */
function stopReason(failure: InitialPushFailure): RefusalExplanation | null {
  if (failure.kind === "exhausted") {
    return {
      headline: `Initial schema push failed after ${failure.attempts} attempts: ${failure.message}`,
      hints: ["Postgres did not become reachable. Check logs: supatype self-host compose logs db"],
    }
  }
  if (failure.kind === "refused" && failure.refusal?.kind === "image-pull") {
    return explainRefusal(failure.refusal, { command: "supatype dev" })
  }
  return null
}

/**
 * What refused a first push dev carries on from. A destructive refusal and a no already carry
 * their own advice (`supatype push --yes`, the rebaseline), and an answer the CLI cannot name is
 * the engine's own words.
 */
function explainNotApplied(failure: InitialPushFailure): RefusalExplanation {
  if (failure.kind !== "refused") return { headline: failure.message, hints: [] }
  if (failure.refusal === null) return { headline: failure.message, hints: ["Save the schema to push it again."] }
  if (failure.refusal.kind === "destructive") return { headline: failure.message, hints: [] }
  return explainRefusal(failure.refusal, DEV_REFUSAL_CONTEXT)
}

function notAppliedLines({ headline, hints }: RefusalExplanation): string[] {
  return [
    `[supatype] Initial schema push not applied: ${headline}`,
    ...hints.map((hint) => hint.replace(/^/gm, "  ")),
    `[supatype] ${DATABASE_KEPT} dev is running on the schema the database already has, and still watching.`,
  ]
}
