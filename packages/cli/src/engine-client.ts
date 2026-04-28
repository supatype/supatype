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
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { loadTomlConfig } from "./config-toml.js"
import { resolveBinary, currentPlatform, cachePath } from "./binary-cache.js"

// ---------------------------------------------------------------------------
// Types (kept for backward compatibility with existing callers)
// ---------------------------------------------------------------------------

export interface Operation {
  kind: "create_table" | "alter_table" | "drop_table" | "create_index" | "drop_index" |
        "create_policy" | "drop_policy" | "add_column" | "drop_column" | "alter_column"
  description: string
  risk?: "safe" | "warn" | "danger"
  sql?: string
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

  // Try TOML config overrides first.
  try {
    const config = loadTomlConfig(process.cwd())
    _engineBin = await resolveBinary("engine", config)
    return _engineBin
  } catch {
    // Fall through to cache path.
  }

  // Fall back to default cached version.
  const DEFAULT_ENGINE_VERSION = "0.4.2"
  const platform = currentPlatform()
  const bin = join(
    cachePath("engine", DEFAULT_ENGINE_VERSION),
    `supatype-engine-${platform.os}-${platform.arch}`,
  )
  if (existsSync(bin)) {
    _engineBin = bin
    return _engineBin
  }

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
 */
export async function engineRequest<T = unknown>(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<T> {
  const bin = await getEngineBin()

  // Write request to a temp file.
  const tmpDir = join(tmpdir(), "supatype-engine")
  mkdirSync(tmpDir, { recursive: true })
  const reqFile = join(tmpDir, `req-${Date.now()}.json`)
  writeFileSync(reqFile, JSON.stringify(body))

  const args = endpointToArgs(endpoint, body, reqFile)

  const result = spawnSync(bin, args, {
    encoding: "utf8",
    cwd: process.cwd(),
  })

  // Clean up temp file.
  try { unlinkSync(reqFile) } catch { /* ignore */ }

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
): string[] {
  const dbUrl = (body["database_url"] as string | undefined) ?? ""
  const schema = (body["schema"] as string | undefined) ?? "public"
  const force = body["force"] ? ["--force"] : []

  switch (endpoint) {
    case "/diff":
      return ["diff", "--request-file", reqFile, "--database-url", dbUrl, "--schema", schema]

    case "/push":
      return ["push", "--request-file", reqFile, "--database-url", dbUrl, "--schema", schema, ...force]

    case "/parse":
      return ["parse", "--request-file", reqFile]

    case "/generate":
      return ["generate", "--request-file", reqFile]

    case "/introspect":
      return ["introspect", "--database-url", dbUrl, "--schema", schema]

    case "/validate":
      return ["validate", "--request-file", reqFile]

    default:
      if (endpoint.startsWith("/migrations")) {
        const action = (body["action"] as string | undefined) ?? "list"
        return ["migrations", action, "--database-url", dbUrl]
      }
      // Generic fallback: pass endpoint as subcommand.
      return [endpoint.replace(/^\//, ""), "--request-file", reqFile]
  }
}
