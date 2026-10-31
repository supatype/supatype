/**
 * What the functions and hooks routes share about the stack's functions worker: where its functions,
 * hooks and env live, where a function's or hook's directory may be, and keeping the worker serving
 * what is on disk, which it loads when it starts (it runs with no --watch).
 *
 * Whether the worker is stale is decided by content, not clocks: a hash of everything it loads once,
 * at start (the source files under the functions and hooks roots, the manifest's hook and validator
 * maps), is recorded when a restart succeeds, and a deploy restarts it when the hash differs or when
 * a restart failed since. File times could not say: a hook edited in the project's own checkout, a
 * manifest changed by someone else, clock skew and rsync-kept mtimes all left the worker serving old
 * code.
 *
 * Env values are not in it. The worker reads every env file on each call (the function env file
 * `functions env set` writes, `.env.local`, `.env.<function>.local`), so a change is seen on the
 * next call, and a restart for one only took every function down (round 6b, N28a).
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { FUNCTION_NAME_RULE, FUNCTIONS_WORKER_STOP_GRACE_SECONDS, isFunctionName, parseJsonObject } from "@supatype/shared"
import { badRequest, HttpError } from "./http.js"
import { projectRoot } from "./project.js"

export function functionsRoot(): string {
  return process.env["SUPATYPE_FUNCTIONS_ROOT"] ?? join(projectRoot(), "functions")
}

export function hooksRoot(): string {
  return process.env["SUPATYPE_HOOKS_ROOT"] ?? join(projectRoot(), "hooks")
}

export function functionEnvPath(): string {
  return join(projectRoot(), ".supatype", "function-env.json")
}

export function manifestPath(): string {
  return join(projectRoot(), ".supatype", "manifest.json")
}

function composeProject(): string {
  return process.env["COMPOSE_PROJECT_NAME"] ?? "supatype-project"
}

/** One `docker` call: its exit status (null when it could not start) and what it printed. */
export interface DockerOutcome {
  status: number | null
  stdout: string
  stderr: string
}

export type DockerRunner = (args: readonly string[]) => Promise<DockerOutcome>

/** `docker <args>`, without holding the event loop. */
const runDocker: DockerRunner = (args) =>
  new Promise((done) => {
    const child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
    child.on("error", (err) => done({ status: null, stdout, stderr: err.message }))
    child.on("close", (status) => done({ status, stdout, stderr }))
  })

let docker: DockerRunner = runDocker

/** @internal Tests: Docker answered in process. */
export function setDockerRunnerForTests(runner: DockerRunner | null): void {
  docker = runner ?? runDocker
}

/** The control plane's record of the worker, in the project's .supatype so a restart of it keeps them. */
function statePath(name: "restart-owed" | "loaded"): string {
  return join(projectRoot(), ".supatype", `functions-worker-${name}`)
}

function readState(name: "restart-owed" | "loaded"): string | null {
  return existsSync(statePath(name)) ? readFileSync(statePath(name), "utf8").trim() : null
}

function writeState(name: "restart-owed" | "loaded", value: string | null): void {
  if (value === null) {
    rmSync(statePath(name), { force: true })
    return
  }
  mkdirSync(dirname(statePath(name)), { recursive: true })
  writeFileSync(statePath(name), `${value}\n`, "utf8")
}

/** Sources the worker imports: a handler and the modules and JSON it imports. */
const SOURCE_FILE = /\.(?:ts|tsx|mts|js|jsx|mjs|json)$/

/**
 * Whether the worker loads the file `name` at start: a source, never a dotfile. The env files
 * beside the functions are dotfiles, and the worker reads them on each call instead.
 */
function workerLoads(name: string): boolean {
  return !name.startsWith(".") && SOURCE_FILE.test(name)
}

/**
 * The files under `root` the worker loads, by path relative to it, sorted so the hash does not
 * depend on the order read. Dot directories (.git, an editor's) are skipped, and so is anything that
 * is not a source file: a README or an editor's temp file changes no code the worker runs.
 */
async function loadedFilesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile() && workerLoads(entry.name))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .filter((path) => !path.split(/[\\/]/).slice(0, -1).some((dir) => dir.startsWith(".")))
    .sort()
}

/** The text of `path`, or "" when there is none. */
const textOf = (path: string): Promise<string> => readFile(path, "utf8").catch(() => "")

/** A hash of everything the worker loads; see the file's comment. */
export async function workerContentHash(): Promise<string> {
  const hash = createHash("sha256")
  for (const [label, root] of [["functions", resolve(functionsRoot())], ["hooks", resolve(hooksRoot())]] as const) {
    for (const file of await loadedFilesUnder(root)) {
      hash.update(`${label}:${file}\0`).update(await readFile(join(root, file))).update("\0")
    }
  }
  const manifest = parseJsonObject(await textOf(manifestPath()))
  const maps = manifest.ok ? { hooks: manifest.value["hooks"], validators: manifest.value["validators"] } : {}
  hash.update(`maps:${JSON.stringify(maps)}`)
  return hash.digest("hex")
}

/** One worker container, and whether it runs. */
interface WorkerContainer {
  id: string
  running: boolean
}

/** The worker's containers, running or exited, from one `docker ps -a`; or why Docker could not list them. */
async function workerContainers(): Promise<{ containers: WorkerContainer[] } | { failed: string }> {
  const found = await docker([
    "ps", "-a",
    "--filter", `label=com.docker.compose.project=${composeProject()}`,
    "--filter", "label=com.docker.compose.service=functions-worker",
    "--format", "{{.ID}} {{.State}}",
  ])
  if (found.status !== 0) return { failed: found.stderr.trim() || `docker exited ${String(found.status)}` }
  const containers = found.stdout.split("\n").map((line) => line.trim().split(/\s+/))
    .filter(([id]) => id !== undefined && id !== "")
    .map(([id = "", state = ""]) => ({ id, running: state === "running" }))
  return { containers }
}

/**
 * `docker <verb> <ids>`, throwing a 502 that says the worker did not `what` and why. A restart gives
 * the worker the stop grace compose gives it, so its drain is not cut off.
 */
async function dockerOrThrow(verb: "restart" | "start", ids: readonly string[], what: string): Promise<void> {
  const grace = verb === "restart" ? ["-t", String(FUNCTIONS_WORKER_STOP_GRACE_SECONDS)] : []
  const ran = await docker([verb, ...grace, ...ids])
  if (ran.status !== 0) {
    throw new HttpError(502, "worker_restart_failed", `The files are written, but the functions worker did not ${what}: ${ran.stderr.trim() || `docker exited ${String(ran.status)}`}`)
  }
}

/** What a deploy did to the worker: whether it restarted or started it, and a warning when Docker could not be asked. */
export interface WorkerCheck {
  restarted: boolean
  warning?: string
}

/**
 * Keeps the functions worker serving what is on disk, and running; one `docker ps -a` a deploy. It
 * is restarted when what it loads differs from what it last loaded or a restart is owed (see the
 * file's comment), and a stopped one whose content is current is started. Found by the labels
 * compose gives it and restarted with plain `docker`: the control-plane image has Docker without
 * the compose plugin (local test round 5).
 *
 * A restart or start that is needed and fails, Docker unreachable included, throws a 502 naming
 * why, after the files are written; a restart is then owed to the next deploy. A deploy that needed
 * nothing done while Docker could not be reached answers with a warning: the worker already serves it.
 */
export async function ensureWorkerCurrent(): Promise<WorkerCheck> {
  const content = await workerContentHash()
  const stale = content !== readState("loaded") || readState("restart-owed") !== null
  if (stale) writeState("restart-owed", new Date().toISOString())
  const listed = await workerContainers()
  if ("failed" in listed) {
    if (!stale) return { restarted: false, warning: `Docker could not be asked whether the functions worker is running: ${listed.failed}` }
    throw new HttpError(502, "worker_restart_failed", `The files are written, but Docker could not list the functions worker: ${listed.failed}`)
  }
  if (listed.containers.length === 0) {
    throw new HttpError(502, "worker_restart_failed", `The files are written, but no functions-worker container exists for compose project ${composeProject()}; is the stack up?`)
  }
  if (stale) return restartWorker(listed.containers, content)
  const stopped = listed.containers.filter((c) => !c.running).map((c) => c.id)
  if (stopped.length > 0) await dockerOrThrow("start", stopped, "start")
  return { restarted: stopped.length > 0 }
}

/** The warning a route adds to its answer, when there is one. */
export function warningOf(check: WorkerCheck): { warning?: string } {
  return check.warning === undefined ? {} : { warning: check.warning }
}

/** Restarts every worker container (which also starts one that has exited) and records `content` as loaded. */
async function restartWorker(containers: readonly WorkerContainer[], content: string): Promise<WorkerCheck> {
  await dockerOrThrow("restart", containers.map((c) => c.id), "restart")
  writeState("loaded", content)
  writeState("restart-owed", null)
  return { restarted: true }
}

/**
 * The directory of the function or hook `name` under `root`: refused (400) unless the name passes
 * the function-name rule the CLI also checks, and the path is a direct child of `root`. The second
 * check is a backstop for the first: whatever the rule lets through, nothing outside `root` is ever
 * written or removed.
 */
export function childDir(root: string, name: unknown, kind: "function" | "hook"): string {
  if (!isFunctionName(name)) throw badRequest(`Invalid ${kind} name ${JSON.stringify(name)}: ${FUNCTION_NAME_RULE}`)
  const base = resolve(root)
  const dir = resolve(base, name)
  if (dirname(dir) !== base) throw badRequest(`The ${kind} name ${JSON.stringify(name)} resolves outside the ${kind}s directory`)
  return dir
}
