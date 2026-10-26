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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { spawnComposeEngine, type ComposeEngineTarget } from "./compose-engine-run.js"
import type { Capabilities } from "./engine-ownership-gate.js"
import { hasProjectConfig, loadConfig } from "./config.js"
import { cachedBinaryPath, currentPlatform, newestCachedVersion } from "./binary-cache.js"
import { ensureBinary } from "./ensure-binary.js"
import { findJsonLine } from "./engine-json-line.js"

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
  /**
   * On a `replace`: the object was also changed outside Supatype since the last apply, which the
   * replacement overwrites. Where it decides access, a push asks first (plan 3.5).
   */
  drifted?: {
    recorded_def: string
    live_def: string
    live_fp?: string
    /** Why it could not be compared with what Supatype made, when it could not: treated as changed (F16). */
    unchecked?: string
  }
}

/** One object in a doctor or adopt report, as the engine names it. */
export interface DoctorItem {
  kind: string
  table: string
  name: string
  fields: string[]
  message: string
  /** What Supatype recorded, for a drifted object. */
  recorded?: string
  /** What the database holds now, for a drifted or conflicting object. */
  live?: string
}

/**
 * What the engine's `adopt` reports, previewing or applying. Since the ledger it lists the objects
 * it hands over (`adopt`), takes back (`release`) and hands back again (`reclaim`), and writes
 * ledger rows; an engine from before
 * listed the comment stamps it would write (`stampStatements`) and counted them (`stamped`).
 */
export interface AdoptOutcome {
  status?: string
  adopt?: DoctorItem[]
  release?: DoctorItem[]
  reclaim?: DoctorItem[]
  stampStatements?: string[]
  stamped?: number
}

export interface DiffResult {
  operations: Operation[]
  /** Absent from engines older than the ledger. */
  reconcile?: ReconcileAction[]
  warnings?: string[]
  summary?: string
  /** Drops and adds a person may have meant as renames. Absent from engines that guessed them. */
  renameCandidates?: RenameCandidate[]
}

/**
 * A dropped table or column and an added one the engine offers as a possible rename. Renames are
 * declared in the schema, never guessed, so this is only ever asked about.
 */
export interface RenameCandidate {
  kind: "column" | "table"
  /** The table, for a column; the old table, for a table. */
  table: string
  from: string
  to: string
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
    /** A refusal the CLI acts on by name, such as `engine_busy`. */
    public readonly reason?: string,
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
  // In a project, the project decides: its pin, its `overrides.engine`, downloading on a miss so a
  // fresh machine self-heals. Any failure there is the answer, never a reason to run some other
  // engine. Falling back to the newest cached engine on every error is how a mistyped
  // `overrides.engine` ran a cached 0.6.0, and `doctor` reported "No drift" from it (A2-N2).
  _engineBin = hasProjectConfig(cwd) ? await ensureBinary("engine", loadConfig(cwd)) : newestCachedEngine()
  return _engineBin
}

/** Outside a project there is nothing to choose by, so the newest engine in the cache. */
function newestCachedEngine(): string {
  const platform = currentPlatform()
  const version = newestCachedVersion("engine", platform)
  if (version === undefined) throw new Error("Engine binary not found. Run: supatype update")
  return cachedBinaryPath("engine", version, platform)
}

/** The engine binary this process runs, resolved (and downloaded if need be) once. */
export async function engineBinPath(): Promise<string> {
  return getEngineBin()
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
 *   /admin       → engine admin (admin-config JSON on stdout)
 *   /seed        → engine seed (result document JSON on stdout)
 */
export async function engineRequest<T = unknown>(
  endpoint: string,
  body: Record<string, unknown>,
  compose?: ComposeEngine,
): Promise<T> {
  if (compose !== undefined) return composeEngineRequest<T>(endpoint, body, compose)
  const bin = await getEngineBin()
  // A schema with identity or generated columns goes only to an engine that reads them: one that
  // does not would push plain columns and say nothing. Imported here, as the gate imports this.
  if (body["ast"] !== undefined) {
    const { assertSupported, binaryCapabilities, identityColumnsNeed } = await import("./engine-ownership-gate.js")
    const needs = identityColumnsNeed(body["ast"])
    if (needs.length > 0) assertSupported(binaryCapabilities(bin), needs)
  }

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
      env: engineEnv(body),
    })
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  return readEngineResult<T>(endpoint, result)
}

/**
 * The project's own engine image, run in its compose stack, for a docker project with no
 * `overrides.engine`. Push has always run there; adopt, doctor, type generation and the admin config
 * ran the host binary instead (the pin, else whatever was cached), so one project could be pushed by
 * one engine and adopted by another that did not know the flags (A5-N2, A5-N3).
 */
export interface ComposeEngine {
  target: ComposeEngineTarget
  /** The database as the container reaches it, given to the engine as `DATABASE_URL`. */
  databaseUrl: string
  /** What the engine image supports, asked once. */
  capabilities: () => Promise<Capabilities>
}

/** Subcommands that read only their input, so the run need not start the database. */
const DATABASE_FREE_ENDPOINTS = new Set(["/generate", "/admin", "/parse"])

/**
 * `engineRequest` in the project's engine image. The request files go in a directory of their own
 * under `.supatype`, which the engine service mounts at `/project`, and are removed afterwards; like
 * the host path, they never hold the database URL.
 */
function composeEngineRequest<T>(endpoint: string, body: Record<string, unknown>, compose: ComposeEngine): T {
  const { cwd } = compose.target
  const supatypeDir = join(cwd, ".supatype")
  mkdirSync(supatypeDir, { recursive: true })
  const hostDir = mkdtempSync(join(supatypeDir, "engine-"))
  let result: SpawnSyncReturns<string>
  try {
    const files = inContainer(writeRequestFiles(hostDir, body), cwd)
    result = spawnComposeEngine(compose.target, endpointToArgs(endpoint, body, files), {
      runFlags: DATABASE_FREE_ENDPOINTS.has(endpoint) ? ["-T", "--no-deps"] : ["-T"],
      secrets: { DATABASE_URL: compose.databaseUrl },
      maxBuffer: 50 * 1024 * 1024,
    })
  } finally {
    rmSync(hostDir, { recursive: true, force: true })
  }
  return readEngineResult<T>(endpoint, result)
}

/** The request's files as the engine container sees them, under the project mount. */
function inContainer(files: RequestFiles, cwd: string): RequestFiles {
  const map = (path: string): string => `/project/${relative(cwd, path).split(sep).join("/")}`
  return {
    reqFile: map(files.reqFile),
    ...(files.gzPath !== undefined && { gzPath: map(files.gzPath) }),
    ...(files.manifestPath !== undefined && { manifestPath: map(files.manifestPath) }),
    ...(files.irPaths !== undefined && { irPaths: files.irPaths.map(map) }),
  }
}

/**
 * The engine's environment. The database URL carries the password, so it goes to the engine as
 * `DATABASE_URL`, which every subcommand that connects reads, rather than `--database-url`, where
 * any local user could read it from the process list. A request without one sets it empty, as
 * `--database-url ""` did, so the engine never falls back to a URL from the caller's shell.
 */
function engineEnv(body: Record<string, unknown>): NodeJS.ProcessEnv {
  const url = body["database_url"]
  return { ...process.env, DATABASE_URL: typeof url === "string" ? url : "" }
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
    // Another writer holds the engine's lock: the engine's own sentence, without the exit code and
    // the log lines around it, since nothing is wrong and the answer is to try again.
    const busy = engineBusyMessage(result.stdout ?? "", result.stderr ?? "")
    if (busy !== undefined) {
      throw new EngineError(busy, endpoint, result.status, result.stdout ?? "", ENGINE_BUSY)
    }
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

/** The `reason` the engine gives a refusal over its lock (another push, adopt, rebaseline or rollback). */
export const ENGINE_BUSY = "engine_busy"

/**
 * The engine's sentence for that refusal, for an engine or a server that does not name it. The list
 * of writers grew when rollback took the lock ("another push, adopt or rebaseline", then "another
 * push, adopt, rebaseline or rollback"), so any such list that starts with a push matches.
 */
export const ENGINE_BUSY_WORDING = /another push(?:,? (?:or )?(?:adopt|rebaseline|rollback))* is running[^\n]*/i

/**
 * The engine's sentence when it refused because another writer holds its lock,
 * or undefined for any other failure. From a JSON refusal on stdout when the engine prints one,
 * else its error line on stderr. Exported for its tests.
 */
export function engineBusyMessage(stdout: string, stderr: string): string | undefined {
  const refusal = findJsonLine(stdout, (value) => value["reason"] === ENGINE_BUSY)
  if (refusal !== undefined) {
    const said = typeof refusal["message"] === "string" ? refusal["message"] : refusal["error"]
    return typeof said === "string" && said.trim() !== "" ? said.trim() : busySentence(stderr)
  }
  return ENGINE_BUSY_WORDING.test(stderr) ? busySentence(stderr) : undefined
}

function busySentence(stderr: string): string {
  const found = ENGINE_BUSY_WORDING.exec(stderr)?.[0]?.trim()
  const sentence =
    found ?? "another push, adopt, rebaseline or rollback is running on this database; try again. Nothing was applied."
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
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

/** `flag` once per string in `values`, which a request body carries as a list (or not at all). */
function repeated(values: unknown, flag: string): string[] {
  if (!Array.isArray(values)) return []
  return values.filter((v): v is string => typeof v === "string").flatMap((v) => [flag, v])
}

/**
 * The drifted objects a rebaseline's preview showed, each as its own `--key`. The binary reads no
 * `--key` at all as "record whatever drift there is", so an empty list, which over HTTP means
 * "nothing was shown", cannot be sent and is refused here.
 */
function rebaselineKeys(keys: unknown): string[] {
  if (Array.isArray(keys) && keys.length === 0) {
    throw new Error("a rebaseline's keys names no object; the engine binary would record every drifted object")
  }
  return repeated(keys, "--key")
}

/** The engine binary's arguments for an endpoint and its request body. Exported for its tests. */
export function endpointToArgs(
  endpoint: string,
  body: Record<string, unknown>,
  files: RequestFiles,
): string[] {
  const { reqFile } = files
  const schema = (body["schema"] as string | undefined) ?? "public"
  const force = body["force"] ? ["--force"] : []
  // Plan 3.5: put back access changed outside Supatype. The CLI sets it only after a person said
  // yes to the difference, or when `--overwrite-drift` was passed.
  const overwriteDrift = body["overwrite_drift"] === true ? ["--overwrite-drift"] : []

  switch (endpoint) {
    case "/diff":
      return ["diff", "--input", reqFile, "--schema", schema]

    case "/push": {
      const sourceArgs: string[] = []
      if (files.gzPath) sourceArgs.push("--schema-sources-gz", files.gzPath)
      if (files.manifestPath) sourceArgs.push("--schema-sources-manifest", files.manifestPath)
      return [
        "push",
        "--input",
        reqFile,
        "--schema",
        schema,
        ...force,
        // Always: the binary's stdin is a pipe nobody writes to, so a question it asked would read
        // nothing and abort. The CLI asks the person, and sends `force` only after a yes.
        "--non-interactive",
        ...overwriteDrift,
        ...sourceArgs,
      ]
    }

    case "/rollback":
      return ["rollback", "--schema", schema]

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
        return ["seed", "--status"]
      }
      const documents = (files.irPaths ?? []).flatMap((path) => ["--ir", path])
      const environment =
        typeof body["environment"] === "string" ? ["--environment", body["environment"]] : []
      return [
        "seed",
        "--input",
        reqFile,
        ...documents,
        "--schema",
        schema,
        ...environment,
        ...(body["atomic"] === true ? ["--atomic"] : []),
        ...(body["run_once"] === true ? ["--run-once"] : []),
      ]
    }

    case "/introspect":
      return ["introspect", "--schema", schema]

    case "/doctor": {
      const strict = body["strict"] ? ["--strict"] : []
      const rebaseline = body["rebaseline"] ? ["--rebaseline"] : []
      // Rebaseline access drift too; only ever sent alongside --rebaseline. Not --overwrite-drift,
      // which the engine takes on push alone.
      const acceptAccessDrift =
        body["rebaseline"] && body["accept_access_drift"] === true ? ["--accept-access-drift"] : []
      return [
        "doctor",
        "--input",
        reqFile,
        "--schema",
        schema,
        ...strict,
        ...rebaseline,
        ...acceptAccessDrift,
        ...(body["rebaseline"] ? rebaselineKeys(body["keys"]) : []),
      ]
    }

    case "/adopt": {
      const yes = body["yes"] ? ["--yes"] : []
      const keys = repeated(body["keys"], "--key")
      // No `--key` at all is "adopt every conflict" to the binary, so an empty list, which over
      // HTTP is "adopt none", is `--adopt-none` here.
      if (Array.isArray(body["keys"]) && keys.length === 0) keys.push("--adopt-none")
      const objects = [...repeated(body["release"], "--release"), ...repeated(body["reclaim"], "--reclaim"), ...keys]
      return ["adopt", "--input", reqFile, "--schema", schema, ...yes, ...objects]
    }

    case "/admin":
      return ["admin", "--input", reqFile]

    // The SQL a push would apply. Plain, it takes no lock an application waits on and records
    // nothing; `--record` rehearses the push, under its locks, so the file records it too (IN-A).
    case "/migrate": {
      const record = body["record"] === true ? ["--record"] : []
      return ["migrate", "--input", reqFile, "--schema", schema, ...force, ...record]
    }

    default:
      if (endpoint === "/migrations" || endpoint.startsWith("/migrations")) {
        const action = (body["action"] as string | undefined) ?? "list"
        if (action === "rollback") {
          return ["rollback", "--schema", schema]
        }
        const name = body["name"] as string | undefined
        if (name) {
          return ["migrations", "--name", name]
        }
        return ["migrations"]
      }
      return [endpoint.replace(/^\//, ""), "--input", reqFile]
  }
}
