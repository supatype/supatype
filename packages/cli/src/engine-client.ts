/**
 * engine-client.ts — subprocess-based engine invocation.
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
import { resolveBinary, currentPlatform, cachePath } from "./binary-cache.js"

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
    _engineBin = await resolveBinary("engine", config)
    return _engineBin
  } catch {
    // No valid project config — fall through to default cache path.
  }

  // No config found — scan the cache for any available engine binary.
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
  if (body["schema_sources_manifest"] !== undefined) {
    manifestPath = join(tmpDir, `manifest-${Date.now()}.json`)
    writeFileSync(manifestPath, JSON.stringify(body["schema_sources_manifest"]))
    cleanup.push(manifestPath)
  }

  const args = endpointToArgs(endpoint, body, reqFile, {
    ...(gzPath !== undefined ? { gzPath } : {}),
    ...(manifestPath !== undefined ? { manifestPath } : {}),
  })

  const result = spawnSync(bin, args, {
    encoding: "utf8",
    cwd: process.cwd(),
  })

  for (const f of cleanup) {
    try { unlinkSync(f) } catch { /* ignore */ }
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "(no output)"
    throw new EngineError(
      `Engine ${endpoint} failed (exit ${result.status}): ${stderr}`,
      endpoint,
      result.status,
    )
  }

  if (!result.stdout?.trim()) {
    // Some subcommands print nothing on success.
    return {} as T
  }

  try {
    return JSON.parse(result.stdout) as T
  } catch {
    // Non-JSON stdout — return as message.
    return { message: result.stdout.trim() } as T
  }
}

// ---------------------------------------------------------------------------
// Endpoint → CLI args mapping
// ---------------------------------------------------------------------------

function endpointToArgs(
  endpoint: string,
  body: Record<string, unknown>,
  reqFile: string,
  sources?: { gzPath?: string; manifestPath?: string },
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
      return ["generate", "--input", reqFile, "--lang", lang]
    }

    case "/introspect":
      return ["introspect", "--database-url", dbUrl, "--schema", schema]

    case "/doctor": {
      const strict = body["strict"] ? ["--strict"] : []
      const noCache = body["no_cache"] ? ["--no-cache"] : []
      return ["doctor", "--input", reqFile, "--database-url", dbUrl, "--schema", schema, ...strict, ...noCache]
    }

    case "/adopt": {
      const yes = body["yes"] ? ["--yes"] : []
      const noCache = body["no_cache"] ? ["--no-cache"] : []
      return ["adopt", "--input", reqFile, "--database-url", dbUrl, "--schema", schema, ...yes, ...noCache]
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
