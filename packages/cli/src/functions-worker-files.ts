/**
 * The functions worker native `dev` and `functions serve` run: packages/functions-worker itself,
 * the code the deployed image runs, rather than a router generated to copy its rules. A copy
 * drifted from the worker three times (which export it took, who got the service-role key, which
 * env files it read), and every drift was a function that worked locally and failed once deployed.
 *
 * The CLI carries the worker's source (generated/functions-worker-source.ts) and writes it to the
 * cache under a directory named for its content, so every project and every serve of one CLI
 * version share one copy and nothing is left in a project when they stop.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { cacheRoot } from "./binary-cache.js"
import { discoverHandlersInDir, discoverTsFunctionsInDir, InvalidFunctionNameError } from "./functions-discovery.js"
import { fatalError } from "./ui/fatal.js"
import { FUNCTIONS_WORKER_SOURCE } from "./generated/functions-worker-source.js"
import { hooksPathFromProject, serviceRoleRoutes, type SupatypeProjectConfig } from "./project-config.js"
import { uniqueFileToken } from "./unique-file-token.js"

/** Where this CLI's worker source lives under `root`: one directory per distinct source. */
function functionsWorkerDir(root: string = cacheRoot()): string {
  const files = Object.entries(FUNCTIONS_WORKER_SOURCE).sort(([a], [b]) => a.localeCompare(b))
  const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 16)
  return join(root, "functions-worker", hash)
}

/** Writes the worker's files under `root` (the CLI's cache by default) and returns its main.ts. */
export function installFunctionsWorker(root?: string): string {
  const dir = functionsWorkerDir(root)
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(FUNCTIONS_WORKER_SOURCE)) writeIfChanged(join(dir, name), text)
  return join(dir, "main.ts")
}

/**
 * Writes `text` to `path` unless it already holds it. Through a temporary file and a rename, so a
 * Deno another serve has running never reads a half-written module.
 */
function writeIfChanged(path: string, text: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return
  const temporary = `${path}.${uniqueFileToken()}.tmp`
  writeFileSync(temporary, text, "utf8")
  renameSync(temporary, path)
}

/** The routes the worker serves from `hooksDir`, each as `hooks/<name>`, as it routes them. */
function hookRoutes(hooksDir: string): string[] {
  return discoverHandlersInDir(hooksDir).map((hook) => `hooks/${hook.name}`)
}

/**
 * Every route a local worker serves: the functions in `functionsDir`, then the hooks in `hooksDir`.
 * Throws when a function's name is one the control plane would refuse.
 */
export function localWorkerRoutes(functionsDir: string | undefined, hooksDir: string): string[] {
  const functions = functionsDir === undefined ? [] : discoverTsFunctionsInDir(functionsDir).map((fn) => fn.name)
  return [...functions, ...hookRoutes(hooksDir)]
}

/** {@link localWorkerRoutes}, ending the command with why when a function's name would be refused. */
export function localWorkerRoutesOrExit(functionsDir: string | undefined, hooksDir: string): string[] {
  try {
    return localWorkerRoutes(functionsDir, hooksDir)
  } catch (err: unknown) {
    if (err instanceof InvalidFunctionNameError) fatalError(err.message)
    throw err
  }
}

/** Where native dev writes the entry its server runs Deno on. */
export function devFunctionsEntryPath(cwd: string): string {
  return join(resolve(cwd, ".supatype"), "functions-worker.ts")
}

/**
 * The entry native dev's server runs: an import of the worker, and the routes (functions and
 * hooks) it found. The server runs Deno with a fixed `--watch` on this file, which reloads when a
 * file the worker imported changes; a function or hook added later was imported by nothing, so the
 * routes are rewritten when the set changes, and that change is what makes Deno reload and find it.
 */
export function devFunctionsEntrySource(routes: readonly string[], workerMain: string): string {
  return [
    "// Written by supatype dev, do not edit. Runs packages/functions-worker, as the deployed image does.",
    `// Routes: ${routes.join(", ")}`,
    `import ${JSON.stringify(pathToFileURL(workerMain).href)}`,
    "",
  ].join("\n")
}

/** Writes {@link devFunctionsEntrySource} to {@link devFunctionsEntryPath} and returns that path. */
export function writeDevFunctionsEntry(cwd: string, routes: readonly string[], workerMain: string): string {
  const path = devFunctionsEntryPath(cwd)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, devFunctionsEntrySource(routes, workerMain), "utf8")
  return path
}

/**
 * `deno run` arguments for `functions serve`: the worker under `--watch`, which reloads when a file
 * it imported changes, also watching `watchDirs`, so a function added while it serves is found.
 */
export function functionsServeDenoArgs(
  workerMain: string,
  watchDirs: readonly string[],
  envFileArgs: readonly string[],
): string[] {
  const watch = watchDirs.length > 0 ? `--watch=${watchDirs.join(",")}` : "--watch"
  return ["run", "--allow-net", "--allow-env", "--allow-read", watch, ...envFileArgs, workerMain]
}

/** The project a local worker serves: its config, its functions directory and its key file. */
export interface FunctionsWorkerProject {
  cwd: string
  config: SupatypeProjectConfig
  functionsDir: string
  /** The service-role key file; without one no function is given the key. */
  keyPath: string | undefined
}

/**
 * The worker's environment for `project`, as self-host compose gives it to the image: functions
 * and hooks roots, the project ref its log lines carry, and the routes `functions.serviceRole`
 * grants the key. The key file stands in for the key itself, which a `--watch` reload would
 * otherwise not find again. The shared env file is left to the worker's own default,
 * `<functions root>/.env.local`.
 */
export function functionsWorkerEnv(project: FunctionsWorkerProject): Record<string, string> {
  const { cwd, config, keyPath } = project
  return {
    SUPATYPE_FUNCTIONS_ROOT: project.functionsDir,
    SUPATYPE_HOOKS_ROOT: hooksPathFromProject(config, cwd),
    SUPATYPE_PROJECT_REF: config.project.name,
    SUPATYPE_SERVICE_ROLE_ROUTES: serviceRoleRoutes(config).join(","),
    ...(keyPath !== undefined && { SUPATYPE_SERVICE_ROLE_KEY_FILE: keyPath }),
  }
}
