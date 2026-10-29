/**
 * Asking the Docker CLI something without waiting on it for long.
 *
 * `init -y` asked Docker four things one after another (`ps`, `inspect`, `version`, `info`), each a
 * blocking spawn with no limit: on a loaded machine `docker info` alone took 14 seconds, and a
 * paused Docker Desktop can leave it hanging. These run asynchronously, side by side, and each
 * gives up after a short limit, after which the caller treats Docker as having said nothing.
 */
import { execFile } from "node:child_process"

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
}

/** Runs `docker <args>`, killed after `timeoutMs`; injectable so tests can stand in a Docker that hangs. */
export type DockerRunner = (args: readonly string[], opts: { shell: boolean; timeoutMs: number }) => Promise<DockerAnswer>

/** How long `init` waits on any one Docker question. */
export const DOCKER_PROBE_TIMEOUT_MS = 5_000

const runDocker: DockerRunner = (args, { shell, timeoutMs }) =>
  new Promise((resolve) => {
    const options = { encoding: "utf8" as const, windowsHide: true, shell }
    const child = execFile("docker", [...args], options, (err, stdout, stderr) => {
      clearTimeout(timer)
      const code = err !== null && "code" in err ? err.code : undefined
      resolve({
        status: err === null ? 0 : typeof code === "number" ? code : null,
        stdout,
        stderr,
        timedOut: false,
        missing: code === "ENOENT",
      })
    })
    // Past the limit the call is abandoned, and nothing of it may keep the CLI from exiting: under a
    // shell, killing the shell can leave docker holding the pipes open.
    const timer = setTimeout(() => {
      child.kill()
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.unref()
    }, timeoutMs)
    timer.unref()
  })

/**
 * `docker <args>`, answered within `timeoutMs` or reported as timed out. The limit is kept here,
 * not left to the runner, so a runner that never settles cannot hold the caller either.
 */
export function askDocker(
  args: readonly string[],
  opts: { shell?: boolean; timeoutMs?: number; runner?: DockerRunner } = {},
): Promise<DockerAnswer> {
  const timeoutMs = opts.timeoutMs ?? DOCKER_PROBE_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<DockerAnswer>((resolve) => {
    timer = setTimeout(() => resolve({ status: null, stdout: "", stderr: "", timedOut: true, missing: false }), timeoutMs)
    timer.unref()
  })
  const answer = (opts.runner ?? runDocker)(args, { shell: opts.shell ?? false, timeoutMs })
  return Promise.race([answer, timedOut]).finally(() => clearTimeout(timer))
}
