import type { Command } from "commander"
import { errorMessage } from "../error-message.js"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { resolve, join, relative, isAbsolute } from "node:path"
import { execSync } from "node:child_process"
import { runUntilStopped } from "../run-until-stopped.js"
import { STOP_SIGNALS } from "../stop-signals.js"
import { sayTargetWarning } from "../target-warning.js"
import { resolveProjectApiUrl } from "../resolve-api-url.js"
import { loadConfig, rethrowIfConfigBroken } from "../config.js"
import { ensureBinary } from "../ensure-binary.js"
import {
  FUNCTIONS_SERVE_PORT,
  functionsPathCandidatesFromProject,
  hooksPathFromProject,
  preferredFunctionsPathFromProject,
  serviceRoleRoutes,
} from "../project-config.js"
import { discoverFunctionsOrExit, functionNameProblem, type DiscoveredFunctionRoute } from "../functions-discovery.js"
import {
  functionsServeDenoArgs,
  functionsWorkerEnv,
  installFunctionsWorker,
  type FunctionsWorkerProject,
} from "../functions-worker-files.js"
import { functionsServeKeyPath, sweepStaleServeKeyFiles, writeServiceRoleKeyFileUntilExit } from "../service-role-key-file.js"
import { loadProjectLink } from "../link.js"
import { projectRequest, resolveTarget, targetFunctions, type DeployTarget } from "../resolve-target.js"
import { targetFetch, targetStream, type TargetFetchOptions } from "../target-client.js"
import { isArrayOf, isJsonObject, isNumber, isShape, isString, isUnknown, nullable, optional, toPosixPath, type Guard } from "@supatype/shared"
import {
  ensureFunctionsDenoTypes,
  sharedFunctionsReadmeSource,
} from "../functions-deno-types.js"
import { functionTemplateSource } from "../functions-template.js"
import { error, info, plain } from "../ui/messages.js"
import { nextSteps } from "../ui/next-steps.js"
import { DENO_ENV } from "../native-dev-env.js"

// ─── Constants ───────────────────────────────────────────────────────────────

const SHARED_DIR = "_shared"
const ENV_LOCAL = ".env.local"
const ENV_PRODUCTION = ".env.production"
// The commands that exist: there is no `supatype cloud` group, login and link are top level.
const NOT_LOGGED_IN = "Not logged in. Run: supatype login"
const NOT_LINKED = "No linked project. Run: supatype link"

/**
 * How long a request to the linked target may take. A deploy, a delete and an env change restart
 * the worker before they answer, which often takes more than 10 s, so they get longer.
 */
const TARGET_TIMEOUT_MS = 10_000
const RESTART_TIMEOUT_MS = 60_000
/**
 * More time for each function a deploy carries: Supatype Cloud syncs them in turn within the one
 * request, so a fixed limit timed a large deploy out while the server deployed every function.
 */
const PER_FUNCTION_TIMEOUT_MS = 30_000

/** One request to the linked project's functions API. */
interface TargetCall {
  method: string
  subpath: string
  body?: unknown
  /** Whether the route restarts the worker before it answers. */
  restartsWorker?: boolean
  /** How many functions the call carries, each given {@link PER_FUNCTION_TIMEOUT_MS} more. */
  functions?: number
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerFunctions(program: Command): void {
  const fnCmd = program
    .command("functions")
    .description("Manage Supatype Edge Functions (Deno-based serverless TypeScript)")

  fnCmd
    .command("new <name>")
    .description("Scaffold a new edge function")
    .action((name: string) => {
      scaffoldFunction(process.cwd(), name)
    })

  fnCmd
    .command("serve")
    .description("Start a local Deno server that serves all functions with hot reload")
    .option("--port <port>", "Port to serve on", String(FUNCTIONS_SERVE_PORT))
    .option("--host <host>", "Address to listen on (0.0.0.0 to be reachable from other machines)", "127.0.0.1")
    .option("--env-file <path>", "Path to env file", ENV_LOCAL)
    .action(async (opts: { port: string; host: string; envFile: string }) => {
      await serve(process.cwd(), opts)
    })

  fnCmd
    .command("deploy")
    .description("Deploy all functions (or --only <name> for one) to the linked project")
    .option("--only <name>", "Deploy a single function")
    .option("--env <name>", "Target environment when linked")
    .option("--dry-run", "Show what would be deployed without deploying")
    .action(async (opts: { only?: string; env?: string; dryRun?: boolean }) => {
      await deploy(process.cwd(), opts)
    })

  fnCmd
    .command("list")
    .description("List all deployed functions for the linked project")
    .action(async () => {
      await listFunctions(process.cwd())
    })

  fnCmd
    .command("delete <name>")
    .description("Remove a deployed function")
    .action(async (name: string) => {
      await deleteFunction(process.cwd(), name)
    })

  fnCmd
    .command("logs <name>")
    .description("Tail logs for a deployed function")
    .option("--since <duration>", "Show logs since duration (e.g. 1h, 30m)", "1h")
    .action(async (name: string, opts: { since: string }) => {
      await functionLogs(process.cwd(), name, opts)
    })

  fnCmd
    .command("invoke <name>")
    .description("Invoke a local or deployed function")
    .option("--data <json>", "JSON body to send", "{}")
    .option("--auth", "Send a token: your Cloud session on a Cloud link, a test JWT on this machine; refused for a self-hosted server")
    .option(
      "--local",
      "Invoke locally: a running `functions serve` on --port if one answers, otherwise the dev API (the default when no Cloud project is linked)",
    )
    .option("--port <port>", "Port of the local `functions serve` to try first", String(FUNCTIONS_SERVE_PORT))
    .action(async (name: string, opts: InvokeOptions) => {
      await invoke(process.cwd(), name, opts)
    })

  const envCmd = fnCmd
    .command("env")
    .description("Manage function environment variables")

  envCmd
    .command("list")
    .description("List environment variables (values masked)")
    .action(async () => {
      await envList(process.cwd())
    })

  envCmd
    .command("set <keyvalue>")
    .description("Set an environment variable (KEY=value)")
    .action(async (keyvalue: string) => {
      await envSet(process.cwd(), keyvalue)
    })

  envCmd
    .command("unset <key>")
    .description("Remove an environment variable")
    .action(async (key: string) => {
      await envUnset(process.cwd(), key)
    })
}

// ─── Scaffold ────────────────────────────────────────────────────────────────

function scaffoldFunction(cwd: string, name: string): void {
  // Before anything is written: a folder the control plane would refuse is never created.
  const problem = functionNameProblem(name)
  if (problem !== undefined) {
    error(`Function ${problem}`)
    process.exit(1)
  }
  const functionsDir = resolveFunctionsDir(cwd, "write")
  const fnDir = resolve(functionsDir, name)
  if (existsSync(fnDir)) {
    error(`Function "${name}" already exists at ${relative(cwd, fnDir)}`)
    process.exit(1)
  }

  mkdirSync(fnDir, { recursive: true })

  writeFileSync(join(fnDir, "index.ts"), functionTemplateSource(name), "utf8")

  // Ensure _shared directory exists
  const sharedDir = resolve(functionsDir, SHARED_DIR)
  if (!existsSync(sharedDir)) {
    mkdirSync(sharedDir, { recursive: true })
    writeFileSync(
      join(sharedDir, "README.md"),
      sharedFunctionsReadmeSource(),
      "utf8",
    )
  }

  // Ensure .env.local exists
  const envLocalPath = resolve(functionsDir, ENV_LOCAL)
  if (!existsSync(envLocalPath)) {
    writeFileSync(
      envLocalPath,
      "# Local environment variables for edge functions\n# These are NOT committed to git\n# Set production env vars via: npx supatype functions env set KEY=value\n",
      "utf8",
    )
  }

  const denoTypes = ensureFunctionsDenoTypes(cwd, functionsDir)

  const functionsDirLabel = relativeFunctionsDir(cwd, functionsDir)
  info(`Created function: ${functionsDirLabel}/${name}/index.ts`)
  if (denoTypes.wroteDenoDts) {
    info(`Added Deno IDE types: ${functionsDirLabel}/deno.d.ts`)
  }
  if (denoTypes.wroteTsconfig) {
    info(`Added functions tsconfig: ${functionsDirLabel}/tsconfig.json`)
  }
  if (denoTypes.rootExclude === "updated") {
    info('Updated root tsconfig.json to exclude "functions"')
  }

  const steps = [
    "Local dev:    npx supatype functions serve",
    `Invoke:       npx supatype functions invoke ${name}`,
    "Deploy:       npx supatype functions deploy",
    ...denoTypes.hints,
  ]
  nextSteps("Next steps:", steps)
}

// ─── Discover functions ──────────────────────────────────────────────────────

function resolveFunctionsDir(cwd: string, mode: "read" | "write"): string {
  try {
    const cfg = loadConfig(cwd)
    if (mode === "write") {
      return preferredFunctionsPathFromProject(cfg, cwd)
    }
    const candidates = functionsPathCandidatesFromProject(cfg, cwd)
    return candidates.find(dir => existsSync(dir)) ?? candidates[0] ?? resolve(cwd, "functions")
  } catch {
    // Keep commands usable even if config cannot be loaded yet.
    const modern = resolve(cwd, "functions")
    const legacy = resolve(cwd, "supatype/functions")
    if (mode === "write") return existsSync(legacy) ? legacy : modern
    return existsSync(modern) ? modern : legacy
  }
}

function relativeFunctionsDir(cwd: string, functionsDir: string): string {
  const rel = relative(cwd, functionsDir)
  return rel.length > 0 ? rel : "."
}

function resolveEnvFilePath(cwd: string, functionsDir: string, envFile: string): string {
  if (isAbsolute(envFile)) return envFile
  if (envFile.includes("/") || envFile.includes("\\")) return resolve(cwd, envFile)
  return resolve(functionsDir, envFile)
}

function discoverFunctions(cwd: string): DiscoveredFunctionRoute[] {
  return discoverFunctionsOrExit(resolveFunctionsDir(cwd, "read"))
}

// ─── Serve (local dev) ──────────────────────────────────────────────────────

async function serve(cwd: string, opts: { port: string; host: string; envFile: string }): Promise<void> {
  const config = loadConfig(cwd)
  const functionsDir = resolveFunctionsDir(cwd, "read")
  listServeFunctions(cwd, functionsDir)
  const project: FunctionsWorkerProject = { cwd, config, functionsDir, keyPath: writeServeKeyFile(cwd) }

  const envArgs = denoEnvFileArgs(resolveEnvFilePath(cwd, functionsDir, opts.envFile))

  info(`Serving functions at ${serveDisplayUrl(opts.host, opts.port)}`)
  info("Watching for changes...")
  plain()

  let denoBin: string
  try {
    denoBin = await ensureBinary("deno", config)
  } catch (err) {
    error(`Could not provision Deno: ${errorMessage(err)}`)
    process.exit(1)
  }

  // The functions and hooks directories are watched too, so a function added while it serves is found.
  const watchDirs = [functionsDir, hooksPathFromProject(config, cwd)].filter((dir) => existsSync(dir))
  await runDenoServe(
    denoBin,
    functionsServeDenoArgs(installFunctionsWorker(), watchDirs, envArgs),
    { cwd, env: denoServeEnv(project, opts) },
  )
}

/**
 * Deno's flag for `envFilePath`, or nothing when there is no such file. One argument: `--env-file`
 * takes an optional value, which Deno reads only after `=`, so with the path as its own argument
 * Deno loaded `.env` and ran the env file as the script.
 */
export function denoEnvFileArgs(envFilePath: string): string[] {
  return existsSync(envFilePath) ? [`--env-file=${envFilePath}`] : []
}

/**
 * Runs the serve's Deno until it stops, then ends the command, with an error when it failed. It
 * exits on a clean stop too, in the same turn: a Ctrl+C heard once the stop listeners are gone
 * would kill the CLI without the `exit` that removes the key file.
 */
async function runDenoServe(denoBin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<void> {
  let status: number
  try {
    status = await runUntilStopped(denoBin, args, opts)
  } catch (err) {
    error(`Could not start Deno: ${errorMessage(err)}`)
    process.exit(1)
  }
  if (status !== 0) error("Function server exited with errors.")
  process.exit(status)
}

/** The functions under `functionsDir`, listed for the terminal, ending the command when there are none. */
function listServeFunctions(cwd: string, functionsDir: string): void {
  const routes = discoverFunctionsOrExit(functionsDir)
  if (routes.length === 0) {
    error(`No functions found in ${relativeFunctionsDir(cwd, functionsDir)}/`)
    error("Create one with: npx supatype functions new <name>")
    process.exit(1)
  }
  plain(`Discovered ${routes.length} function(s):`)
  for (const fn of routes) {
    plain(`  /${fn.name}  →  ${relative(cwd, fn.entrypoint)}`)
  }
  plain()
}

/**
 * Writes this serve's key file when the shell gave a key, removed when the serve stops, and returns
 * its path. The worker reads the key from that file, as it still can after a --watch reload, and
 * grants it only to the routes SUPATYPE_SERVICE_ROLE_ROUTES names. Key files of serves killed
 * outright are swept first.
 */
function writeServeKeyFile(cwd: string): string | undefined {
  sweepStaleServeKeyFiles(cwd)
  const serviceRoleKey = process.env["SUPATYPE_SERVICE_ROLE_KEY"] ?? ""
  if (serviceRoleKey === "") return undefined
  const keyPath = functionsServeKeyPath(cwd)
  writeServiceRoleKeyFileUntilExit(keyPath, serviceRoleKey)
  return keyPath
}

/**
 * The address `functions serve` announces for `host`: localhost for a wildcard bind (`0.0.0.0`, `::`),
 * which is no address a browser can open, and an IPv6 host in brackets, as a URL writes it.
 */
export function serveDisplayUrl(host: string, port: string): string {
  const bare = unbracketedHost(host)
  const shown = bare === "0.0.0.0" || bare === "::" ? "localhost" : bare.includes(":") ? `[${bare}]` : bare
  return `http://${shown}:${port}/functions/v1/`
}

/** `host` without the brackets a URL puts round an IPv6 address: `[::1]` is `::1`, as Deno binds it. */
function unbracketedHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
}

/** Where `functions serve` listens. */
export interface ServeListen {
  port: string
  host: string
}

/**
 * The environment the serve's Deno runs with: this shell's, uncoloured, plus the worker's for
 * `project`, listening where `listen` says. Handlers reach the project's API where it answers
 * (resolve-api-url.ts): the native server for a native project, never a gateway a Docker run left
 * in `.env`.
 */
export function denoServeEnv(project: FunctionsWorkerProject, listen: ServeListen): NodeJS.ProcessEnv {
  const apiUrl = resolveProjectApiUrl(project.cwd, project.config)
  return {
    ...process.env,
    ...DENO_ENV,
    PORT: listen.port,
    SUPATYPE_FUNCTIONS_HOST: unbracketedHost(listen.host),
    SUPATYPE_URL: process.env["SUPATYPE_URL"] ?? apiUrl,
    SUPATYPE_PUBLIC_URL: process.env["SUPATYPE_PUBLIC_URL"] ?? apiUrl,
    SUPATYPE_ANON_KEY: process.env["SUPATYPE_ANON_KEY"] ?? "",
    ...functionsWorkerEnv(project),
  }
}

// ─── Deploy ──────────────────────────────────────────────────────────────────

async function deploy(cwd: string, opts: { only?: string; env?: string; dryRun?: boolean }): Promise<void> {
  const allFns = discoverFunctions(cwd)
  const fns = opts.only
    ? allFns.filter(f => f.name === opts.only)
    : allFns

  if (fns.length === 0) {
    const functionsDir = resolveFunctionsDir(cwd, "read")
    const functionsDirLabel = relativeFunctionsDir(cwd, functionsDir)
    if (opts.only) {
      error(`Function "${opts.only}" not found in ${functionsDirLabel}/`)
    } else {
      error(`No functions found in ${functionsDirLabel}/`)
    }
    process.exit(1)
  }

  if (opts.dryRun) {
    plain("Dry run: the following functions would be deployed:\n")
    for (const fn of fns) {
      plain(`  ${fn.name}  →  ${relative(cwd, fn.entrypoint)}`)
    }
    plain(`\nTotal: ${fns.length} function(s)`)
    return
  }

  // Ended outside the target's lookup: a failed deploy must not be taken for one, and deployed
  // again another way.
  const target = linkedTarget(cwd, opts.env)
  if (target !== null) {
    finishDeploy(fns.length, await deployViaTarget(cwd, target, fns))
    info(`Invoke: ${targetFunctions(target).invokeBase}/<name>`)
    return
  }

  const { selfHostComposePaths } = await import("../self-host-compose.js")
  if (existsSync(selfHostComposePaths(cwd).composePath)) {
    deploySelfHosted(cwd, resolveFunctionsDir(cwd, "read"), fns, FUNCTIONS_WORKER_RESTART_COMMAND)
    return
  }
  error(NOT_LINKED)
  process.exit(1)
}

/**
 * The command that restarts this project's functions worker: the CLI's own, which recreates it
 * with the current config and .env under the right project name, wherever it is run from.
 */
const FUNCTIONS_WORKER_RESTART_COMMAND = "supatype self-host compose restart functions-worker"

function deploySelfHosted(
  cwd: string,
  functionsDir: string,
  fns: DiscoveredFunctionRoute[],
  restartCommand: string,
): void {
  info("Self-host Compose deployment.")
  // The directory functions.path names, which the stack mounts; it is not always functions/.
  plain(`Functions are served from ${relativeFunctionsDir(cwd, functionsDir)}/ in your project (no bundle step).\n`)

  for (const fn of fns) {
    plain(`  ${fn.name}  →  ${relative(cwd, fn.entrypoint)}`)
  }

  plain(`\n${fns.length} function(s) ready on disk.`)
  info("Restart the functions-worker container to load changes:")
  plain(`  ${restartCommand}`)
  plain("\nKong → supatype-server → functions-worker (per-project worker).")
}

/**
 * The linked project's target, or null when the project is not linked. A link that cannot be used,
 * with no session or an environment that is not linked, ends the command and says why: it is never
 * taken for no link, which would send the work somewhere else. `needsToken` false is for invoke,
 * which calls a public function and needs no session.
 */
function linkedTarget(cwd: string, env: string | undefined, needsToken = true): DeployTarget | null {
  if (!loadProjectLink(cwd)) return null
  let target: DeployTarget
  try {
    target = resolveTarget(cwd, { env, tokenOptional: !needsToken })
  } catch (err) {
    error(errorMessage(err))
    process.exit(1)
  }
  if (needsToken && !target.token) {
    error(NOT_LOGGED_IN)
    process.exit(1)
  }
  return target
}

/** {@link linkedTarget}, ending the command when the project is not linked. */
function requireLinkedTarget(cwd: string): DeployTarget {
  const target = linkedTarget(cwd, undefined)
  if (target === null) {
    error(NOT_LINKED)
    process.exit(1)
  }
  return target
}

/** `call` to the target's project, with the time limit its route needs. */
function targetRequest(target: DeployTarget, call: TargetCall): TargetFetchOptions {
  const base = call.restartsWorker === true ? RESTART_TIMEOUT_MS : TARGET_TIMEOUT_MS
  const timeoutMs = base + (call.functions ?? 0) * PER_FUNCTION_TIMEOUT_MS
  return { ...projectRequest(target, call.method, call.subpath, call.body), timeoutMs }
}

/** Asks `target` for `subpath` of its project, ending the command with `what` and the reason when it fails. */
async function askTarget<T>(target: DeployTarget, what: string, call: TargetCall, guard: Guard<T>): Promise<T> {
  try {
    const answer = await targetFetch(target.apiBaseUrl, target.apiPrefix, targetRequest(target, call), guard)
    sayTargetWarning(answer)
    return answer
  } catch (err) {
    error(`${what}: ${errorMessage(err)}`)
    process.exit(1)
  }
}

/**
 * Deploys through the linked target in one request carrying every function, so a self-hosted worker
 * restarts once a deploy rather than once a function; saying how each went. A refused request fails
 * every function it carried. Returns the names that failed.
 */
async function deployViaTarget(cwd: string, target: DeployTarget, fns: DiscoveredFunctionRoute[]): Promise<string[]> {
  info(`Deploying to ${target.mode} project: ${target.projectRef} (${target.environment})`)
  plain()
  const serviceRole = serviceRoleRoutesFor(cwd)
  const { sent, failed } = readSources(fns)
  if (sent.length === 0) return failed
  const start = Date.now()
  const body = { functions: sent, serviceRole }
  try {
    const call = { method: "POST", subpath: "/functions/deploy", body, restartsWorker: true, functions: sent.length }
    sayTargetWarning(await targetFetch(target.apiBaseUrl, target.apiPrefix, targetRequest(target, call)))
  } catch (err) {
    for (const fn of sent) plain(`  ${fn.name} ✗ ${errorMessage(err)}`)
    return [...failed, ...sent.map((fn) => fn.name)]
  }
  for (const fn of sent) plain(`  ${fn.name} ✓ deployed (${Date.now() - start}ms)`)
  return failed
}

/**
 * One function as the deploy request carries it: its entry module as `source`, and for a directory
 * function every file by path, which the platform writes under the function's directory.
 */
interface DeployedSource {
  name: string
  source: string
  entrypoint: string
  files?: Record<string, string>
}

/**
 * Each function's source, as the deploy request carries it; one that cannot be read is said and
 * failed here, and the rest are still sent.
 */
function readSources(fns: DiscoveredFunctionRoute[]): { sent: DeployedSource[]; failed: string[] } {
  const sent: DeployedSource[] = []
  const failed: string[] = []
  for (const fn of fns) {
    try {
      sent.push({ name: fn.name, entrypoint: `${fn.name}/index.ts`, ...readFunctionFiles(fn) })
    } catch (err) {
      failed.push(fn.name)
      plain(`  ${fn.name} ✗ ${errorMessage(err)}`)
    }
  }
  return { sent, failed }
}

/** Says how many deployed, or names those that failed and ends non-zero. */
function finishDeploy(total: number, failed: readonly string[]): void {
  if (failed.length === 0) {
    info(`Deployed ${total} function(s)`)
    return
  }
  error(`${failed.length} of ${total} function(s) failed to deploy: ${failed.join(", ")}`)
  process.exit(1)
}

/**
 * The project's `functions.serviceRole` list, or undefined when the config cannot be read.
 *
 * Undefined rather than `[]`: the platform replaces the stored list wholesale when the field is present,
 * so sending an empty array because a config failed to load would revoke every grant the project has.
 */
export function serviceRoleRoutesFor(cwd: string): string[] | undefined {
  try {
    return serviceRoleRoutes(loadConfig(cwd))
  } catch (err) {
    rethrowIfConfigBroken(err)
    return undefined
  }
}

/** `GET /functions`: each deployed function, with its last day's use. */
const isDeployedFunctions = isArrayOf(
  isShape({
    name: isString,
    deployedAt: optional(nullable(isString)),
    invocations24h: optional(nullable(isNumber)),
    avgDurationMs: optional(nullable(isNumber)),
  }),
)

/** `GET /functions/:name/logs`: the newest entries first. */
const isFunctionLogs = isArrayOf(isShape({ timestamp: isString, level: isString, message: optional(nullable(isString)) }))

/**
 * A function's source as the deploy request carries it. A file function is its own entry. A
 * directory function's entry is its index.ts, and every .ts and .js file under it goes in `files`,
 * by a path with `/` on every OS. It used to go as a JSON map in `source`, which a self-hosted
 * control plane wrote as index.ts over the project's own checkout (round 6, N27).
 */
function readFunctionFiles(fn: DiscoveredFunctionRoute): { source: string; files?: Record<string, string> } {
  if (statSync(fn.path).isFile()) return { source: readFileSync(fn.path, "utf8") }
  const files: Record<string, string> = {}
  for (const entry of readdirSync(fn.path, { recursive: true, encoding: "utf8" })) {
    const fullPath = join(fn.path, entry)
    if (statSync(fullPath).isFile() && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
      files[toPosixPath(entry)] = readFileSync(fullPath, "utf8")
    }
  }
  return { source: files["index.ts"] ?? "", files }
}

// ─── List ────────────────────────────────────────────────────────────────────

async function listFunctions(cwd: string): Promise<void> {
  const target = linkedTarget(cwd, undefined)
  if (target === null) return listLocalFunctions(cwd)
  const data = await askTarget(target, "Failed to list functions", { method: "GET", subpath: "/functions" }, isDeployedFunctions)
  if (data.length === 0) {
    info("No deployed functions.")
    return
  }
  plain("Deployed functions:\n")
  plain(`  ${"Name".padEnd(28)} ${"Last Deployed".padEnd(24)} ${"Invocations (24h)".padEnd(20)} Avg Duration`)
  plain(`  ${"─".repeat(28)} ${"─".repeat(24)} ${"─".repeat(20)} ${"─".repeat(12)}`)
  for (const fn of data) {
    const deployed = fn.deployedAt ? new Date(fn.deployedAt).toLocaleString() : "-"
    plain(`  ${fn.name.padEnd(28)} ${deployed.padEnd(24)} ${String(fn.invocations24h ?? 0).padEnd(20)} ${fn.avgDurationMs ?? 0}ms`)
  }
}

/** The functions on disk, for a project that is not linked. */
function listLocalFunctions(cwd: string): void {
  const fns = discoverFunctions(cwd)
  if (fns.length === 0) {
    info("No functions found locally or remotely.")
    return
  }
  plain("Local functions (not linked to a project):\n")
  for (const fn of fns) plain(`  ${fn.name.padEnd(30)} ${relative(cwd, fn.entrypoint)}`)
}

// ─── Delete ──────────────────────────────────────────────────────────────────

async function deleteFunction(cwd: string, name: string): Promise<void> {
  const target = requireLinkedTarget(cwd)
  const call = { method: "DELETE", subpath: `/functions/${encodeURIComponent(name)}`, restartsWorker: true }
  await askTarget(target, `Failed to delete "${name}"`, call, isUnknown)
  info(`Function "${name}" deleted. It will return 404 immediately.`)
}

// ─── Logs ────────────────────────────────────────────────────────────────────

/**
 * A function's logs from the linked target: a window of past lines from Supatype Cloud, or the
 * worker's live stream from a server, tailed until Ctrl+C.
 */
async function functionLogs(cwd: string, name: string, opts: { since: string }): Promise<void> {
  const target = requireLinkedTarget(cwd)
  if (targetFunctions(target).logs === "tail") return tailServerLogs(target, name)
  const subpath = `/functions/${encodeURIComponent(name)}/logs?since=${encodeURIComponent(opts.since)}`
  const lines = await askTarget(target, "Failed to fetch logs", { method: "GET", subpath }, isFunctionLogs)
  if (lines.length === 0) info(`No logs for "${name}" in the last ${opts.since}.`)
  for (const entry of lines) plain(formatLogLine(entry))
}

/** Tails the linked server's relay of the worker's log stream, printing `name`'s lines. */
async function tailServerLogs(target: DeployTarget, name: string): Promise<void> {
  info(`Tailing logs for "${name}" on ${target.apiBaseUrl}. Press Ctrl+C to stop.`)
  let body: ReadableStream<Uint8Array>
  try {
    body = await targetStream(target.apiBaseUrl, "/admin/v1", { method: "GET", path: "/functions/logs/tail", token: target.token ?? "" })
  } catch (err) {
    error(`Failed to tail logs: ${errorMessage(err)}`)
    process.exit(1)
  }
  await printLogStream(body, name)
}

/** Prints `name`'s lines from a server-sent event stream as they arrive, until it ends. */
async function printLogStream(body: ReadableStream<Uint8Array>, name: string): Promise<void> {
  const reader = body.getReader()
  // Ctrl+C closes the stream, and the command ends by itself: with nothing listening, it killed the
  // process, which Windows reports as 0xC000013A (local test round 6).
  const stop = (): void => void reader.cancel().catch(() => undefined)
  for (const signal of STOP_SIGNALS) process.on(signal, stop)
  try {
    await printEvents(reader, name)
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, stop)
  }
}

/** Prints `name`'s lines from `reader` until the stream ends or is cancelled. */
async function printEvents(reader: ReadableStreamDefaultReader<Uint8Array>, name: string): Promise<void> {
  const decoder = new TextDecoder()
  let pending = ""
  // A reader rather than `for await`: the DOM lib the integration package compiles against gives a
  // ReadableStream no async iterator.
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    pending += decoder.decode(chunk.value, { stream: true })
    const lines = pending.split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) printLogEvent(line, name)
  }
  printLogEvent(pending, name)
}

const isLogEvent = isShape({ timestamp: isString, level: isString, message: optional(nullable(isString)), function: optional(isString) })

/** One `data:` line of the worker's stream, printed when it is `name`'s. Others are skipped. */
function printLogEvent(line: string, name: string): void {
  if (!line.startsWith("data: ")) return
  let event: unknown
  try {
    event = JSON.parse(line.slice("data: ".length))
  } catch {
    return
  }
  if (isLogEvent(event) && event.function === name) plain(formatLogLine(event))
}

/** A log line as both paths print it: time of day, level, message. */
function formatLogLine(entry: { timestamp: string; level: string; message?: string | null | undefined }): string {
  const ts = new Date(entry.timestamp).toISOString().slice(11, 23)
  return `${ts} [${entry.level.toUpperCase().padEnd(5)}] ${entry.message ?? ""}`
}


// ─── Invoke ──────────────────────────────────────────────────────────────────

/** What `functions invoke` takes. */
interface InvokeOptions {
  data: string
  auth?: boolean
  local?: boolean
  port: string
}

async function invoke(cwd: string, name: string, opts: InvokeOptions): Promise<void> {
  const body = jsonBodyOrExit(opts.data)
  const { url, headers } = await invokeRequest(cwd, name, opts)
  try {
    const start = Date.now()
    const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) })
    const duration = Date.now() - start
    printInvokeAnswer(res.status, duration, await res.text())
  } catch (err) {
    reportInvokeFailure(url, err)
  }
}

/** `data` when it is JSON; otherwise the command ends saying so. */
function jsonBodyOrExit(data: string): string {
  try {
    JSON.parse(data)
    return data
  } catch {
    error("Invalid JSON data. Use --data '{\"key\": \"value\"}'")
    process.exit(1)
  }
}

/** Where the function is, the linked target's or this machine's, and the headers to send it. */
async function invokeRequest(cwd: string, name: string, opts: InvokeOptions): Promise<{ url: string; headers: Record<string, string> }> {
  const target = opts.local ? null : linkedTarget(cwd, undefined, false)
  const url = target === null
    ? `${await localFunctionsBase(cwd, opts.port)}/${name}`
    : `${targetFunctions(target).invokeBase}/${name}`
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (opts.auth) headers["Authorization"] = `Bearer ${target === null ? LOCAL_TEST_JWT : invokeToken(target)}`
  return { url, headers }
}

/** The status, how long it took, and the body, as JSON when it is. */
function printInvokeAnswer(status: number, duration: number, responseBody: string): void {
  plain(`Status: ${status} (${duration}ms)`)
  plain()
  try {
    const json: unknown = JSON.parse(responseBody)
    plain(JSON.stringify(json, null, 2))
  } catch {
    plain(responseBody)
  }
}

/** Ends the command with why the function could not be called. */
function reportInvokeFailure(url: string, err: unknown): never {
  if (err instanceof TypeError && errorMessage(err).includes("fetch")) {
    error(`Cannot reach ${url}`)
    error("Is the function server running? Start it with: npx supatype functions serve")
  } else {
    error(`Error: ${errorMessage(err)}`)
  }
  process.exit(1)
}

/** A placeholder user token for a function served on this machine; never sent to a linked server. */
const LOCAL_TEST_JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImlhdCI6MTcwMDAwMDAwMH0.test"

/**
 * The token `invoke --auth` sends to a linked target, or the command ends saying why there is none:
 * the Cloud session, or the test JWT for a local link, this machine's own server. A self-hosted
 * server gets neither the placeholder nor the link's service-role key.
 */
function invokeToken(target: DeployTarget): string {
  const token = targetFunctions(target).invokeToken
  if (token !== undefined) return token
  if (target.mode === "local") return LOCAL_TEST_JWT
  if (target.mode === "cloud") error(`--auth sends your Supatype Cloud session. ${NOT_LOGGED_IN}`)
  else error(`--auth has no user token for ${target.apiBaseUrl}. Call the function with a signed-in user's access token instead.`)
  process.exit(1)
}

// ─── Env management ──────────────────────────────────────────────────────────

async function envList(cwd: string): Promise<void> {
  const target = linkedTarget(cwd, undefined)
  if (target === null) return listLocalEnv(cwd)
  const listed = await askTarget(target, "Failed to list env vars", { method: "GET", subpath: "/functions/env" }, isEnvListing)
  // Cloud lists the names; a self-hosted server answers the names with their values.
  const keys = Array.isArray(listed) ? listed : Object.keys(listed)
  if (keys.length === 0) {
    info("No environment variables set.")
    return
  }
  plain("Environment variables (values masked):\n")
  for (const key of keys) plain(`  ${key} = ••••••••`)
}

const isEnvListing = (value: unknown): value is string[] | Record<string, unknown> =>
  isArrayOf(isString)(value) || isJsonObject(value)

/** The variables in the functions' local env file, for a project that is not linked. */
function listLocalEnv(cwd: string): void {
  const envPath = resolve(resolveFunctionsDir(cwd, "read"), ENV_LOCAL)
  if (!existsSync(envPath)) {
    info("No environment variables configured.")
    return
  }
  plain("Local environment variables:\n")
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim()
    const eqIdx = trimmed.indexOf("=")
    if (trimmed && !trimmed.startsWith("#") && eqIdx > 0) plain(`  ${trimmed.slice(0, eqIdx)} = ••••••••`)
  }
}

async function envSet(cwd: string, keyvalue: string): Promise<void> {
  const eqIdx = keyvalue.indexOf("=")
  if (eqIdx <= 0) {
    error("Invalid format. Use: npx supatype functions env set KEY=value")
    process.exit(1)
  }
  const key = keyvalue.slice(0, eqIdx)
  const value = keyvalue.slice(eqIdx + 1)
  const target = linkedTarget(cwd, undefined)
  if (target === null) return setLocalEnv(cwd, key, value)
  const call = { method: "POST", subpath: "/functions/env", body: { key, value }, restartsWorker: true }
  await askTarget(target, "Failed to set env var", call, isUnknown)
  info(`Set ${key} for project ${target.projectRef}.`)
}

/** Sets `key` in the functions' local env file, replacing its line or adding one. */
function setLocalEnv(cwd: string, key: string, value: string): void {
  const envPath = resolve(resolveFunctionsDir(cwd, "write"), ENV_LOCAL)
  let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
  const regex = new RegExp(`^${key}=.*$`, "m")
  content = regex.test(content) ? content.replace(regex, `${key}=${value}`) : content.trimEnd() + `\n${key}=${value}\n`
  writeFileSync(envPath, content, "utf8")
  info(`Set ${key} in local env file.`)
}

async function envUnset(cwd: string, key: string): Promise<void> {
  const target = linkedTarget(cwd, undefined)
  if (target === null) return unsetLocalEnv(cwd, key)
  const call = { method: "DELETE", subpath: `/functions/env/${encodeURIComponent(key)}`, restartsWorker: true }
  const answer = await askTarget(target, "Failed to unset env var", call, isUnknown)
  // A self-hosted server says whether the key was there to remove.
  if (isJsonObject(answer) && answer["removed"] === false) info(`${key} was not set for project ${target.projectRef}.`)
  else info(`Removed ${key} for project ${target.projectRef}.`)
}

/** Removes `key` from the functions' local env file. */
function unsetLocalEnv(cwd: string, key: string): void {
  const envPath = resolve(resolveFunctionsDir(cwd, "read"), ENV_LOCAL)
  if (!existsSync(envPath)) {
    error("No local env file found.")
    process.exit(1)
  }
  writeFileSync(envPath, readFileSync(envPath, "utf8").replace(new RegExp(`^${key}=.*\n?`, "m"), ""), "utf8")
  info(`Removed ${key} from local env file.`)
}

/**
 * Where a local invoke goes: a running `functions serve` on `port` when one answers, otherwise the
 * project's own dev API, as every other command that calls the API finds it. A fixed localhost port
 * reached whatever else on the machine listened there.
 */
async function localFunctionsBase(cwd: string, port: string): Promise<string> {
  return (await runningServeBase(port)) ?? `${resolveProjectApiUrl(cwd)}/functions/v1`
}

/** The functions worker's answer to a bare request: a 404 listing the functions it serves. */
const isServeListing = isShape({ available: isArrayOf(isString) })

/**
 * The base URL of the `functions serve` listening on `port`, or undefined when none answers. A bare
 * request is how the worker is recognised: it answers 404 with the list of functions it serves,
 * which nothing else on that port would.
 */
export async function runningServeBase(port: string): Promise<string | undefined> {
  const base = `http://127.0.0.1:${port}/functions/v1`
  try {
    const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(1000) })
    const body: unknown = await res.json()
    return isServeListing(body) ? base : undefined
  } catch {
    return undefined
  }
}
