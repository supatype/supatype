/**
 * The request and answers of a remote seed: `supatype seed` against a linked Cloud project or a
 * linked self-hosted server. Both control planes serve the same routes from this one shape, so a
 * seed behaves the same on either.
 *
 * `POST /projects/:ref/seed` takes {@link RemoteSeedRequest} and answers {@link RemoteSeedApplied}.
 * `GET /projects/:ref/seed/status` answers {@link RemoteSeedStatus}. Both read the target
 * environment from the `X-Supatype-Environment` header, as every other project route does.
 */

/** The capability feature a control plane lists when it serves the seed routes. */
export const REMOTE_SEED_FEATURE = "seed"

/** Default caps on one request. A control plane may raise them per project. */
export const REMOTE_SEED_MAX_BODY_BYTES = 10 * 1024 * 1024
export const REMOTE_SEED_MAX_FILES = 100

/** What the CLI sends to apply seeds. */
export interface RemoteSeedRequest {
  /** The schema AST, as push sends it. */
  readonly ast: unknown
  /**
   * Each seed file's collected document, as the exact JSON text the CLI made, with its `file` key.
   * Strings rather than objects: the engine's run-once ledger hashes this text, and parsing and
   * re-serialising it on the server would change the hash.
   */
  readonly irDocuments: readonly string[]
  readonly atomic: boolean
  readonly runOnce: boolean
  /**
   * The name a seed's `environment` condition reads. Absent means the target environment's
   * name. A value that differs from the target is refused.
   */
  readonly environment?: string
  /** Must be true when the target is production. The server checks it, not only the CLI. */
  readonly confirmProduction: boolean
  /** Where the request came from, as push's audit fields give it. */
  readonly pushedFrom?: string
}

/** The answer when the engine ran, whether or not the seed applied. */
export interface RemoteSeedApplied {
  /** The engine's seed result document, unchanged. */
  readonly data: unknown
  readonly run: { readonly id: string }
}

/** The answer to a status request. */
export interface RemoteSeedStatus {
  /** The engine's seed status document, unchanged. */
  readonly data: unknown
}

/** The `error` codes a remote seed refusal carries, beside a human `message`. */
export const REMOTE_SEED_REFUSALS = [
  "validation_error",
  "environment_mismatch",
  "production_confirmation_required",
  "seed_busy",
  "schema_not_pushed",
  "payload_too_large",
  "seed_too_large_for_plan",
  "server_busy",
] as const

export type RemoteSeedRefusal = (typeof REMOTE_SEED_REFUSALS)[number]

/** Whether `value` is one of the refusal codes. */
export function isRemoteSeedRefusal(value: unknown): value is RemoteSeedRefusal {
  return REMOTE_SEED_REFUSALS.some((code) => code === value)
}

/** A seed the plan cannot run: the plan, the seed's size, and the most that plan takes. */
export interface RemoteSeedPlanLimit {
  readonly plan: string
  readonly seedBytes: number
  readonly maxBytes: number
  /** True for a staging or preview seed, which is sized and capped as Free whatever the project's plan. */
  readonly nonProduction?: boolean
}

/** A size as whole megabytes, rounded up so a limit is never shown as less than it is over. */
const megabytes = (bytes: number): string => `${Math.max(1, Math.ceil(bytes / (1024 * 1024)))} MB`

/** What a request over a cap names: the byte size, or the file count. */
export type RemoteSeedLimit = { readonly maxBytes: number } | { readonly maxFiles: number }

/**
 * The words of every refusal whose text does not depend on what the request said. Both control
 * planes build their refusal from this table, so the same refusal reads the same on either host.
 * `validation_error` is not here: its text is whatever the body check found wrong.
 */
export const REMOTE_SEED_MESSAGES = {
  environment_mismatch: (said: { readonly requested: string; readonly target: string }): string =>
    `The seed's environment condition is "${said.requested}" but the target is "${said.target}". ` +
    `Seed with --env ${said.requested}, or drop --environment.`,
  production_confirmation_required: (): string =>
    "This seed targets production. Confirm it (supatype seed --confirm-production) and send it again.",
  seed_busy: (): string => "Another seed is already running on this environment. Wait for it to finish.",
  schema_not_pushed: (said: { readonly environment: string; readonly changes: number }): string =>
    `The ${said.environment} database does not have the schema in this seed yet (${said.changes} change(s) to push). ` +
    `Run \`supatype push --env ${said.environment}\` first.`,
  payload_too_large: (said: RemoteSeedLimit): string =>
    "maxBytes" in said
      ? `A seed request may be at most ${said.maxBytes} bytes.`
      : `At most ${said.maxFiles} seed files can be sent at once.`,
  seed_too_large_for_plan: (said: RemoteSeedPlanLimit): string =>
    said.nonProduction === true
      ? `This seed is ${megabytes(said.seedBytes)}. Staging and preview environments run at Free size on every plan and take seeds up to ${megabytes(said.maxBytes)}, ` +
        "so no plan raises that. Split it into smaller seed files and seed them one after another, or seed production."
      : `This seed is ${megabytes(said.seedBytes)}, more than the ${said.plan} plan can run at once (up to ${megabytes(said.maxBytes)}). ` +
        "Split it into smaller seed files and seed them one after another, or move to a larger plan.",
  server_busy: (): string =>
    "The server is taking as many seed uploads as it can right now. Wait a moment and send the seed again.",
} as const

/** A refusal as the CLI prints it: its code in brackets, then its message. */
export function formatRemoteSeedRefusal(code: RemoteSeedRefusal, message: string): string {
  return `[${code}] ${message}`
}

/** A refusal body: 400, 409, 413 or 503, with no engine run. */
export interface RemoteSeedRefused {
  readonly error: RemoteSeedRefusal
  readonly message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Checks a parsed request body. Answers the request, or a message naming what is wrong, so both
 * control planes refuse a bad body with the same words.
 */
export function parseRemoteSeedRequest(body: unknown): RemoteSeedRequest | { readonly invalid: string } {
  if (!isRecord(body)) return { invalid: "The body must be a JSON object." }
  const { ast, irDocuments, atomic, runOnce, environment, confirmProduction, pushedFrom } = body
  if (ast === undefined || ast === null) return { invalid: "`ast` is required." }
  if (!Array.isArray(irDocuments) || irDocuments.length === 0) {
    return { invalid: "`irDocuments` must be a non-empty array of strings." }
  }
  if (!irDocuments.every((doc): doc is string => typeof doc === "string")) {
    return { invalid: "Every entry of `irDocuments` must be a string." }
  }
  if (irDocuments.length > REMOTE_SEED_MAX_FILES) {
    return { invalid: `At most ${REMOTE_SEED_MAX_FILES} seed files can be sent at once.` }
  }
  if (typeof atomic !== "boolean" || typeof runOnce !== "boolean" || typeof confirmProduction !== "boolean") {
    return { invalid: "`atomic`, `runOnce` and `confirmProduction` must be booleans." }
  }
  if (environment !== undefined && (typeof environment !== "string" || environment.trim() === "")) {
    return { invalid: "`environment` must be a non-empty string when given." }
  }
  if (pushedFrom !== undefined && typeof pushedFrom !== "string") {
    return { invalid: "`pushedFrom` must be a string when given." }
  }
  return {
    ast,
    irDocuments,
    atomic,
    runOnce,
    confirmProduction,
    ...(environment !== undefined && { environment }),
    ...(pushedFrom !== undefined && { pushedFrom }),
  }
}
