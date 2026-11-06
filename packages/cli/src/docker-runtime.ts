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
import { error, plain } from "./ui/messages.js"
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

/** Whether `probe` is a silence, which is asked about once more before it is reported. */
function isSilence(probe: DockerDaemonProbe): boolean {
  return !probe.ok && probe.reason === "daemon_unresponsive"
}

/**
 * Returns whether the Docker CLI is on PATH and the daemon accepts connections. Synchronous because
 * `requireDockerDaemon` guards `runDockerCompose`, which every compose command calls synchronously;
 * each question is still given up on after {@link DOCKER_QUERY_TIMEOUT_MS}, and a silence is asked
 * about once more (see {@link silentDaemon}).
 */
export function probeDockerDaemon(): DockerDaemonProbe {
  const first = probeDockerDaemonOnce()
  return isSilence(first) ? probeDockerDaemonOnce() : first
}

function probeDockerDaemonOnce(): DockerDaemonProbe {
  const ask = { shell: process.platform === "win32", timeoutMs: DOCKER_QUERY_TIMEOUT_MS }
  const version = askDockerSync(VERSION_ARGS, ask)
  if (version.timedOut) return silentDaemon(DOCKER_QUERY_TIMEOUT_MS)
  const early = verdictFromVersion(version)
  if (early !== null) return early
  const info = askDockerSync(["info"], ask)
  return info.timedOut ? silentDaemon(DOCKER_QUERY_TIMEOUT_MS) : verdictFromInfo(info, version)
}

/**
 * {@link probeDockerDaemon} for `init`, which must not wait on Docker: `docker version` and
 * `docker info` are asked side by side, each given up on after `timeoutMs` (docker-exec.ts). A
 * daemon that does not answer in that time is reported as such.
 */
export async function probeDockerDaemonAsync(runner?: DockerRunner, timeoutMs?: number): Promise<DockerDaemonProbe> {
  const ask = { shell: process.platform === "win32", ...(runner && { runner }), ...(timeoutMs !== undefined && { timeoutMs }) }
  const [version, info] = await Promise.all([askDocker(VERSION_ARGS, ask), askDocker(["info"], ask)])
  const silent = silentDaemon(timeoutMs ?? DOCKER_PROBE_TIMEOUT_MS)
  if (version.timedOut) return silent
  // `version` first: a paused Docker Desktop says so there, while its `info` hangs.
  const early = verdictFromVersion(version)
  if (early !== null) return early
  return info.timedOut ? silent : verdictFromInfo(info, version)
}

/**
 * {@link probeDockerDaemonAsync}, asked once more after a silence, as {@link probeDockerDaemon} is.
 * For a command that is about to use Docker; `init` only warns, so it asks once and does not wait.
 */
export async function probeDockerDaemonRetrying(runner?: DockerRunner, timeoutMs?: number): Promise<DockerDaemonProbe> {
  const first = await probeDockerDaemonAsync(runner, timeoutMs)
  return isSilence(first) ? probeDockerDaemonAsync(runner, timeoutMs) : first
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
    return `${probe.detail ?? "Docker did not answer"}. It may be busy (starting up, or finishing another command): try again in a moment.`
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
