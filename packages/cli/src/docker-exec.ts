/**
 * Every call the CLI makes to the Docker CLI, each with a limit on how long it may take.
 *
 * `init -y` asked Docker four things one after another (`ps`, `inspect`, `version`, `info`), each a
 * blocking spawn with no limit: on a loaded machine `docker info` alone took 14 seconds, and a
 * paused Docker Desktop can leave it hanging. The rest of the CLI spawned Docker the same way from
 * some thirty places, most with no limit, so one hung daemon held whichever command met it first.
 *
 * So nothing outside this file spawns `docker`. {@link askDocker} is the default: asynchronous, and
 * given up on after its limit. {@link askDockerSync} is for a caller that cannot wait on a promise,
 * with the same limit enforced by the spawn. {@link spawnDocker} is for the two calls meant to
 * outlive any limit, each ended by its owner: `logs --follow`, and the psql session that holds the
 * schema-push lock. A call a person watches and can stop, `compose up` or `docker build`, may pass
 * {@link NO_DOCKER_LIMIT}: a slow image pull is not a hang, and killing the client mid-pull leaves
 * the daemon pulling anyway.
 */
import { execFile, spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process"

/** What one `docker` call answered. */
export interface DockerAnswer {
  /** Exit status; null when the call did not finish (timed out, or could not start). */
  status: number | null
  stdout: string
  stderr: string
  /** True when the limit ran out first. */
  timedOut: boolean
  /** True when there is no `docker` to run. */
  missing: boolean
  /** Why the spawn itself failed, when it did. */
  error?: string
}

/** No limit: only for a call a person watches and can stop, or one its owner ends (module comment). */
export const NO_DOCKER_LIMIT = "none"

/** How long a call may take: milliseconds, or {@link NO_DOCKER_LIMIT}. */
export type DockerLimit = number | typeof NO_DOCKER_LIMIT

/** How long `init` waits on any one Docker question. */
export const DOCKER_PROBE_TIMEOUT_MS = 5_000

/** A question Docker answers from its own state: `ps`, `inspect`, `volume`, `network`, `config`, `rm`, `stop`, `logs --tail`. */
export const DOCKER_QUERY_TIMEOUT_MS = 15_000

/** A command run in a container that already exists: `exec psql`, `pg_isready`. */
export const DOCKER_EXEC_TIMEOUT_MS = 60_000

/** A call that may pull an image first: `run`, a `pull` of one service, `manifest inspect` against a slow registry. */
export const DOCKER_PULL_TIMEOUT_MS = 600_000

/** Where and how a call runs. */
export interface DockerCall {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Written to the call's stdin. */
  input?: string
  /** Through a shell: Docker Desktop's shim on Windows is found only that way. */
  shell?: boolean
  timeoutMs?: DockerLimit
}

/** Runs `docker <args>` within `timeoutMs`; injectable so tests can stand in a Docker that hangs. */
export type DockerRunner = (
  args: readonly string[],
  call: DockerCall & { shell: boolean; timeoutMs: DockerLimit },
) => Promise<DockerAnswer>

/** The errno code a spawn failed with, when it did. */
function errnoCode(err: Error | null | undefined): string | undefined {
  return err !== null && err !== undefined && "code" in err && typeof err.code === "string" ? err.code : undefined
}

/** The working directory and environment of a call, as spawn options. */
function callPlace(call: DockerCall): { cwd?: string; env?: NodeJS.ProcessEnv } {
  return { ...(call.cwd !== undefined && { cwd: call.cwd }), ...(call.env !== undefined && { env: call.env }) }
}

const runDocker: DockerRunner = (args, call) =>
  new Promise((resolve) => {
    const options = { encoding: "utf8" as const, windowsHide: true, shell: call.shell, maxBuffer: 64 * 1024 * 1024, ...callPlace(call) }
    const child = execFile("docker", [...args], options, (err, stdout, stderr) => {
      if (timer !== undefined) clearTimeout(timer)
      const code = err !== null && "code" in err ? err.code : undefined
      resolve({
        status: err === null ? 0 : typeof code === "number" ? code : null,
        stdout,
        stderr,
        timedOut: false,
        missing: code === "ENOENT",
        ...(err !== null && typeof code !== "number" && { error: err.message }),
      })
    })
    if (call.input !== undefined) child.stdin?.end(call.input)
    const timer = call.timeoutMs === NO_DOCKER_LIMIT ? undefined : setTimeout(() => abandon(child), call.timeoutMs)
    timer?.unref()
  })

/**
 * Past its limit a call is abandoned, and nothing of it may keep the CLI from exiting: under a
 * shell, killing the shell can leave docker holding the pipes open.
 */
function abandon(child: ChildProcess): void {
  child.kill()
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref()
}

const TIMED_OUT: DockerAnswer = { status: null, stdout: "", stderr: "", timedOut: true, missing: false }

/**
 * `docker <args>`, answered within its limit (by default {@link DOCKER_PROBE_TIMEOUT_MS}) or reported
 * as timed out. The limit is kept here, not left to the runner, so a runner that never settles
 * cannot hold the caller either.
 */
export function askDocker(args: readonly string[], opts: DockerCall & { runner?: DockerRunner } = {}): Promise<DockerAnswer> {
  const { runner, ...call } = opts
  const timeoutMs = call.timeoutMs ?? DOCKER_PROBE_TIMEOUT_MS
  const answer = (runner ?? runDocker)(args, { ...call, shell: call.shell ?? false, timeoutMs })
  if (timeoutMs === NO_DOCKER_LIMIT) return answer
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<DockerAnswer>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
    timer.unref()
  })
  return Promise.race([answer, timedOut]).finally(() => clearTimeout(timer))
}

/** How a synchronous call's output is handled: captured, streamed to the terminal, or dropped. */
export type DockerStdio = "pipe" | "inherit" | "ignore"

/** {@link askDocker} for a caller that cannot wait on a promise; the limit is required. */
export function askDockerSync(args: readonly string[], call: DockerCall & { timeoutMs: DockerLimit; stdio?: DockerStdio }): DockerAnswer {
  const result = spawnSync("docker", [...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: call.stdio ?? "pipe",
    ...callPlace(call),
    ...(call.shell === true && { shell: true }),
    ...(call.input !== undefined && { input: call.input }),
    ...(call.timeoutMs !== NO_DOCKER_LIMIT && { timeout: call.timeoutMs, killSignal: "SIGKILL" as const }),
  })
  const code = errnoCode(result.error)
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: code === "ETIMEDOUT",
    missing: code === "ENOENT",
    ...(result.error !== undefined && { error: result.error.message }),
  }
}

/**
 * A `docker` process its caller owns and ends: `logs --follow`, or the session holding the
 * schema-push lock. No limit, by design: each runs until its owner stops it (module comment).
 */
export function spawnDocker(args: readonly string[], options: SpawnOptions): ChildProcess {
  return spawn("docker", [...args], options)
}

/** Whether Docker has `image` on this machine. */
export function dockerHasImage(image: string): boolean {
  return askDockerSync(["image", "inspect", image], { stdio: "ignore", timeoutMs: DOCKER_QUERY_TIMEOUT_MS }).status === 0
}
