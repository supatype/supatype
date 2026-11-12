/**
 * Watching a compose stack's essential services while the CLI waits on the stack.
 *
 * With the server container exited on a fatal config error, dev waited the gateway's full 120 s,
 * named the gateway's health instead of the server, and then took the stack down, so the server's
 * log went with it (issue 38). A wait that watches these services can stop as soon as one has
 * exited, and print why while its log still exists.
 */
import { setTimeout as sleep } from "node:timers/promises"
import { parseComposePs, type ComposeService } from "./compose-services.js"
import { composeBaseArgs, type ComposeStack } from "./compose-db-psql.js"
import { askDocker, DOCKER_QUERY_TIMEOUT_MS, type DockerRunner } from "./docker-exec.js"
import { readDotEnvFiles } from "./env-file.js"
import { redactSecrets } from "./error-message.js"

/** The services whose exit means the stack will not come up: one-shot services are not here. */
export const ESSENTIAL_SERVICES: ReadonlySet<string> = new Set(["db", "kong", "server", "realtime", "storage"])

/** How many of an exited service's log lines are printed. */
export const EXITED_LOG_LINES = 30

/** An essential service found exited. */
export interface ExitedService {
  service: string
  exitCode?: number
  /** Docker is restarting it after it exited, under its restart policy. */
  restarting?: true
}

/** What a wait asks of the stack it waits on. */
export interface StackWatch {
  /** The first essential service that has exited, or undefined while none has (or Docker cannot say). */
  exited(): Promise<ExitedService | undefined>
  /** The first of `services` that has exited or is being restarted after it did, or undefined. */
  failing(services: ReadonlySet<string>): Promise<ExitedService | undefined>
  /** The last `lines` lines of `service`'s log, empty when Docker cannot give them. */
  logTail(service: string, lines: number): Promise<string>
}

/** A compose stack, and the project directory its commands run in. */
export interface WatchedStack extends ComposeStack {
  cwd: string
}

/** {@link StackWatch} over `docker compose`; `runner` stands in for Docker in tests. */
export function composeStackWatch(stack: WatchedStack, runner?: DockerRunner): StackWatch {
  const ask = (args: string[]) =>
    askDocker([...composeBaseArgs(stack.cwd, stack), ...args], {
      cwd: stack.cwd,
      timeoutMs: DOCKER_QUERY_TIMEOUT_MS,
      ...(runner !== undefined && { runner }),
    })
  const first = async (matches: (service: ComposeService) => boolean): Promise<ExitedService | undefined> => {
    const answer = await ask(["ps", "--all", "--format", "json"])
    if (answer.status !== 0) return undefined
    const found = parseComposePs(answer.stdout).find(matches)
    if (found === undefined) return undefined
    return {
      service: found.service,
      ...(found.exitCode !== undefined && { exitCode: found.exitCode }),
      ...(found.state === "restarting" && { restarting: true as const }),
    }
  }
  return {
    exited: () => first((s) => ESSENTIAL_SERVICES.has(s.service) && isExited(s.state)),
    failing: (services) => first((s) => services.has(s.service) && (isExited(s.state) || s.state === "restarting")),
    logTail: async (service, lines) => {
      const answer = await ask(["logs", "--no-color", "--tail", String(lines), service])
      return `${answer.stdout}${answer.stderr}`.trim()
    },
  }
}

/** Docker's word for a container that has stopped and will not be restarted. */
function isExited(state: string): boolean {
  return state === "exited" || state === "dead"
}

/** Keys in `.env` whose values are not to be printed. */
const SECRET_KEY = /PASSWORD|SECRET|KEY|TOKEN|DATABASE_URL|DSN/i

/** The project's secret values, from `.env` and `.env.local`, for {@link redactSecrets}. */
export function projectSecrets(cwd: string): string[] {
  return Object.entries(readDotEnvFiles(cwd))
    .filter(([key]) => SECRET_KEY.test(key))
    .map(([, value]) => value)
}

/** What to print about `exited`: a line naming it and its exit code, then its log tail. */
export function exitedServiceReport(exited: ExitedService, logTail: string, secrets: readonly string[]): string[] {
  const code = exited.exitCode === undefined ? "" : ` with exit code ${exited.exitCode}`
  const again = exited.restarting === true ? ", and Docker keeps restarting it" : ""
  const said = logTail === "" ? ["  (no log lines)"] : redactSecrets(logTail, secrets).split(/\r?\n/)
  return [`[supatype] The ${exited.service} container exited${code}${again}. Its last ${EXITED_LOG_LINES} log lines:`, ...said]
}

/** Print why `exited` stopped, with its log tail, while the log is still there. */
export async function printExitedService(exited: ExitedService, on: { watch: StackWatch; cwd: string }): Promise<void> {
  const tail = await on.watch.logTail(exited.service, EXITED_LOG_LINES).catch(() => "")
  console.error("")
  for (const line of exitedServiceReport(exited, tail, projectSecrets(on.cwd))) console.error(line)
  console.error("")
}

/**
 * The first of `services` found failing within `windowMs`, asked every `pollMs`, or undefined when
 * none did. A container that refuses its settings exits within a second or two of starting, and
 * its restart policy then restarts it, so one look straight after compose returns can miss it.
 */
export async function watchForFailure(
  watch: StackWatch,
  services: ReadonlySet<string>,
  windowMs: number,
  pollMs = 500,
): Promise<ExitedService | undefined> {
  const deadline = Date.now() + windowMs
  for (;;) {
    const failed = await watch.failing(services)
    if (failed !== undefined || Date.now() >= deadline) return failed
    await sleep(pollMs)
  }
}

/**
 * Print why `exited` stopped, while its log is still there, and return the error the wait fails
 * with. The caller cleans up after this, which removes the container and its log.
 */
export async function exitedServiceFailure(exited: ExitedService, on: { watch: StackWatch; cwd: string }): Promise<Error> {
  await printExitedService(exited, on)
  const code = exited.exitCode === undefined ? "" : ` with code ${exited.exitCode}`
  return new Error(`The ${exited.service} container exited${code} before the stack was ready; its last log lines are above.`)
}
