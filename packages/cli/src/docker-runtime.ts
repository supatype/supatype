/**
 * Docker daemon availability: used before `docker compose` and other docker CLI calls.
 */

import { platform } from "node:os"
import { endDevSession, getActiveDevSession } from "./dev-session.js"
import {
  askDocker,
  askDockerSync,
  DOCKER_PROBE_TIMEOUT_MS,
  DOCKER_QUERY_TIMEOUT_MS,
  type DockerAnswer,
  type DockerRunner,
} from "./docker-exec.js"
import { isInteractive } from "./ui/interactive.js"
import { error, plain, progress } from "./ui/messages.js"
import { p, printLogo } from "./ui/prompts.js"

export type DockerDaemonProbe =
  | { ok: true }
  | { ok: false; reason: "cli_missing" | "daemon_unavailable" | "daemon_unresponsive"; detail?: string }

export type DockerBrandOptions = {
  intro: string
}

export type DockerReportOptions = {
  /** Logo + Clack intro before the error (e.g. `supatype dev` entry). */
  brand?: DockerBrandOptions
}

/** One docker call's result, as the verdicts below read it. */
type ProbeAnswer = Omit<DockerAnswer, "timedOut">

const VERSION_ARGS = ["version", "--format", "{{.Client.Version}}"]

/**
 * A daemon that did not answer within `timeoutMs`. Not proof that it is down: a Docker still busy
 * with the last command (a `compose up` that failed on a port clash, say) can be slow to answer
 * `docker info` and quick again a moment later (issue 33).
 */
function silentDaemon(timeoutMs: number): DockerDaemonProbe {
  return { ok: false, reason: "daemon_unresponsive", detail: `Docker did not answer within ${Math.round(timeoutMs / 1000)}s` }
}

/** Whether `probe` is a silence, which is asked about again until the wait is spent. */
function isSilence(probe: DockerDaemonProbe): boolean {
  return !probe.ok && probe.reason === "daemon_unresponsive"
}

/**
 * How long in all a command waits on a Docker that is running but slow to answer, when
 * `SUPATYPE_DOCKER_TIMEOUT` does not say. 0.9.1 release test, FF20: dev gave up after two 5 s asks,
 * nine times on a machine carrying 70 to 90 containers, on a Docker that answered the next attempt;
 * on such a machine `docker info` alone has taken 14 s (docker-exec.ts). A minute is four of those,
 * and as long as a command run in a container is given (DOCKER_EXEC_TIMEOUT_MS).
 */
export const DOCKER_WAIT_MS = 60_000

/** The setting that changes {@link DOCKER_WAIT_MS}, in whole seconds. */
const WAIT_SETTING = "SUPATYPE_DOCKER_TIMEOUT"

/** How long in all to wait on a slow Docker: `SUPATYPE_DOCKER_TIMEOUT` seconds, else {@link DOCKER_WAIT_MS}. */
export function dockerWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const text = env[WAIT_SETTING]?.trim() ?? ""
  return /^[1-9]\d*$/.test(text) ? Number(text) * 1000 : DOCKER_WAIT_MS
}

/**
 * How a probe waits on a slow Docker. The first ask is short, so a person hears within
 * {@link DOCKER_PROBE_TIMEOUT_MS} that Docker is being waited for; each later ask gets
 * {@link DOCKER_QUERY_TIMEOUT_MS}, long enough for the slowest answer seen, since an ask given up on
 * too soon would never see it. Injectable so tests need not wait.
 */
export interface DockerWait {
  /** The whole wait, across every ask. */
  totalMs: number
  firstAskMs: number
  askMs: number
  now: () => number
}

function dockerWait(given: Partial<DockerWait>): DockerWait {
  return { totalMs: dockerWaitMs(), firstAskMs: DOCKER_PROBE_TIMEOUT_MS, askMs: DOCKER_QUERY_TIMEOUT_MS, now: Date.now, ...given }
}

/** Said once, after the first silence: a person sees why the command has not moved on, and how to wait longer. */
function announceWait(totalMs: number): void {
  progress(`Waiting for Docker to answer (up to ${Math.round(totalMs / 1000)}s; ${WAIT_SETTING} sets how long)...`)
}

/**
 * The time limit of each ask a probe makes while it waits ({@link DockerWait}): the first short,
 * each later one capped by what is left of the wait. Said once, after the first silence, since
 * only a silent ask leads to another. One policy, so the sync and async probes cannot drift.
 */
function* askLimits(wait: DockerWait): Generator<number, void, void> {
  const deadline = wait.now() + wait.totalMs
  yield Math.min(wait.firstAskMs, wait.totalMs)
  announceWait(wait.totalMs)
  for (let left = deadline - wait.now(); left > 0; left = deadline - wait.now()) yield Math.min(wait.askMs, left)
}

/**
 * Returns whether the Docker CLI is on PATH and the daemon accepts connections. Synchronous because
 * `requireDockerDaemon` guards `runDockerCompose`, which every compose command calls synchronously.
 * A silence is asked about again, each ask limited to what is left of the wait, until Docker answers
 * or the wait is spent ({@link DockerWait}). A Docker that says it cannot be reached is not a
 * silence, so it fails at once.
 */
export function probeDockerDaemon(given: Partial<DockerWait> = {}): DockerDaemonProbe {
  const wait = dockerWait(given)
  const ask = syncProber()
  for (const limit of askLimits(wait)) {
    const probe = ask(limit)
    if (!isSilence(probe)) return probe
  }
  return silentDaemon(wait.totalMs)
}

/**
 * One probe after another, keeping the first `docker version` that passed: the client does not
 * change between asks, so a retry repeats only `docker info`, the call a busy daemon is slow on.
 */
function syncProber(): (timeoutMs: number) => DockerDaemonProbe {
  let version: ProbeAnswer | undefined
  return (timeoutMs) => {
    const ask = { shell: process.platform === "win32", timeoutMs }
    if (version === undefined) {
      const answer = askDockerSync(VERSION_ARGS, ask)
      if (answer.timedOut) return silentDaemon(timeoutMs)
      const early = verdictFromVersion(answer)
      if (early !== null) return early
      version = answer
    }
    const info = askDockerSync(["info"], ask)
    return info.timedOut ? silentDaemon(timeoutMs) : verdictFromInfo(info, version)
  }
}

/** {@link syncProber} for the async probes, `docker version` and `docker info` asked side by side. */
function asyncProber(runner?: DockerRunner): (timeoutMs?: number) => Promise<DockerDaemonProbe> {
  let version: DockerAnswer | undefined
  return async (timeoutMs) => {
    const ask = { shell: process.platform === "win32", ...(runner && { runner }), ...(timeoutMs !== undefined && { timeoutMs }) }
    const [versionAnswer, info] = await Promise.all([version ?? askDocker(VERSION_ARGS, ask), askDocker(["info"], ask)])
    const silent = silentDaemon(timeoutMs ?? DOCKER_PROBE_TIMEOUT_MS)
    if (versionAnswer.timedOut) return silent
    // `version` first: a paused Docker Desktop says so there, while its `info` hangs.
    const early = verdictFromVersion(versionAnswer)
    if (early !== null) return early
    version = versionAnswer
    return info.timedOut ? silent : verdictFromInfo(info, versionAnswer)
  }
}

/**
 * {@link probeDockerDaemon} for `init`, which must not wait on Docker: `docker version` and
 * `docker info` are asked side by side, each given up on after `timeoutMs` (docker-exec.ts). A
 * daemon that does not answer in that time is reported as such.
 */
export function probeDockerDaemonAsync(runner?: DockerRunner, timeoutMs?: number): Promise<DockerDaemonProbe> {
  return asyncProber(runner)(timeoutMs)
}

/**
 * {@link probeDockerDaemonAsync}, waiting on a silence as {@link probeDockerDaemon} does. For a
 * command that is about to use Docker; `init` only warns, so it asks once and does not wait.
 */
export async function probeDockerDaemonRetrying(runner?: DockerRunner, given: Partial<DockerWait> = {}): Promise<DockerDaemonProbe> {
  const wait = dockerWait(given)
  const ask = asyncProber(runner)
  for (const limit of askLimits(wait)) {
    const probe = await ask(limit)
    if (!isSilence(probe)) return probe
  }
  return silentDaemon(wait.totalMs)
}

/** The verdict `docker version` alone gives, or null when it takes `docker info` to tell. */
function verdictFromVersion(version: ProbeAnswer): DockerDaemonProbe | null {
  if (version.missing) return { ok: false, reason: "cli_missing" }
  const versionStderr = version.stderr.trim()
  const versionDetail = `${versionStderr}${version.stdout}`.trim()
  // No client version: CLI missing or broken.
  if (!version.stdout.trim()) {
    return { ok: false, reason: "cli_missing", ...(versionDetail ? { detail: versionDetail } : {}) }
  }
  // Client is present but daemon refused (paused/stopped). `docker info` can hang
  // while paused on Docker Desktop, use the version stderr and skip info.
  if (version.status !== 0 && versionStderr) {
    return { ok: false, reason: "daemon_unavailable", detail: versionStderr }
  }
  return null
}

function verdictFromInfo(info: ProbeAnswer, version: ProbeAnswer): DockerDaemonProbe {
  if (info.status === 0) return { ok: true }
  const detail = `${info.stderr}${info.stdout}`.trim() || `${version.stderr.trim()}${version.stdout}`.trim()
  return { ok: false, reason: "daemon_unavailable", ...(detail ? { detail } : {}) }
}

type DockerFailure = Extract<DockerDaemonProbe, { ok: false }>

/**
 * What the docker CLI says when nothing is listening: the Unix socket's "Cannot connect", and on
 * Windows "error during connect" (older) or "failed to connect to the docker API" (Docker 28 on).
 */
const CANNOT_CONNECT = /cannot connect to the docker daemon|error during connect|failed to connect to the docker api|is the docker daemon running/i

/** How a daemon the CLI could reach but not use is described, from what the docker CLI said. */
function daemonState(probe: DockerFailure): "paused" | "not_running" | "failed" {
  const detail = probe.detail ?? ""
  if (/paused/i.test(detail)) return "paused"
  return CANNOT_CONNECT.test(detail) ? "not_running" : "failed"
}

function shouldShowDockerDetail(probe: DockerFailure): boolean {
  if (!probe.detail || probe.reason === "daemon_unresponsive") return false
  // Skip raw daemon stderr when we already print a clearer hint.
  return probe.reason !== "daemon_unavailable" || daemonState(probe) === "failed"
}

const DAEMON_HEADLINES = {
  paused: "Docker is installed but Docker Desktop is paused.",
  not_running: "Docker is installed but the daemon is not running.",
  failed: "Docker is installed but `docker info` failed.",
} as const

function dockerUnavailableHeadline(probe: DockerFailure): string {
  if (probe.reason === "cli_missing") return "Docker is not installed or not on your PATH."
  if (probe.reason === "daemon_unresponsive") return "Docker did not answer in time."
  return DAEMON_HEADLINES[daemonState(probe)]
}

/** The first hint: what to do about this failure. */
function dockerRemedy(probe: DockerFailure): string {
  if (probe.reason === "cli_missing") {
    return "Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or add the docker CLI to PATH."
  }
  if (probe.reason === "daemon_unresponsive") {
    const why = `${probe.detail ?? "Docker did not answer"}. It may be busy (starting up, or finishing another command)`
    // Also shown by `init`, which asks once and only warns: the setting is for the commands that wait.
    const setting = `Commands that use Docker wait for it up to ${WAIT_SETTING} seconds (${DOCKER_WAIT_MS / 1000} when unset).`
    return `${why}: try again in a moment. ${setting}`
  }
  if (daemonState(probe) === "paused") return "Unpause Docker Desktop from the whale menu or Dashboard, then try again."
  if (platform() === "win32" || platform() === "darwin") return "Start Docker Desktop, then try again."
  return "Start the Docker daemon (e.g. sudo systemctl start docker), then try again."
}

function dockerUnavailableHints(probe: DockerFailure): string[] {
  const hints: string[] = [dockerRemedy(probe)]

  // A Docker that is only slow is not a reason to stop using it.
  if (probe.reason !== "daemon_unresponsive") {
    hints.push('To develop without Docker, set provider: "native" in supatype.config.ts.')
  }

  if (shouldShowDockerDetail(probe)) {
    const firstLine = probe.detail!.split(/\r?\n/).find((line) => line.trim().length > 0)
    if (firstLine) hints.push(`docker: ${firstLine.trim()}`)
  }

  return hints
}

/** @deprecated Tests only: use `reportDockerUnavailable`. */
export function formatDockerUnavailableMessage(
  probe: Extract<DockerDaemonProbe, { ok: false }>,
): string {
  const lines: string[] = [dockerUnavailableHeadline(probe), ...dockerUnavailableHints(probe)]
  return lines.join("\n")
}

/** Print Docker-unavailable guidance via the shared CLI message layer. */
export function reportDockerUnavailable(
  probe: Extract<DockerDaemonProbe, { ok: false }>,
  opts?: DockerReportOptions,
): void {
  if (opts?.brand && isInteractive()) {
    printLogo()
    p.intro(opts.brand.intro)
  }

  const headline = dockerUnavailableHeadline(probe)
  const hints = dockerUnavailableHints(probe)

  error(headline)

  if (isInteractive()) {
    p.note(hints.join("\n\n"))
    return
  }

  for (const hint of hints) {
    plain()
    plain(`  ${hint}`)
  }
}

/** Exit 1 with a friendly message when Docker is not usable. */
export function requireDockerDaemon(opts?: DockerReportOptions): void {
  exitUnlessDaemon(probeDockerDaemon(), opts)
}

/** {@link requireDockerDaemon} without blocking, so the dev dashboard keeps drawing while it asks. */
export async function requireDockerDaemonAsync(opts?: DockerReportOptions): Promise<void> {
  exitUnlessDaemon(await probeDockerDaemonRetrying(), opts)
}

function exitUnlessDaemon(probe: DockerDaemonProbe, opts?: DockerReportOptions): void {
  if (probe.ok) return
  // Dev TUI patches console, restore stderr before printing a fatal message.
  if (getActiveDevSession()) {
    endDevSession()
  }
  reportDockerUnavailable(probe, opts)
  process.exit(1)
}
