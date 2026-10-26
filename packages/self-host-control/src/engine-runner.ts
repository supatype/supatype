import { spawn } from "node:child_process"
import { writeFile, unlink } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

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

export interface DiffResult {
  operations: Array<{ kind: string; description: string; risk: string; sql?: string }>
  warnings: string[]
}

export async function runEngineDiff(databaseUrl: string, ast: unknown, schema = "public"): Promise<DiffResult> {
  const astPath = await writeTempJson(ast)
  try {
    const out = await runEngine("diff", [
      "--database-url", databaseUrl,
      "--schema", schema,
    ], { inputPath: astPath })
    return JSON.parse(out) as DiffResult
  } finally {
    await deleteTempFile(astPath)
  }
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
  opts?: { noCache?: boolean; schema?: string; rebaseline?: boolean; acceptAccessDrift?: boolean },
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

let capabilities: Promise<{ features: string[] }> | undefined

/**
 * What the engine this control plane runs supports (`supatype-engine capabilities`), asked once. An
 * engine from before the subcommand supports none of the features it lists, so it answers with
 * none rather than failing: the CLI then refuses the flag instead of sending it to be dropped.
 */
export function runEngineCapabilities(): Promise<{ features: string[] }> {
  capabilities ??= runEngine("capabilities", [])
    .then((out) => {
      const parsed = JSON.parse(out.slice(Math.max(out.indexOf("{"), 0))) as { features?: unknown }
      const features = Array.isArray(parsed.features)
        ? parsed.features.filter((f): f is string => typeof f === "string")
        : []
      return { features }
    })
    .catch(() => ({ features: [] }))
  return capabilities
}

/** Forget the engine's answer (tests, or an engine swapped under a running control plane). */
export function resetEngineCapabilities(): void {
  capabilities = undefined
}

/** The wording the engine gives a refusal over its lock, from before it named it on stdout. */
const ENGINE_BUSY_WORDING = /another push, adopt or rebaseline is running/i

/**
 * A refusal the caller can act on, as the engine's own HTTP server answers it (409 with `reason`),
 * or undefined for any other failure.
 */
export function engineRefusal(
  err: unknown,
): { reason: string; message: string; tables?: unknown; objects?: unknown } | undefined {
  if (!(err instanceof EngineRunError)) return undefined
  // What anyhow prints after the log lines: `Error: <the refusal, possibly several lines>`.
  const at = err.stderr.indexOf("Error: ")
  const message = at === -1 ? undefined : err.stderr.slice(at + "Error: ".length).trim()
  for (const line of err.stdout.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate.startsWith("{")) continue
    try {
      const parsed = JSON.parse(candidate) as { status?: unknown; reason?: unknown; tables?: unknown; objects?: unknown }
      if (parsed.status === "refused" && typeof parsed.reason === "string") {
        return {
          reason: parsed.reason,
          message: message ?? err.message,
          ...(parsed.tables !== undefined && { tables: parsed.tables }),
          ...(parsed.objects !== undefined && { objects: parsed.objects }),
        }
      }
    } catch {
      /* not this line */
    }
  }
  if (ENGINE_BUSY_WORDING.test(err.stderr)) {
    const line = err.stderr.split(/\r?\n/).find((l) => ENGINE_BUSY_WORDING.test(l)) ?? ""
    return { reason: "engine_busy", message: line.trim().replace(/^Error:\s*/, "") }
  }
  return undefined
}

export function databaseUrlFromEnv(): string {
  const url = process.env["DATABASE_URL"] ?? process.env["SUPATYPE_SQL_DATABASE_URL"]
  if (!url?.trim()) throw new Error("DATABASE_URL is not configured")
  return url.trim()
}
