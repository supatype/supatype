import type { Command } from "commander"
import { errorMessage, responseFailureText } from "../error-message.js"
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
import { resolveProjectApiUrl } from "../resolve-api-url.js"
import { loadConfig, rethrowIfConfigBroken } from "../config.js"
import { ensureBinary } from "../ensure-binary.js"
import {
  FUNCTIONS_SERVE_PORT,
  functionsPathCandidatesFromProject,
  preferredFunctionsPathFromProject,
  serviceRoleRoutes,
  type SupatypeProjectConfig,
} from "../project-config.js"
import {
  discoverFunctionsOrExit,
  functionNameProblem,
  functionsServeFiles,
  generateFunctionsRouterSource,
  removeOnExit,
  sweepStaleServeFiles,
  writeServiceRoleKeyFileUntilExit,
  type DiscoveredFunctionRoute,
} from "../functions-router-gen.js"
import { loadProjectLink } from "../link.js"
import { resolveCloudAccessToken } from "../cloud-credentials.js"
import { resolveTarget } from "../resolve-target.js"
import { targetFetch } from "../target-client.js"
import { isArrayOf, isNumber, isShape, isString, nullable, optional, readJson } from "@supatype/shared"
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
    .option("--auth", "Include a test JWT in the request")
    .option("--local", "Invoke the local dev server (default if serve is running)")
    .action(async (name: string, opts: { data: string; auth?: boolean; local?: boolean }) => {
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
  const routes = discoverServeRoutes(cwd, functionsDir)
  const routerPath = writeServeFiles(cwd, functionsDir, routes)

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

  await runDenoServe(
    denoBin,
    ["run", "--allow-net", "--allow-env", "--allow-read", "--watch", ...envArgs, routerPath],
    { cwd, env: denoServeEnv(cwd, functionsDir, config, opts) },
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
 * would kill the CLI without the `exit` that removes the key and router files.
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
function discoverServeRoutes(cwd: string, functionsDir: string): DiscoveredFunctionRoute[] {
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
  return routes
}

/**
 * Writes this serve's Deno router and, when the shell gave a key, its key file, both removed when
 * the serve stops. The router reads the key from that file, as it still can after a --watch
 * reload, and grants it only to the routes SUPATYPE_SERVICE_ROLE_ROUTES names, as the deployed
 * worker does. Files of serves killed outright are swept first. Returns the router's path.
 */
function writeServeFiles(cwd: string, functionsDir: string, routes: DiscoveredFunctionRoute[]): string {
  sweepStaleServeFiles(cwd, functionsDir)
  const { routerPath, keyPath } = functionsServeFiles(cwd, functionsDir)
  const serviceRoleKey = process.env["SUPATYPE_SERVICE_ROLE_KEY"] ?? ""
  const serviceRoleKeyPath = serviceRoleKey !== "" ? keyPath : undefined
  if (serviceRoleKeyPath !== undefined) writeServiceRoleKeyFileUntilExit(serviceRoleKeyPath, serviceRoleKey)
  writeFileSync(routerPath, generateFunctionsRouterSource(routerPath, routes, serviceRoleKeyPath), "utf8")
  removeOnExit(routerPath)
  return routerPath
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
 * The environment the serve's Deno runs with: this shell's, plus where it serves from, uncoloured.
 * Handlers reach the project's API where it answers (resolve-api-url.ts): the native server for a
 * native project, never a gateway a Docker run left in `.env`.
 */
export function denoServeEnv(
  cwd: string,
  functionsDir: string,
  config: SupatypeProjectConfig,
  listen: ServeListen,
): NodeJS.ProcessEnv {
  const apiUrl = resolveProjectApiUrl(cwd, config)
  return {
    ...process.env,
    ...DENO_ENV,
    PORT: listen.port,
    // The router listens on 127.0.0.1 without it (functions-router-gen.ts).
    SUPATYPE_FUNCTIONS_HOST: unbracketedHost(listen.host),
    SUPATYPE_DENO_FUNCTIONS_DIR: functionsDir,
    SUPATYPE_SHARED_ENV_FILE: resolve(functionsDir, ENV_LOCAL),
    SUPATYPE_URL: process.env["SUPATYPE_URL"] ?? apiUrl,
    SUPATYPE_PUBLIC_URL: process.env["SUPATYPE_PUBLIC_URL"] ?? apiUrl,
    SUPATYPE_ANON_KEY: process.env["SUPATYPE_ANON_KEY"] ?? "",
    // The router grants the key only to these routes, as the deployed worker does.
    SUPATYPE_SERVICE_ROLE_ROUTES: serviceRoleRoutes(config).join(","),
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

  const link = loadProjectLink(cwd)
  if (link) {
    try {
      const target = resolveTarget(cwd, { env: opts.env })
      if (target.mode !== "direct" && target.token) {
        await deployViaTarget(cwd, target, fns)
        return
      }
    } catch {
      /* fall through to compose/local */
    }
  }

  const { selfHostComposePaths } = await import("../self-host-compose.js")
  if (existsSync(selfHostComposePaths(cwd).composePath)) {
    deploySelfHosted(cwd, resolveFunctionsDir(cwd, "read"), fns, FUNCTIONS_WORKER_RESTART_COMMAND)
    return
  }

  await deployCloud(cwd, fns, opts.env)
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

async function deployViaTarget(
  cwd: string,
  target: ReturnType<typeof resolveTarget>,
  fns: DiscoveredFunctionRoute[],
): Promise<void> {
  info(`Deploying to ${target.mode} project: ${target.projectRef} (${target.environment})`)
  plain()

  for (const fn of fns) {
    const start = Date.now()
    const source = readFunctionSource(fn)

    try {
      await targetFetch(
        target.apiBaseUrl,
        target.apiPrefix,
        {
          method: "POST",
          path: `/projects/${target.projectRef}/functions/deploy`,
          body: {
            functions: [{
              name: fn.name,
              source,
              entrypoint: `${fn.name}/index.ts`,
            }],
            // Sent every deploy, and replaced wholesale by the platform: the config file is the whole
            // truth, so a name removed from it must stop being entitled to the service-role key.
            serviceRole: serviceRoleRoutesFor(cwd),
          },
          token: target.token!,
          orgId: target.orgId,
          environment: target.mode === "cloud" ? target.environment : undefined,
        },
      )

      const duration = Date.now() - start
      plain(`  ${fn.name} ✓ deployed (${duration}ms)`)
    } catch (err) {
      plain(`  ${fn.name} ✗ ${errorMessage(err)}`)
    }
  }

  info(`Deployed ${fns.length} function(s)`)
  void cwd
}

async function deployCloud(cwd: string, fns: DiscoveredFunctionRoute[], env?: string): Promise<void> {
  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    error(NOT_LINKED)
    process.exit(1)
  }

  const token = getCloudToken(cwd)
  if (!token) {
    error(NOT_LOGGED_IN)
    process.exit(1)
  }

  const apiUrl = getCloudApiUrl(cwd)
  info(`Deploying to project: ${linked.ref}`)
  plain()

  for (const fn of fns) {
    const start = Date.now()

    // Read source code
    const source = readFunctionSource(fn)

    try {
      const res = await fetch(`${apiUrl}/api/v1/projects/${linked.ref}/functions/deploy`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Org-Id": linked.orgId ?? "",
        },
        body: JSON.stringify({
          functions: [{
            name: fn.name,
            source,
            entrypoint: `${fn.name}/index.ts`,
          }],
          // Same grants as the target path: both reach the same endpoint, and a project deployed one
          // way must not end up with a different credential surface than the other.
          serviceRole: serviceRoleRoutesFor(cwd),
        }),
        signal: AbortSignal.timeout(60_000),
      })

      if (!res.ok) {
        const reason = await responseFailureText(res)
        plain(`  ${fn.name} ✗ ${reason}`)
        continue
      }

      const duration = Date.now() - start
      plain(`  ${fn.name} ✓ deployed (${duration}ms)`)
    } catch (err) {
      plain(`  ${fn.name} ✗ ${errorMessage(err)}`)
    }
  }

  info(`Deployed ${fns.length} function(s)`)
  info(`Invoke: https://${linked.ref}.supatype.dev/functions/v1/<name>`)
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
const isDeployedFunctions = isShape({
  data: isArrayOf(
    isShape({
      name: isString,
      deployedAt: optional(nullable(isString)),
      invocations24h: optional(nullable(isNumber)),
      avgDurationMs: optional(nullable(isNumber)),
    }),
  ),
})

/** `GET /functions/:name/logs`: the newest entries first. */
const isFunctionLogs = isShape({
  data: isArrayOf(isShape({ timestamp: isString, level: isString, message: optional(nullable(isString)) })),
})

function readFunctionSource(fn: DiscoveredFunctionRoute): string {
  const stat = statSync(fn.path)
  if (stat.isFile()) {
    return readFileSync(fn.path, "utf8")
  }

  // Directory function: read all .ts files
  const files: Record<string, string> = {}
  const entries = readdirSync(fn.path, { recursive: true, encoding: "utf8" })
  for (const entry of entries) {
    const fullPath = join(fn.path, entry)
    if (statSync(fullPath).isFile() && (entry.endsWith(".ts") || entry.endsWith(".js"))) {
      files[entry] = readFileSync(fullPath, "utf8")
    }
  }
  return JSON.stringify(files)
}

// ─── List ────────────────────────────────────────────────────────────────────

async function listFunctions(cwd: string): Promise<void> {
  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    // Show local functions instead
    const fns = discoverFunctions(cwd)
    if (fns.length === 0) {
      info("No functions found locally or remotely.")
      return
    }
    plain("Local functions (not linked to a cloud project):\n")
    for (const fn of fns) {
      plain(`  ${fn.name.padEnd(30)} ${relative(cwd, fn.entrypoint)}`)
    }
    return
  }

  const token = getCloudToken(cwd)
  if (!token) {
    error(NOT_LOGGED_IN)
    process.exit(1)
  }

  try {
    const res = await fetch(`${getCloudApiUrl(cwd)}/api/v1/projects/${linked.ref}/functions`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": linked.orgId ?? "",
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      error(`Failed to list functions: ${await responseFailureText(res)}`)
      process.exit(1)
    }

    const { data } = await readJson(res, isDeployedFunctions)

    if (data.length === 0) {
      info("No deployed functions.")
      return
    }

    plain("Deployed functions:\n")
    plain(`  ${"Name".padEnd(28)} ${"Last Deployed".padEnd(24)} ${"Invocations (24h)".padEnd(20)} Avg Duration`)
    plain(`  ${"─".repeat(28)} ${"─".repeat(24)} ${"─".repeat(20)} ${"─".repeat(12)}`)

    for (const fn of data) {
      const deployed = fn.deployedAt ? new Date(fn.deployedAt).toLocaleString() : "-"
      plain(
        `  ${fn.name.padEnd(28)} ${deployed.padEnd(24)} ${String(fn.invocations24h ?? 0).padEnd(20)} ${fn.avgDurationMs ?? 0}ms`,
      )
    }
  } catch (err) {
    error(`Error: ${errorMessage(err)}`)
    process.exit(1)
  }
}

// ─── Delete ──────────────────────────────────────────────────────────────────

async function deleteFunction(cwd: string, name: string): Promise<void> {
  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    error(NOT_LINKED)
    process.exit(1)
  }

  const token = getCloudToken(cwd)
  if (!token) {
    error(NOT_LOGGED_IN)
    process.exit(1)
  }

  try {
    const res = await fetch(`${getCloudApiUrl(cwd)}/api/v1/projects/${linked.ref}/functions/${name}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": linked.orgId ?? "",
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const reason = await responseFailureText(res)
      error(`Failed to delete "${name}": ${reason}`)
      process.exit(1)
    }

    info(`Function "${name}" deleted. It will return 404 immediately.`)
  } catch (err) {
    error(`Error: ${errorMessage(err)}`)
    process.exit(1)
  }
}

// ─── Logs ────────────────────────────────────────────────────────────────────

async function functionLogs(cwd: string, name: string, opts: { since: string }): Promise<void> {
  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    error(NOT_LINKED)
    process.exit(1)
  }

  const token = getCloudToken(cwd)
  if (!token) {
    error(NOT_LOGGED_IN)
    process.exit(1)
  }

  try {
    const res = await fetch(
      `${getCloudApiUrl(cwd)}/api/v1/projects/${linked.ref}/functions/${name}/logs?since=${opts.since}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Org-Id": linked.orgId ?? "",
        },
        signal: AbortSignal.timeout(10_000),
      },
    )

    if (!res.ok) {
      error(`Failed to fetch logs: ${await responseFailureText(res)}`)
      process.exit(1)
    }

    const { data } = await readJson(res, isFunctionLogs)

    if (data.length === 0) {
      info(`No logs for "${name}" in the last ${opts.since}.`)
      return
    }

    for (const entry of data) {
      const ts = new Date(entry.timestamp).toISOString().slice(11, 23)
      const level = entry.level.toUpperCase().padEnd(5)
      plain(`${ts} [${level}] ${entry.message}`)
    }
  } catch (err) {
    error(`Error: ${errorMessage(err)}`)
    process.exit(1)
  }
}

// ─── Invoke ──────────────────────────────────────────────────────────────────

async function invoke(
  cwd: string,
  name: string,
  opts: { data: string; auth?: boolean; local?: boolean },
): Promise<void> {
  let url: string
  const headers: Record<string, string> = { "Content-Type": "application/json" }

  // The project's own gateway, as every other command that calls the API finds it. A fixed
  // localhost port reached whatever else on the machine listened there.
  const localUrl = `${resolveProjectApiUrl(cwd)}/functions/v1/${name}`
  if (opts.local) {
    url = localUrl
  } else {
    const { getLinkedProject, getCloudToken } = await loadCloudHelpers()
    const linked = getLinkedProject(cwd)
    if (linked) {
      url = `https://${linked.ref}.supatype.dev/functions/v1/${name}`
      const token = getCloudToken(cwd)
      if (token && opts.auth) {
        headers["Authorization"] = `Bearer ${token}`
      }
    } else {
      url = localUrl
    }
  }

  if (opts.auth && !headers["Authorization"]) {
    // Generate a test JWT for local invocation
    headers["Authorization"] = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImlhdCI6MTcwMDAwMDAwMH0.test"
  }

  try {
    let body: string | undefined
    try {
      JSON.parse(opts.data)
      body = opts.data
    } catch {
      error("Invalid JSON data. Use --data '{\"key\": \"value\"}'")
      process.exit(1)
    }

    const start = Date.now()
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    })

    const duration = Date.now() - start
    const responseBody = await res.text()

    plain(`Status: ${res.status} (${duration}ms)`)
    plain()

    // Try to pretty-print JSON
    try {
      const json: unknown = JSON.parse(responseBody)
      plain(JSON.stringify(json, null, 2))
    } catch {
      plain(responseBody)
    }
  } catch (err) {
    if (err instanceof TypeError && errorMessage(err).includes("fetch")) {
      error(`Cannot reach ${url}`)
      error("Is the function server running? Start it with: npx supatype functions serve")
    } else {
      error(`Error: ${errorMessage(err)}`)
    }
    process.exit(1)
  }
}

// ─── Env management ──────────────────────────────────────────────────────────

async function envList(cwd: string): Promise<void> {
  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    // Show local env vars
    const envPath = resolve(resolveFunctionsDir(cwd, "read"), ENV_LOCAL)
    if (!existsSync(envPath)) {
      info("No environment variables configured.")
      return
    }

    const lines = readFileSync(envPath, "utf8").split("\n")
    plain("Local environment variables:\n")
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIdx = trimmed.indexOf("=")
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx)
        plain(`  ${key} = ••••••••`)
      }
    }
    return
  }

  const token = getCloudToken(cwd)
  if (!token) {
    error(NOT_LOGGED_IN)
    process.exit(1)
  }

  try {
    const res = await fetch(`${getCloudApiUrl(cwd)}/api/v1/projects/${linked.ref}/functions/env`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": linked.orgId ?? "",
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      error(`Failed to list env vars: ${await responseFailureText(res)}`)
      process.exit(1)
    }

    const { data } = await readJson(res, isShape({ data: isArrayOf(isString) }))

    if (data.length === 0) {
      info("No environment variables set.")
      return
    }

    plain("Environment variables (values masked):\n")
    for (const key of data) {
      plain(`  ${key} = ••••••••`)
    }
  } catch (err) {
    error(`Error: ${errorMessage(err)}`)
    process.exit(1)
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

  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    // Set in local env file
    const envPath = resolve(resolveFunctionsDir(cwd, "write"), ENV_LOCAL)
    let content = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""

    // Replace existing or append
    const regex = new RegExp(`^${key}=.*$`, "m")
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`)
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`
    }

    writeFileSync(envPath, content, "utf8")
    info(`Set ${key} in local env file.`)
    return
  }

  const token = getCloudToken(cwd)
  if (!token) {
    error(NOT_LOGGED_IN)
    process.exit(1)
  }

  try {
    const res = await fetch(`${getCloudApiUrl(cwd)}/api/v1/projects/${linked.ref}/functions/env`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Org-Id": linked.orgId ?? "",
      },
      body: JSON.stringify({ key, value }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const reason = await responseFailureText(res)
      error(`Failed to set env var: ${reason}`)
      process.exit(1)
    }

    info(`Set ${key} for project ${linked.ref}.`)
  } catch (err) {
    error(`Error: ${errorMessage(err)}`)
    process.exit(1)
  }
}

async function envUnset(cwd: string, key: string): Promise<void> {
  const { getLinkedProject, getCloudToken, getCloudApiUrl } = await loadCloudHelpers()
  const linked = getLinkedProject(cwd)

  if (!linked) {
    const envPath = resolve(resolveFunctionsDir(cwd, "read"), ENV_LOCAL)
    if (!existsSync(envPath)) {
      error("No local env file found.")
      process.exit(1)
    }

    let content = readFileSync(envPath, "utf8")
    const regex = new RegExp(`^${key}=.*\n?`, "m")
    content = content.replace(regex, "")
    writeFileSync(envPath, content, "utf8")
    info(`Removed ${key} from local env file.`)
    return
  }

  const token = getCloudToken(cwd)
  if (!token) {
    error(NOT_LOGGED_IN)
    process.exit(1)
  }

  try {
    const res = await fetch(`${getCloudApiUrl(cwd)}/api/v1/projects/${linked.ref}/functions/env/${key}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Org-Id": linked.orgId ?? "",
      },
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const reason = await responseFailureText(res)
      error(`Failed to unset env var: ${reason}`)
      process.exit(1)
    }

    info(`Removed ${key} for project ${linked.ref}.`)
  } catch (err) {
    error(`Error: ${errorMessage(err)}`)
    process.exit(1)
  }
}

// ─── Cloud helpers (lazy loaded) ─────────────────────────────────────────────

interface CloudHelpers {
  getLinkedProject(cwd: string): { ref: string; orgId?: string | undefined; kind?: string } | null
  getCloudToken(cwd: string): string | null
  getCloudApiUrl(cwd: string): string
}

async function loadCloudHelpers(): Promise<CloudHelpers> {
  return {
  getLinkedProject(cwd: string): { ref: string; orgId?: string | undefined; kind?: string } | null {
      const link = loadProjectLink(cwd)
      if (!link?.projectRef) return null
      return {
        ref: link.projectRef,
        kind: link.kind,
        ...(link.orgId !== undefined ? { orgId: link.orgId } : {}),
      }
    },

    getCloudToken(cwd: string): string | null {
      if (process.env["SUPATYPE_ACCESS_TOKEN"]) {
        return process.env["SUPATYPE_ACCESS_TOKEN"]
      }
      // The link's own token, else the session `supatype login` saved. This used to read
      // ~/.supatype/token, which nothing writes, so a fresh login still read as logged out.
      const link = loadProjectLink(cwd)
      return link === null ? null : resolveCloudAccessToken(link) ?? null
    },

    getCloudApiUrl(cwd: string): string {
      const link = loadProjectLink(cwd)
      if (link?.cloudApiUrl) return link.cloudApiUrl
      return process.env["SUPATYPE_API_URL"] ?? "https://api.supatype.com"
    },
  }
}
