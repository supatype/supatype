/**
 * What the functions and hooks routes share about the stack's functions worker: where a function's
 * or hook's directory may be, and restarting the worker, which loads what it serves when it starts.
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { FUNCTION_NAME_RULE, isFunctionName } from "@supatype/shared"
import { badRequest, HttpError } from "./http.js"
import { projectRoot } from "./project.js"

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

/**
 * Marks a restart owed by one that failed, so the next deploy restarts the worker though it writes
 * nothing. A file in the project's .supatype, not memory: the control plane restarting in between
 * would otherwise forget, and the worker would keep serving old routes.
 */
function restartOwedPath(): string {
  return join(projectRoot(), ".supatype", "functions-worker-restart-owed")
}

/** Whether a restart failed since the last that worked: the worker may still serve old routes. */
export function workerRestartOwed(): boolean {
  return existsSync(restartOwedPath())
}

function owe(owed: boolean): void {
  if (!owed) {
    rmSync(restartOwedPath(), { force: true })
    return
  }
  mkdirSync(dirname(restartOwedPath()), { recursive: true })
  writeFileSync(restartOwedPath(), `${new Date().toISOString()}\n`, "utf8")
}

/** The functions-worker containers of this stack, stopped ones included, or why Docker could not list them. */
async function workerContainers(): Promise<{ listed: true; ids: string[] } | { listed: false; why: string }> {
  const found = await docker([
    "ps", "-a", "-q",
    "--filter", `label=com.docker.compose.project=${composeProject()}`,
    "--filter", "label=com.docker.compose.service=functions-worker",
  ])
  if (found.status !== 0) return { listed: false, why: found.stderr.trim() }
  return { listed: true, ids: found.stdout.split(/\s+/).filter((id) => id !== "") }
}

/**
 * When the worker last started, in milliseconds, or null when Docker cannot say (no container, or
 * no answer). A handler file written after it is one the worker has not loaded.
 */
export async function workerStartedAt(): Promise<number | null> {
  const found = await workerContainers()
  if (!found.listed || found.ids.length === 0) return null
  const inspected = await docker(["inspect", "-f", "{{.State.StartedAt}}", ...found.ids])
  if (inspected.status !== 0) return null
  const starts = inspected.stdout.split(/\s+/).filter((at) => at !== "").map((at) => Date.parse(at))
  return starts.length === 0 || starts.some(Number.isNaN) ? null : Math.min(...starts)
}

/**
 * Restarts the functions worker, which loads its functions and hooks when it starts. The container
 * is found by the labels compose gives it and restarted with plain `docker`: the control-plane image
 * has Docker without the compose plugin, so `docker compose -p ... restart` failed there, unreported,
 * and the worker kept serving its old routes (local test round 5). A restart that fails throws a 502
 * naming why, after the files are written, so the deploy is reported as failed and the next one
 * restarts the worker. Stopped containers are listed too (`-a`): `docker restart` starts a worker that
 * had exited, which `ps` alone never found, so every deploy failed. Asynchronous, so it holds no
 * other request to the control plane.
 */
export async function restartFunctionsWorker(): Promise<void> {
  const project = composeProject()
  const found = await workerContainers()
  owe(true)
  if (found.listed === false) {
    throw new HttpError(502, "worker_restart_failed", `The files are written, but Docker could not list the functions worker: ${found.why}`)
  }
  if (found.ids.length === 0) {
    throw new HttpError(502, "worker_restart_failed", `The files are written, but no functions-worker container exists for compose project ${project}; is the stack up?`)
  }
  const restarted = await docker(["restart", ...found.ids])
  if (restarted.status !== 0) {
    throw new HttpError(502, "worker_restart_failed", `The files are written, but the functions worker did not restart: ${restarted.stderr.trim() || `docker exited ${String(restarted.status)}`}`)
  }
  owe(false)
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
