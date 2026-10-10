/**
 * engine-client.ts: subprocess-based engine invocation.
 *
 * Replaces the former HTTP-based engine client (Docker container API).
 * All callers use the same interface; only the transport changed.
 *
 * The engine binary reads a request JSON file passed via --request-file and
 * writes a response JSON to stdout.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "./config.js"
import { currentPlatform, cachePath } from "./binary-cache.js"
import { ensureBinary } from "./ensure-binary.js"

// ---------------------------------------------------------------------------
// Types (kept for backward compatibility with existing callers)
// ---------------------------------------------------------------------------

export interface Operation {
  type?: string
  kind?: string
  description?: string
  risk?: "safe" | "warn" | "danger" | "cautious" | "destructive"
  warning?: string
  sql?: string
  table?: string
  column?: string
  constraint?: string
  index_name?: string
  index?: { fields?: string[]; name?: string; unique?: boolean }
}

export interface DiffResult {
  operations: Operation[]
  warnings?: string[]
  summary?: string
}

export interface IntrospectResult {
  models: Array<{
    name: string
    table: string
    columns: Array<{
      name: string
      type: string
      nullable: boolean
      default?: string
      primaryKey?: boolean
      unique?: boolean
      references?: { table: string; column: string }
    }>
  }>
}

export interface EngineResult<T = unknown> {
  ok: boolean
  data: T
  message?: string
  error?: string
}

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly exitCode: number | null,
    /** What the engine printed on stdout. A refused push puts its machine-readable reason there. */
    public readonly stdout = "",
  ) {
    super(message)
    this.name = "EngineError"
  }
}

// ---------------------------------------------------------------------------
// Engine binary resolution
// ---------------------------------------------------------------------------

let _engineBin: string | null = null

async function getEngineBin(): Promise<string> {
  if (_engineBin) return _engineBin

  const cwd = process.cwd()

  try {
    const config = loadConfig(cwd)
    // Download-on-miss (with retry) so a fresh machine or a failed postinstall
    // self-heals on first use instead of silently skipping type/admin refresh.
    _engineBin = await ensureBinary("engine", config)
    return _engineBin
  } catch (err) {
    // A real download/verification failure must surface, not fall back to a
    // possibly-stale cached binary from a different version.
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("Failed to download")) throw err
    // Otherwise (no valid project config) fall through to default cache scan.
  }

  // No config found: scan the cache for any available engine binary.
  const platform = currentPlatform()
  const engineCacheDir = join(homedir(), ".supatype", "cache", "engine")
  try {
    const cachedVersions = readdirSync(engineCacheDir).sort()
    for (const version of cachedVersions.reverse()) {
      const bin = join(cachePath("engine", version), `supatype-engine-${platform.os}-${platform.arch}`)
      if (existsSync(bin)) {
        _engineBin = bin
        return _engineBin
      }
    }
  } catch { /* cache dir doesn't exist */ }

  throw new Error(
    "Engine binary not found. Run: supatype update",
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Verify the engine binary is accessible. Throws if not found. */
export async function ensureEngine(): Promise<void> {
  await getEngineBin()
}

/** Check if the engine can be invoked. Returns true/false. */
export async function engineHealth(): Promise<boolean> {
  try {
    const bin = await getEngineBin()
    const result = spawnSync(bin, ["--version"], { encoding: "utf8" })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * Invoke the engine and return a typed result.
 *
 * The endpoint maps to a subcommand:
 *   /diff        → engine diff
 *   /push        → engine push
 *   /generate    → engine generate
 *   /migrations  → engine migrations
 *   /introspect  → engine introspect
 *   /validate    → engine validate
 *   /admin       → engine admin (admin-config JSON on stdout)
 *   /seed        → engine seed (result document JSON on stdout)
 */
export async function engineRequest<T = unknown>(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<T> {
  const bin = await getEngineBin()

  // A directory of this request's own, removed with everything in it whatever fails: a write,
  // building the arguments, or the spawn itself.
  const tmpDir = engineTempDir()
  let result: SpawnSyncReturns<string>
  try {
    const files = writeRequestFiles(tmpDir, body)
    const args = endpointToArgs(endpoint, body, files)
    result = spawnSync(bin, args, {
      encoding: "utf8",
      cwd: process.cwd(),
    })
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  return readEngineResult<T>(endpoint, result)
}

/** Turn the engine's exit status and stdout into the request's answer, or throw its error. */
function readEngineResult<T>(endpoint: string, result: SpawnSyncReturns<string>): T {
  // A failed seed is an answer, not a crash.
  //
  // `engine seed` exits 1 when the seed itself failed and prints the result document on
  // stdout: which file, what it wrote before it stopped, and the error in the schema's own
  // terms. Treating a non-zero exit as "no output" threw all of that away and reported
  // `Engine /seed failed (exit 1): (no output)`, which is worse than the raw Postgres error
  // it replaced. Anything without a document to read still throws.
  const reportsFailureAsData = endpoint === "/seed" && (result.stdout?.trim().length ?? 0) > 0

  if (result.status !== 0 && !reportsFailureAsData) {
    const stderr = result.stderr?.trim() || "(no output)"
    throw new EngineError(
      `Engine ${endpoint} failed (exit ${result.status}): ${stderr}`,
      endpoint,
      result.status,
      result.stdout ?? "",
    )
  }

  if (!result.stdout?.trim()) {
    // Some subcommands print nothing on success.
    return {} as T
  }

  try {
    return JSON.parse(result.stdout) as T
  } catch {
    // Non-JSON stdout: return as message.
    return { message: result.stdout.trim() } as T
  }
}

// ---------------------------------------------------------------------------
// Request files
// ---------------------------------------------------------------------------

/** The files one request hands the engine, named on its command line. */
interface RequestFiles {
  reqFile: string
  gzPath?: string
  manifestPath?: string
  irPaths?: string[]
}

/**
 * A new directory for one request's files, private to this user.
 *
 * A request can hold `database_url`, credentials included, and the directory is in the shared
 * system temp directory. A fixed name there can be created first by another user, world-writable
 * or as a link to a directory they own, and `mkdir` with `recursive` accepts it as it is. So each
 * request makes its own with `mkdtemp`, which picks an unused random name, never follows a link,
 * and creates it 0700. On Windows the mode bits are mostly ignored and the user's temp directory
 * is already private.
 */
function engineTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supatype-engine-"))
}

/** Write the request and every file it refers to into `dir`, and say where each went. */
function writeRequestFiles(dir: string, body: Record<string, unknown>): RequestFiles {
  const reqFile = join(dir, "request.json")
  // Without an AST the body is the request, less the connection string: that goes to the engine
  // on its own and has no reason to be on disk.
  const inputPayload = body["ast"] !== undefined ? body["ast"] : withoutDatabaseUrl(body)
  writeRequestFile(reqFile, JSON.stringify(inputPayload))

  const files: RequestFiles = { reqFile }
  if (typeof body["schema_sources_gz_base64"] === "string") {
    files.gzPath = join(dir, "sources.gz")
    writeRequestFile(files.gzPath, Buffer.from(body["schema_sources_gz_base64"], "base64"))
  }
  // One file per seed document. The engine takes `--ir` once per document rather than one
  // combined blob, so a failure can name the file it was in.
  const documents = body["ir_documents"]
  if (Array.isArray(documents) && documents.length > 0) {
    files.irPaths = documents.map((document: unknown, index) => {
      const irPath = join(dir, `ir-${index}.json`)
      writeRequestFile(irPath, typeof document === "string" ? document : JSON.stringify(document))
      return irPath
    })
  }
  if (body["schema_sources_manifest"] !== undefined) {
    files.manifestPath = join(dir, "manifest.json")
    writeRequestFile(files.manifestPath, JSON.stringify(body["schema_sources_manifest"]))
  }
  return files
}

function withoutDatabaseUrl(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== "database_url"))
}

/**
 * Write one request file, readable by this user only. `wx` creates the file or fails, so nothing
 * already at the name is ever written through.
 */
function writeRequestFile(path: string, data: string | Buffer): void {
  writeFileSync(path, data, { mode: 0o600, flag: "wx" })
}

// ---------------------------------------------------------------------------
// Endpoint → CLI args mapping
// ---------------------------------------------------------------------------

function endpointToArgs(
  endpoint: string,
  body: Record<string, unknown>,
  files: RequestFiles,
): string[] {
  const { reqFile } = files
  const dbUrl = (body["database_url"] as string | undefined) ?? ""
  const schema = (body["schema"] as string | undefined) ?? "public"
  const force = body["force"] ? ["--force"] : []
  const nonInteractive =
    body["non_interactive"] === true || body["force"] === true ? ["--non-interactive"] : []

  switch (endpoint) {
    case "/diff":
      return ["diff", "--input", reqFile, "--database-url", dbUrl, "--schema", schema]

    case "/push": {
      const sourceArgs: string[] = []
      if (files.gzPath) sourceArgs.push("--schema-sources-gz", files.gzPath)
      if (files.manifestPath) sourceArgs.push("--schema-sources-manifest", files.manifestPath)
      return [
        "push",
        "--input",
        reqFile,
        "--database-url",
        dbUrl,
        "--schema",
        schema,
        ...force,
        ...nonInteractive,
        ...sourceArgs,
      ]
    }

    case "/rollback":
      return ["rollback", "--database-url", dbUrl, "--schema", schema]

    case "/parse":
      return ["parse", "--input", reqFile]

    case "/generate": {
      const lang = (body["lang"] as string | undefined) ?? "typescript"
      const artifact = (body["artifact"] as string | undefined) ?? "types"
      return ["generate", "--input", reqFile, "--lang", lang, "--artifact", artifact]
    }

    case "/seed": {
      // `--status` reads the ledger and needs no schema, so it does not take `--input`:
      // passing one would make the command fail on a project whose schema has moved on.
      if (body["status"] === true) {
        return ["seed", "--database-url", dbUrl, "--status"]
      }
      const documents = (files.irPaths ?? []).flatMap((path) => ["--ir", path])
      const environment =
        typeof body["environment"] === "string" ? ["--environment", body["environment"]] : []
      return [
        "seed",
        "--input",
        reqFile,
        ...documents,
        "--database-url",
        dbUrl,
        "--schema",
        schema,
        ...environment,
        ...(body["atomic"] === true ? ["--atomic"] : []),
        ...(body["run_once"] === true ? ["--run-once"] : []),
      ]
    }

    case "/introspect":
      return ["introspect", "--database-url", dbUrl, "--schema", schema]

    case "/doctor": {
      const strict = body["strict"] ? ["--strict"] : []
      return ["doctor", "--input", reqFile, "--database-url", dbUrl, "--schema", schema, ...strict]
    }

    case "/adopt": {
      const yes = body["yes"] ? ["--yes"] : []
      return ["adopt", "--input", reqFile, "--database-url", dbUrl, "--schema", schema, ...yes]
    }

    case "/validate":
      return ["validate", "--input", reqFile]

    case "/admin":
      return ["admin", "--input", reqFile]

    default:
      if (endpoint === "/migrations" || endpoint.startsWith("/migrations")) {
        const action = (body["action"] as string | undefined) ?? "list"
        if (action === "rollback") {
          return ["rollback", "--database-url", dbUrl, "--schema", schema]
        }
        const name = body["name"] as string | undefined
        if (name) {
          return ["migrations", "--database-url", dbUrl, "--name", name]
        }
        return ["migrations", "--database-url", dbUrl]
      }
      return [endpoint.replace(/^\//, ""), "--input", reqFile]
  }
}
