/**
 * Docker daemon availability: used before `docker compose` and other docker CLI calls.
 */

import { spawnSync } from "node:child_process"
import { platform } from "node:os"
import { endDevSession, getActiveDevSession } from "./dev-session.js"
import { askDocker, DOCKER_PROBE_TIMEOUT_MS, type DockerRunner } from "./docker-exec.js"
import { isInteractive } from "./ui/interactive.js"
import { error, plain } from "./ui/messages.js"
import { p, printLogo } from "./ui/prompts.js"

export type DockerDaemonProbe =
  | { ok: true }
  | { ok: false; reason: "cli_missing" | "daemon_unavailable"; detail?: string }

export type DockerBrandOptions = {
  intro: string
}

export type DockerReportOptions = {
  /** Logo + Clack intro before the error (e.g. `supatype dev` entry). */
  brand?: DockerBrandOptions
}

function dockerSpawn(args: string[]) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    stdio: "pipe",
    shell: process.platform === "win32",
  })
}

/** One docker call's result, as both the blocking and the bounded probe read it. */
interface ProbeAnswer {
  status: number | null
  stdout: string
  stderr: string
  missing: boolean
}

const VERSION_ARGS = ["version", "--format", "{{.Client.Version}}"]

function spawnAnswer(args: string[]): ProbeAnswer {
  const result = dockerSpawn(args)
  const missing = result.error !== undefined && "code" in result.error && result.error.code === "ENOENT"
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", missing }
}

/** Returns whether the Docker CLI is on PATH and the daemon accepts connections. */
export function probeDockerDaemon(): DockerDaemonProbe {
  const version = spawnAnswer(VERSION_ARGS)
  return verdictFromVersion(version) ?? verdictFromInfo(spawnAnswer(["info"]), version)
}

/**
 * {@link probeDockerDaemon} for `init`, which must not wait on Docker: `docker version` and
 * `docker info` are asked side by side, each given up on after `timeoutMs` (docker-exec.ts). A
 * daemon that does not answer in that time is reported as such.
 */
export async function probeDockerDaemonAsync(runner?: DockerRunner, timeoutMs?: number): Promise<DockerDaemonProbe> {
  const ask = { shell: process.platform === "win32", ...(runner && { runner }), ...(timeoutMs !== undefined && { timeoutMs }) }
  const [version, info] = await Promise.all([askDocker(VERSION_ARGS, ask), askDocker(["info"], ask)])
  if (version.timedOut || info.timedOut) {
    const seconds = Math.round((timeoutMs ?? DOCKER_PROBE_TIMEOUT_MS) / 1000)
    return { ok: false, reason: "daemon_unavailable", detail: `Docker did not answer within ${seconds}s` }
  }
  return verdictFromVersion(version) ?? verdictFromInfo(info, version)
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

function shouldShowDockerDetail(probe: Extract<DockerDaemonProbe, { ok: false }>): boolean {
  if (!probe.detail) return false
  const lower = probe.detail.toLowerCase()
  if (probe.reason !== "daemon_unavailable") return true
  // Skip raw daemon stderr when we already print a clearer hint.
  return !lower.includes("paused") && !lower.includes("cannot connect")
}

function dockerUnavailableHeadline(probe: Extract<DockerDaemonProbe, { ok: false }>): string {
  if (probe.reason === "cli_missing") {
    return "Docker is not installed or not on your PATH."
  }
  return "Docker is installed but the daemon is not running."
}

function dockerUnavailableHints(probe: Extract<DockerDaemonProbe, { ok: false }>): string[] {
  const hints: string[] = []

  if (probe.reason === "cli_missing") {
    hints.push(
      "Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or add the docker CLI to PATH.",
    )
  } else if (probe.detail?.toLowerCase().includes("paused")) {
    hints.push("Unpause Docker Desktop from the whale menu or Dashboard, then try again.")
  } else if (platform() === "win32" || platform() === "darwin") {
    hints.push("Start Docker Desktop, then try again.")
  } else {
    hints.push("Start the Docker daemon (e.g. sudo systemctl start docker), then try again.")
  }

  hints.push('To develop without Docker, set provider: "native" in supatype.config.ts.')

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
  const probe = probeDockerDaemon()
  if (probe.ok) return
  // Dev TUI patches console, restore stderr before printing a fatal message.
  if (getActiveDevSession()) {
    endDevSession()
  }
  reportDockerUnavailable(probe, opts)
  process.exit(1)
}
