/**
 * Why a push was refused, read the same way on every path that pushes, and what to do about it.
 *
 * A push reaches the engine five ways: dev's first push, a dev hot reload, `supatype push` through
 * Docker, a linked or self-hosted control plane, and the engine binary on a direct target. Each
 * used to read the engine's answer for itself, so a refusal one path explained came out of another
 * as raw JSON and an error line (C02, C07, C14 in the pre-launch verification): a busy engine was
 * "the engine refused the schema push, fix the schema", and an image Docker could not pull was the
 * daemon's sentence. Here it is read once.
 *
 * By code first: the engine binary prints `{"status":"refused","reason":...}` on stdout, and a
 * server answers 409 with the same `reason` and what it names. By wording second, for an engine or
 * a server from before the code, and for what is not the engine's at all (Docker's own errors).
 */
import { ENGINE_BUSY, ENGINE_BUSY_WORDING } from "@supatype/shared"
import { EngineError } from "./engine-client.js"
import { TargetApiError } from "./target-client.js"
import { formatDriftedObjects, SECURITY_DRIFT, type DriftedObject } from "./diff-output.js"
import { findJsonLine, type JsonObject } from "./engine-json-line.js"
import { fatalError } from "./ui/fatal.js"

/** The `reason` the engine gives a push that declares tables Supatype does not manage. */
const UNMANAGED_MODEL_TABLES = "unmanaged_model_tables"

/** An engine older than the JSON refusal says this and nothing machine-readable. */
const LEGACY_UNMANAGED_WORDING = /declares model\(s\) for table\(s\) Supatype does not manage: ([^\n]+?)\.(?:\n|$)/i

/** The engine's refusal of an unforced push that would drop something, as it words it. */
const DESTRUCTIVE_WORDING = /(\d+) destructive operation\(s\) detected/i

/** The engine's sentence for a security-drift refusal, for a server that sent no objects. */
const SECURITY_DRIFT_WORDING = /decide who may read or write were changed outside Supatype/i

/**
 * The `reason` the engine gives a rebaseline it refused because the drift is no longer what its
 * preview showed: something drifted since, or was put back (C04). Nothing was recorded.
 */
const DRIFT_CHANGED = "drift_changed"

/** The engine's sentence for that refusal, for a server that passed on neither its code nor its lists. */
const DRIFT_CHANGED_WORDING = /the drift changed after the preview/i

/**
 * Docker could not pull an image the push runs in, so the engine never ran. Daemon wording, as
 * Docker and compose print it: the Docker Hub rate limit (its `toomanyrequests` code and the 429 a
 * resolve reports), a repository or tag that does not exist, and a registry it could not reach.
 */
const IMAGE_PULL_WORDING: readonly RegExp[] = [
  /\btoomanyrequests\b/i,
  /pull rate limit/i,
  /pull access denied/i,
  /manifest unknown/i,
  /no matching manifest/i,
  /failed to resolve reference/i,
  /error pulling image/i,
  /Error response from daemon: Get "?https?:\/\/[^\s"]+\/v2\//,
]

/** Docker Hub's pull rate limit, which `docker login` raises. */
const RATE_LIMITED = /\btoomanyrequests\b|pull rate limit|\b429\b/i

/** The image a pull failure names: quoted by a resolve, after "for" by a denied pull or a manifest. */
const PULLED_IMAGE = /"([\w.-]+(?::\d+)?\/[\w./-]+(?::[\w.-]+)?(?:@sha256:[0-9a-f]+)?)"|\b(?:for|pull) ([\w.-]+\/[\w./-]+(?::[\w.-]+)?)/i

export type PushRefusal =
  | { kind: "unmanaged-tables"; tables: string[] }
  | { kind: "destructive"; count: number }
  | { kind: "security-drift"; objects: DriftedObject[] }
  | { kind: "engine-busy" }
  | { kind: "image-pull"; image: string | undefined; rateLimited: boolean; detail: string }
  /** A rebaseline's drift moved after its preview: `unseen` is new since, `gone` was put back. */
  | { kind: "drift-changed"; unseen: string[]; gone: string[] }

export type PushRefusalKind = PushRefusal["kind"]

/**
 * Everything a failed push said, wherever it ran: the engine's stdout carries its JSON refusal, and
 * a server's error body carries the same fields.
 */
export function engineOutputOf(err: unknown): string {
  if (err instanceof EngineError) return `${err.message}\n${err.stdout}`
  if (err instanceof TargetApiError && err.details !== undefined) return `${err.message}\n${JSON.stringify(err.details)}`
  return err instanceof Error ? err.message : String(err)
}

/** What refused the push, or null when the failure is not a refusal the CLI knows. */
export function classifyPushRefusal(err: unknown): PushRefusal | null {
  // A server says it is busy with a 409. Its sentence in any other answer (a 500 that echoes it, a
  // proxy's page) is not the engine refusing, and "try again" would be the wrong advice.
  const busyWording = !(err instanceof TargetApiError) || err.status === 409
  return classifyRefusalOutput(engineOutputOf(err), refusalCodeOf(err), busyWording)
}

/** The same reading, of what a push printed and the code it came with, if any. */
export function classifyRefusalOutput(output: string, code?: string, busyWording = true): PushRefusal | null {
  const line = findJsonLine(output, (value) => typeof value["reason"] === "string")
  return byCode(code ?? (line?.["reason"] as string | undefined), line) ?? byWording(output, busyWording)
}

/** The tables an unmanaged-tables refusal names, or null when `output` is not that refusal. */
export function unmanagedTables(output: string): string[] | null {
  const refusal = classifyRefusalOutput(output)
  return refusal?.kind === "unmanaged-tables" ? refusal.tables : null
}

/** How many destructive operations the engine refused, or null when `output` is not that refusal. */
export function destructiveRefusal(output: string): number | null {
  const match = DESTRUCTIVE_WORDING.exec(output)
  return match?.[1] === undefined ? null : Number(match[1])
}

/**
 * The engine's refusal of an unforced push that would rewrite a large table, stopping its reads
 * and writes while it runs (IN-C 3), as it words it.
 */
const REWRITE_WORDING = /(\d+) operation\(s\) rewrite a large table/i

/** A refused push a person can consent to, and what consenting to it means. */
export interface ConsentRefusal {
  /** `destructive`: data is dropped. `rewrite`: a large table is locked while it is rewritten. */
  kind: "destructive" | "rewrite"
  count: number
}

/**
 * A refusal `push --yes` (or a yes in a terminal) applies anyway: a destructive change, or a
 * rewrite of a large table. Null for any other output. A push refused for both is named for the
 * data it drops, which the engine checks first.
 */
export function consentRefusal(output: string): ConsentRefusal | null {
  const destructive = destructiveRefusal(output)
  if (destructive !== null) return { kind: "destructive", count: destructive }
  const match = REWRITE_WORDING.exec(output)
  return match?.[1] === undefined ? null : { kind: "rewrite", count: Number(match[1]) }
}

function refusalCodeOf(err: unknown): string | undefined {
  if (err instanceof EngineError) return err.reason
  if (err instanceof TargetApiError && err.status === 409) return err.code
  return undefined
}

function byCode(code: string | undefined, line: JsonObject | undefined): PushRefusal | null {
  switch (code) {
    case UNMANAGED_MODEL_TABLES:
      return { kind: "unmanaged-tables", tables: stringsOf(line?.["tables"]) }
    case SECURITY_DRIFT:
      return { kind: "security-drift", objects: listOf<DriftedObject>(line?.["objects"]) }
    case ENGINE_BUSY:
      return { kind: "engine-busy" }
    case DRIFT_CHANGED:
      return { kind: "drift-changed", unseen: stringsOf(line?.["unseen"]), gone: stringsOf(line?.["gone"]) }
    default:
      return null
  }
}

function listOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function stringsOf(value: unknown): string[] {
  return listOf<unknown>(value).filter((v): v is string => typeof v === "string")
}

function byWording(output: string, busyWording: boolean): PushRefusal | null {
  const legacy = LEGACY_UNMANAGED_WORDING.exec(output)
  if (legacy?.[1] !== undefined) {
    return { kind: "unmanaged-tables", tables: legacy[1].split(",").map((t) => t.trim()).filter((t) => t !== "") }
  }
  const count = destructiveRefusal(output)
  if (count !== null) return { kind: "destructive", count }
  if (SECURITY_DRIFT_WORDING.test(output)) return { kind: "security-drift", objects: [] }
  if (DRIFT_CHANGED_WORDING.test(output)) return { kind: "drift-changed", unseen: [], gone: [] }
  if (busyWording && ENGINE_BUSY_WORDING.test(output)) return { kind: "engine-busy" }
  return imagePull(output)
}

/** An image-pull refusal from the first line Docker's wording matches, or null when none does. */
function imagePull(output: string): PushRefusal | null {
  const detail = output.split(/\r?\n/).find((l) => IMAGE_PULL_WORDING.some((p) => p.test(l)))?.trim()
  if (detail === undefined) return null
  const match = PULLED_IMAGE.exec(output)
  return { kind: "image-pull", image: match?.[1] ?? match?.[2], rateLimited: RATE_LIMITED.test(output), detail }
}

/** A refusal said for a person: one line, and what to do about it. */
export interface RefusalExplanation {
  headline: string
  hints: string[]
}

/** Who is explaining a refusal, so the advice names what they would run. */
export interface RefusalContext {
  /** The command that pushed: `supatype dev`, `supatype push`. */
  command: string
  /** How to try again; a dev hot reload's is saving the schema. Default: run the command again. */
  retry?: string
  /** What applies a destructive change on purpose. Default: the command with `--yes`. */
  applyDestructive?: string
}

/** What to say about `refusal`, in the terms of whoever pushed. */
export function explainRefusal(refusal: PushRefusal, context: RefusalContext): RefusalExplanation {
  const { command } = context
  const retry = context.retry ?? `run \`${command}\` again`
  switch (refusal.kind) {
    case "unmanaged-tables":
      return {
        headline: `The engine refused the schema push: these tables exist and Supatype did not create them: ${refusal.tables.join(", ")}. Nothing was applied.`,
        hints: [`Run \`supatype adopt\` to bring them under management (it shows what it takes first), then ${retry}.`],
      }
    case "destructive":
      return {
        headline: `This schema change would drop data: ${refusal.count} destructive operation(s). Nothing was applied.`,
        hints: [`To drop it on purpose, run \`${context.applyDestructive ?? `${command} --yes`}\`.`],
      }
    case "security-drift":
      return explainSecurityDrift(refusal.objects, command)
    case "engine-busy":
      return {
        headline: "Another push is running on this database (or an adopt, rebaseline or rollback), so nothing was applied.",
        hints: [`Try again once it has finished: ${retry}.`],
      }
    case "image-pull":
      return explainImagePull(refusal, retry)
    case "drift-changed":
      return explainDriftChanged(refusal, command)
  }
}

function explainDriftChanged(refusal: Extract<PushRefusal, { kind: "drift-changed" }>, command: string): RefusalExplanation {
  return {
    headline: "The drift changed after the preview, so nothing was recorded.",
    hints: [
      ...(refusal.unseen.length > 0 ? [`New since the preview: ${refusal.unseen.join(", ")}`] : []),
      ...(refusal.gone.length > 0 ? [`No longer drifted: ${refusal.gone.join(", ")}`] : []),
      `Run \`${command}\` again to review the drift as it is now.`,
    ],
  }
}

function explainSecurityDrift(objects: readonly DriftedObject[], command: string): RefusalExplanation {
  const count = objects.length > 0 ? `${objects.length} object(s)` : "Objects"
  return {
    headline: `${count} that decide who may read or write were changed outside Supatype, so nothing was applied.`,
    hints: [
      ...(objects.length > 0 ? [formatDriftedObjects(objects).join("\n")] : []),
      `Run \`${command} --overwrite-drift\` to put Supatype's definitions back, or ` +
        "`supatype doctor --rebaseline --accept-access-drift` to keep the changes as Supatype's.",
    ],
  }
}

function explainImagePull(refusal: Extract<PushRefusal, { kind: "image-pull" }>, retry: string): RefusalExplanation {
  const image = refusal.image === undefined ? "" : ` (${refusal.image})`
  return {
    headline: `Docker could not pull an image the schema push runs in${image}. Nothing was applied.`,
    hints: [
      refusal.detail,
      "The engine never ran, so this is not a problem with your schema.",
      refusal.rateLimited
        ? `Docker Hub's pull rate limit was reached. Run \`docker login\` to raise it, or wait, then ${retry}.`
        : `Check your network and that the image exists, then ${retry}.`,
    ],
  }
}

/**
 * A dev hot reload's push failed: say what refused it and what to do, in place of the raw output.
 * dev keeps running and watching either way; saving the schema pushes again.
 */
export function reportDevPushFailure(err: unknown): void {
  const refusal = classifyPushRefusal(err)
  if (refusal === null || refusal.kind === "destructive") {
    // A destructive refusal was already shown and asked about (`pushConsentingToDestructive`).
    console.error("[supatype] Schema push failed:", err instanceof Error ? err.message : String(err))
    return
  }
  const { headline, hints } = explainRefusal(refusal, { command: "supatype dev", retry: "save the schema again" })
  console.error(`[supatype] ${headline}`)
  for (const hint of hints) console.error(hint.replace(/^/gm, "  "))
}

/**
 * Run a command that pushes; when the push is refused, end with what refused it and what to do,
 * in place of the engine's raw output. `explained` names the refusals the command's own walkthrough
 * has already spoken to (`push` offers adoption and asks about lost data), which are rethrown as
 * they came. Every other failure is rethrown too.
 */
export async function explainingRefusal<T>(
  command: string,
  run: () => Promise<T>,
  explained: readonly PushRefusalKind[] = [],
): Promise<T> {
  try {
    return await run()
  } catch (err: unknown) {
    const refusal = classifyPushRefusal(err)
    if (refusal === null || explained.includes(refusal.kind)) throw err
    const { headline, hints } = explainRefusal(refusal, { command })
    fatalError(headline, hints)
  }
}
