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
import { chmodSync, mkdirSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "./config.js"
import { currentPlatform, cachePath } from "./binary-cache.js"
import { ensureBinary } from "./ensure-binary.js"
import { uniqueFileToken } from "./unique-file-token.js"

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

  const tmpDir = engineTempDir()
  // Every file this request has created, removed in `finally` whatever fails after it: a later
  // write, building the arguments, or the spawn itself.
  const written: string[] = []
  let result: SpawnSyncReturns<string>
  try {
    // One token for this request's files. The directory is shared by every CLI process, and named
    // by the millisecond alone, two requests at once wrote one file and each engine read the other's.
    const token = uniqueFileToken()
    const reqFile = join(tmpDir, `req-${token}.json`)
    const inputPayload = body["ast"] !== undefined ? body["ast"] : body
    writeRequestFile(reqFile, JSON.stringify(inputPayload), written)

    let gzPath: string | undefined
    let manifestPath: string | undefined
    if (typeof body["schema_sources_gz_base64"] === "string") {
      gzPath = join(tmpDir, `sources-${token}.gz`)
      writeRequestFile(gzPath, Buffer.from(body["schema_sources_gz_base64"], "base64"), written)
    }
    // One file per seed document. The engine takes `--ir` once per document rather than one
    // combined blob, so a failure can name the file it was in.
    const irPaths: string[] = []
    const documents = body["ir_documents"]
    if (Array.isArray(documents)) {
      documents.forEach((document, index) => {
        const irPath = join(tmpDir, `ir-${token}-${index}.json`)
        writeRequestFile(
          irPath,
          typeof document === "string" ? document : JSON.stringify(document),
          written,
        )
        irPaths.push(irPath)
      })
    }

    if (body["schema_sources_manifest"] !== undefined) {
      manifestPath = join(tmpDir, `manifest-${token}.json`)
      writeRequestFile(manifestPath, JSON.stringify(body["schema_sources_manifest"]), written)
    }

    const args = endpointToArgs(endpoint, body, reqFile, {
      ...(gzPath !== undefined ? { gzPath } : {}),
      ...(manifestPath !== undefined ? { manifestPath } : {}),
      ...(irPaths.length > 0 ? { irPaths } : {}),
    })

    result = spawnSync(bin, args, {
      encoding: "utf8",
      cwd: process.cwd(),
    })
  } finally {
    for (const f of written) {
      try { unlinkSync(f) } catch { /* ignore */ }
    }
  }

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

/**
 * The directory engine request files are written to, created private to this user.
 *
 * A request can hold `database_url`, credentials included, and the directory is in the shared
 * system temp directory. `mode` applies only when `mkdir` creates it, so an existing directory is
 * narrowed too. On Windows the mode bits are mostly ignored and the user's temp directory is
 * already private.
 */
function engineTempDir(): string {
  // One directory per user on POSIX: a shared one another user created first is not ours to make
  // private, and writing into it can fail. Windows' temp directory is already per user.
  const uid = process.getuid?.()
  const dir = join(tmpdir(), uid === undefined ? "supatype-engine" : `supatype-engine-${uid}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch { /* not ours to change; the files are still 0600 */ }
  return dir
}

/**
 * Write one request file, readable by this user only, and record it for removal.
 *
 * `wx` creates the file or fails: a name that already exists, a file or a link someone placed
 * there, is never written through. Such a file is not recorded, since it is not this request's to
 * remove; anything else that fails after the file was created leaves it recorded, so it is removed.
 */
function writeRequestFile(path: string, data: string | Buffer, written: string[]): void {
  try {
    writeFileSync(path, data, { mode: 0o600, flag: "wx" })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") written.push(path)
    throw err
  }
  written.push(path)
}

// ---------------------------------------------------------------------------
// Endpoint → CLI args mapping
// ---------------------------------------------------------------------------

function endpointToArgs(
  endpoint: string,
  body: Record<string, unknown>,
  reqFile: string,
  sources?: { gzPath?: string; manifestPath?: string; irPaths?: string[] },
): string[] {
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
      if (sources?.gzPath) sourceArgs.push("--schema-sources-gz", sources.gzPath)
      if (sources?.manifestPath) sourceArgs.push("--schema-sources-manifest", sources.manifestPath)
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
      const documents = (sources?.irPaths ?? []).flatMap((path) => ["--ir", path])
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
