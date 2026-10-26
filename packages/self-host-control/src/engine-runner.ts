import { spawn } from "node:child_process"
import { writeFile, unlink } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  CAPABILITIES_TTL_MS,
  ENGINE_BUSY,
  capabilitiesCache,
  engineBusySentence,
  isArrayOf,
  isJsonObject,
  isShape,
  isString,
  rememberCapabilities,
  type FromShape,
} from "@supatype/shared"

function engineBin(): string {
  return process.env["SUPATYPE_ENGINE_BIN"] ?? "supatype-engine"
}

async function writeTempJson(data: unknown): Promise<string> {
  const path = join(tmpdir(), `supatype-engine-${randomUUID()}.json`)
  await writeFile(path, JSON.stringify(data), "utf-8")
  return path
}

async function deleteTempFile(path: string): Promise<void> {
  await unlink(path).catch(() => {})
}

/** A non-zero engine exit, with what it printed: a refusal puts its JSON reason on stdout. */
export class EngineRunError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message)
    this.name = "EngineRunError"
  }
}

function runEngine(subcommand: string, args: string[], opts?: { inputPath?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const mockScript = process.env["SUPATYPE_ENGINE_MOCK"]
    const bin = mockScript ? process.execPath : engineBin()
    const cmdArgs: string[] = mockScript ? [mockScript] : []
    if (opts?.inputPath) cmdArgs.push("--input", opts.inputPath)
    cmdArgs.push(subcommand, ...args)

    const proc = spawn(bin, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString() })
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString() })
    proc.on("error", (err) => reject(new Error(`Failed to spawn engine: ${err.message}`)))
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout)
      else reject(new EngineRunError(`Engine exit ${code}: ${stderr.trim()}`, code, stdout, stderr))
    })
  })
}

const DIFF_RESULT = { operations: isArrayOf(isJsonObject), warnings: isArrayOf(isString) } as const

/**
 * The engine's `diff` output (its `DiffOutput`), passed on to the client as it is. Each operation is
 * tagged by `type` and carries what that kind of change needs, so only the outline is read here.
 */
export type DiffResult = FromShape<typeof DIFF_RESULT>

const isDiffResult = isShape(DIFF_RESULT)

export async function runEngineDiff(databaseUrl: string, ast: unknown, schema = "public"): Promise<DiffResult> {
  const astPath = await writeTempJson(ast)
  try {
    const out = await runEngine("diff", [
      "--database-url", databaseUrl,
      "--schema", schema,
    ], { inputPath: astPath })
    const diff = JSON.parse(out)
    if (!isDiffResult(diff)) throw new Error("Engine diff printed something other than a diff")
    return diff
  } finally {
    await deleteTempFile(astPath)
  }
}

/**
 * Who a push is recorded as being from (the audit trail). The author is the identity this control
 * plane authenticated, never the client's word for it. The renames the push applies are recorded
 * from the rename journal the schema itself carries (`renameJournal`).
 */
export interface PushAudit {
  pushedBy: string
  pushedVia: "self-host"
  pushedFrom?: string
  pushedByVerified: boolean
}

/** `audit` as the engine binary's flags. */
function auditArgs(audit: PushAudit): string[] {
  const args = ["--pushed-by", audit.pushedBy, "--pushed-via", audit.pushedVia]
  if (audit.pushedFrom) args.push("--pushed-from", audit.pushedFrom)
  if (audit.pushedByVerified) args.push("--pushed-by-verified")
  return args
}

export async function runEnginePush(
  databaseUrl: string,
  ast: unknown,
  opts?: {
    force?: boolean
    schema?: string
    schemaSourcesGzBase64?: string
    schemaSourcesManifest?: unknown
    /** Put back access changed outside Supatype (plan 3.5). */
    overwriteDrift?: boolean
    /** Recorded on the migration row by an engine that records it (`push_audit`). */
    audit?: PushAudit
  },
): Promise<unknown> {
  const astPath = await writeTempJson(ast)
  const tempFiles: string[] = [astPath]
  try {
    const args = [
      "--database-url", databaseUrl,
      "--schema", opts?.schema ?? "public",
      "--non-interactive",
    ]
    if (opts?.force) args.push("--force")
    if (opts?.overwriteDrift) args.push("--overwrite-drift")
    if (opts?.schemaSourcesGzBase64) {
      const gzPath = join(tmpdir(), `supatype-sources-${randomUUID()}.gz`)
      writeFileSync(gzPath, Buffer.from(opts.schemaSourcesGzBase64, "base64"))
      tempFiles.push(gzPath)
      args.push("--schema-sources-gz", gzPath)
    }
    if (opts?.schemaSourcesManifest) {
      const manPath = join(tmpdir(), `supatype-manifest-${randomUUID()}.json`)
      writeFileSync(manPath, JSON.stringify(opts.schemaSourcesManifest))
      tempFiles.push(manPath)
      args.push("--schema-sources-manifest", manPath)
    }
    // An engine from before the audit trail refuses the flags, and a push must not fail for want
    // of its audit: the migration row then says nothing about who pushed, as it always did.
    if (opts?.audit && (await runEngineCapabilities()).features.includes("push_audit")) {
      args.push(...auditArgs(opts.audit))
    }
    const out = await runEngine("push", args, { inputPath: astPath })
    try {
      return JSON.parse(out)
    } catch {
      return { message: out.trim() }
    }
  } finally {
    for (const f of tempFiles) await deleteTempFile(f)
  }
}

export async function runEngineRollback(
  databaseUrl: string,
  schema = "public",
): Promise<unknown> {
  const out = await runEngine("rollback", [
    "--database-url", databaseUrl,
    "--schema", schema,
  ])
  return JSON.parse(out)
}

export async function runEngineListMigrations(databaseUrl: string): Promise<unknown> {
  const out = await runEngine("migrations", ["--database-url", databaseUrl])
  return JSON.parse(out)
}

export async function runEngineMigrationSources(
  databaseUrl: string,
  name: string,
): Promise<unknown> {
  const out = await runEngine("migrations", [
    "--database-url", databaseUrl,
    "--name", name,
  ])
  return JSON.parse(out)
}

export async function runEngineDoctor(
  databaseUrl: string,
  ast: unknown,
  opts?: {
    noCache?: boolean
    schema?: string
    rebaseline?: boolean
    acceptAccessDrift?: boolean
    /**
     * With `rebaseline`: the drifted objects its preview showed. The engine records only if the
     * drift is still exactly these, and otherwise refuses with `drift_changed`. Never empty: no
     * `--key` at all is "record whatever drift there is" to the binary.
     */
    keys?: string[]
  },
): Promise<unknown> {
  const astPath = await writeTempJson(ast)
  try {
    const args = [
      "--database-url", databaseUrl,
      "--schema", opts?.schema ?? "public",
    ]
    if (opts?.rebaseline) {
      args.push("--rebaseline")
      // Rebaseline access drift too; the engine reads it only with --rebaseline.
      if (opts.acceptAccessDrift) args.push("--accept-access-drift")
      for (const key of opts.keys ?? []) args.push("--key", key)
    }
    const out = await runEngine("doctor", args, { inputPath: astPath })
    return JSON.parse(out)
  } finally {
    await deleteTempFile(astPath)
  }
}

export async function runEngineIntrospect(databaseUrl: string, schema = "public"): Promise<unknown> {
  const out = await runEngine("introspect", [
    "--database-url", databaseUrl,
    "--schema", schema,
  ])
  return JSON.parse(out)
}

export async function runEngineAdoptWithAst(
  databaseUrl: string,
  ast: unknown,
  opts?: {
    schema?: string
    yes?: boolean
    noCache?: boolean
    /** Only these conflicts; an empty list adopts none (`--adopt-none`), absent adopts every one. */
    keys?: string[]
    release?: string[]
    reclaim?: string[]
  },
): Promise<unknown> {
  const astPath = await writeTempJson(ast)
  try {
    const args = [
      "--database-url", databaseUrl,
      "--schema", opts?.schema ?? "public",
    ]
    if (opts?.yes) args.push("--yes")
    if (opts?.noCache) args.push("--no-cache")
    for (const spec of opts?.release ?? []) args.push("--release", spec)
    for (const spec of opts?.reclaim ?? []) args.push("--reclaim", spec)
    if (opts?.keys !== undefined) {
      // No `--key` at all is "adopt every conflict" to the binary, never what `keys: []` means.
      if (opts.keys.length === 0) args.push("--adopt-none")
      for (const key of opts.keys) args.push("--key", key)
    }
    const out = await runEngine("adopt", args, { inputPath: astPath })
    return JSON.parse(out)
  } finally {
    await deleteTempFile(astPath)
  }
}

/**
 * The engine's answer by binary, trusted for `CAPABILITIES_TTL_MS` (an engine swapped underneath),
 * in the same cache the CLI keeps.
 */
const capabilities = capabilitiesCache<{ features: string[] }>(CAPABILITIES_TTL_MS)

/**
 * What the engine this control plane runs supports (`supatype-engine capabilities`). An engine from
 * before the subcommand exits non-zero and supports none of the features it lists, so it answers
 * with none: the CLI then refuses the flag instead of sending it to be dropped.
 *
 * Only an answer is remembered, and only for `CAPABILITIES_TTL_MS`. An engine that could not be run
 * at all (a missing binary) rejects, and is asked again next time rather than being remembered as
 * supporting nothing for the life of the process.
 */
export async function runEngineCapabilities(): Promise<{ features: string[] }> {
  // Remembered once it has answered: a rejection never reaches the cache.
  const { features } = await rememberCapabilities(capabilities, engineBin(), () =>
    runEngine("capabilities", []).then(parseFeatures, (err: unknown) => {
      if (err instanceof EngineRunError) return { features: [] }
      throw err
    }),
  )
  return { features: [...features] }
}

function parseFeatures(out: string): { features: string[] } {
  const parsed = JSON.parse(out.slice(Math.max(out.indexOf("{"), 0)))
  const listed = isJsonObject(parsed) ? parsed["features"] : undefined
  return { features: Array.isArray(listed) ? listed.filter(isString) : [] }
}

/** Forget the engine's answer (tests, or an engine swapped under a running control plane). */
export function resetEngineCapabilities(): void {
  capabilities.answers.clear()
}

/** A refusal the engine named: its reason, its sentence, and whatever else it names. */
export type EngineRefusal = { reason: string; message: string } & Record<string, unknown>

/**
 * Refusals an engine from before CL3 reported only in words, by the reason a current engine names
 * each with. A rollback's sentence already led with its reason; a missing snapshot's did not.
 */
const REFUSALS_BY_WORDING: ReadonlyArray<{ reason: string; said: RegExp }> = [
  { reason: "no_schema_snapshot", said: /has no schema snapshot/ },
  { reason: "no_applied_migration", said: /^no_applied_migration: /m },
  { reason: "no_rollback_sql", said: /^no_rollback_sql: /m },
]

/** The JSON refusal line on the engine's stdout, with `message` as its sentence. */
function refusalOnStdout(stdout: string, message: string): EngineRefusal | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate.startsWith("{")) continue
    try {
      const parsed = JSON.parse(candidate)
      if (!isJsonObject(parsed)) continue
      // Whatever the refusal names (`tables`, `objects`, a rebaseline's `unseen` and `gone`) is
      // passed on as the engine sent it, so a refusal added later needs no change here.
      const { status, reason, message: _said, ...details } = parsed
      if (status === "refused" && typeof reason === "string") return { ...details, reason, message }
    } catch {
      /* not this line */
    }
  }
  return undefined
}

/** A refusal an engine from before the reasons reported only on stderr, read by its wording. */
function refusalByWording(stderr: string, message: string | undefined): EngineRefusal | undefined {
  // Read as the CLI reads it.
  const busy = engineBusySentence(stderr)
  if (busy !== undefined) return { reason: ENGINE_BUSY, message: busy }
  // Only the refusal's own sentence, never the log lines before it.
  if (message === undefined) return undefined
  const known = REFUSALS_BY_WORDING.find(({ said }) => said.test(message))
  return known === undefined ? undefined : { reason: known.reason, message }
}

/**
 * A refusal the caller can act on, as the engine's own HTTP server answers it (409 with `reason`),
 * or undefined for any other failure. By the reason the engine prints, and failing that by the
 * wording of an engine from before it printed one.
 */
export function engineRefusal(err: unknown): EngineRefusal | undefined {
  if (!(err instanceof EngineRunError)) return undefined
  // What anyhow prints after the log lines: `Error: <the refusal, possibly several lines>`.
  const at = err.stderr.indexOf("Error: ")
  const message = at === -1 ? undefined : err.stderr.slice(at + "Error: ".length).trim()
  return refusalOnStdout(err.stdout, message ?? err.message) ?? refusalByWording(err.stderr, message)
}

export function databaseUrlFromEnv(): string {
  const url = process.env["DATABASE_URL"] ?? process.env["SUPATYPE_SQL_DATABASE_URL"]
  if (!url?.trim()) throw new Error("DATABASE_URL is not configured")
  return url.trim()
}
