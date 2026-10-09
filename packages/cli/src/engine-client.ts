/**
 * engine-client.ts: subprocess-based engine invocation.
 *
 * Replaces the former HTTP-based engine client (Docker container API).
 * All callers use the same interface; only the transport changed.
 *
 * The engine binary reads a request JSON file passed via --request-file and
 * writes a response JSON to stdout.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "node:fs"
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

/**
 * What the engine's reconcile decided about one object it owns (schema-engine `ledger::reconcile`).
 * A kind that has moved onto the ledger is planned here rather than as an operation.
 */
export interface ReconcileAction {
  action:
    | "create"
    | "adopt"
    | "conflict"
    | "recreate"
    | "replace"
    | "drift"
    | "keep"
    | "drop"
    | "forget"
    | "released"
  key: { kind: string; schema: string; parent: string; name: string }
  /**
   * An action the parent statement already carries out (a constraint inline in `CREATE TABLE`, or
   * recreated with its table). Sent on `create`, `recreate`, `replace` and `drift`.
   */
  inline?: boolean
  reason?: "stamped" | "structure_matches" | "deparses_equal" | "owned_schema" | "declared"
  /** A `drift` on a policy, grant, label or RLS attribute: putting it back changes who sees what. */
  security_relevant?: boolean
  recorded_def?: string
  live_def?: string
  /** The statement a `create`, `recreate` or `replace` runs. */
  create_sql?: string
}

export interface DiffResult {
  operations: Operation[]
  /** Absent from engines older than the ledger. */
  reconcile?: ReconcileAction[]
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

  const tmpDir = join(tmpdir(), "supatype-engine")
  mkdirSync(tmpDir, { recursive: true })
  const cleanup: string[] = []
  const reqFile = join(tmpDir, `req-${Date.now()}.json`)
  const inputPayload = body["ast"] !== undefined ? body["ast"] : body
  writeFileSync(reqFile, JSON.stringify(inputPayload))
  cleanup.push(reqFile)

  let gzPath: string | undefined
  let manifestPath: string | undefined
  if (typeof body["schema_sources_gz_base64"] === "string") {
    gzPath = join(tmpDir, `sources-${Date.now()}.gz`)
    writeFileSync(gzPath, Buffer.from(body["schema_sources_gz_base64"], "base64"))
    cleanup.push(gzPath)
  }
  // One file per seed document. The engine takes `--ir` once per document rather than one
  // combined blob, so a failure can name the file it was in.
  const irPaths: string[] = []
  const documents = body["ir_documents"]
  if (Array.isArray(documents)) {
    documents.forEach((document, index) => {
      const irPath = join(tmpDir, `ir-${Date.now()}-${index}.json`)
      writeFileSync(irPath, typeof document === "string" ? document : JSON.stringify(document))
      cleanup.push(irPath)
      irPaths.push(irPath)
    })
  }

  if (body["schema_sources_manifest"] !== undefined) {
    manifestPath = join(tmpDir, `manifest-${Date.now()}.json`)
    writeFileSync(manifestPath, JSON.stringify(body["schema_sources_manifest"]))
    cleanup.push(manifestPath)
  }

  const args = endpointToArgs(endpoint, body, reqFile, {
    ...(gzPath !== undefined ? { gzPath } : {}),
    ...(manifestPath !== undefined ? { manifestPath } : {}),
    ...(irPaths.length > 0 ? { irPaths } : {}),
  })

  const result = spawnSync(bin, args, {
    encoding: "utf8",
    cwd: process.cwd(),
  })

  for (const f of cleanup) {
    try { unlinkSync(f) } catch { /* ignore */ }
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
// Endpoint → CLI args mapping
// ---------------------------------------------------------------------------

/** The engine binary's arguments for an endpoint and its request body. Exported for its tests. */
export function endpointToArgs(
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
  // Plan 3.5: put back access changed outside Supatype. The CLI sets it only after a person said
  // yes to the difference, or when `--overwrite-drift` was passed.
  const overwriteDrift = body["overwrite_drift"] === true ? ["--overwrite-drift"] : []

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
        ...overwriteDrift,
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
      const release = Array.isArray(body["release"])
        ? body["release"].filter((r): r is string => typeof r === "string").flatMap((r) => ["--release", r])
        : []
      const keys = Array.isArray(body["keys"])
        ? body["keys"].filter((k): k is string => typeof k === "string").flatMap((k) => ["--key", k])
        : []
      // No `--key` at all is "adopt every conflict" to the binary, so an empty list, which over
      // HTTP is "adopt none", is `--adopt-none` here.
      if (Array.isArray(body["keys"]) && keys.length === 0) keys.push("--adopt-none")
      return ["adopt", "--input", reqFile, "--database-url", dbUrl, "--schema", schema, ...yes, ...release, ...keys]
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
