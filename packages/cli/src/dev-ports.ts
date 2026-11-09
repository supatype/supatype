/**
 * Kong / Postgres host port resolution for local Docker dev.
 * Persists SUPATYPE_KONG_PORT in `.env` so re-runs are stable, but re-checks
 * availability so multiple projects and port collisions are surfaced clearly.
 */

import { CLACK_CANCEL, isCancel, p } from "./ui/clack.js"
import { ensureNotCancelled } from "./ui/prompts.js"
import { askDocker, askDockerSync, DOCKER_QUERY_TIMEOUT_MS, type DockerRunner } from "./docker-exec.js"
import { COMPOSE_DEV_KONG_PORT } from "./project-config.js"
import { isPortInUse } from "./postgres-ctl.js"
import { readComposeEnvInt, shellEnvInt, upsertEnvFile } from "./env-file.js"
import { writeFrontendEnv } from "./frontend-env.js"
import { writeCliDatabaseUrl } from "./database-url-owner.js"
import { isInteractive } from "./ui/interactive.js"
import { fatalError } from "./ui/fatal.js"
import { COMPOSE_DEV_DB_PORT, hostComposeDbUrl } from "./host-database.js"

const MIN_PORT = 1024
const MAX_PORT = 65535

/**
 * Which compose project publishes a host port, from `docker ps` output.
 *
 * Separated from the spawn so the decision is testable: the question "is this port held by my own
 * stack" is the whole point of the check, and a check that can only be exercised by starting Docker
 * is a check nobody exercises.
 *
 * Docker prints one line per matching container, and a container with no compose label prints an
 * empty line. Any line naming a different project means someone else holds the port.
 */
export function composeProjectOwnsPort(dockerPsOutput: string, project: string): boolean {
  const owners = dockerPsOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return owners.length > 0 && owners.every((owner) => owner === project)
}

/**
 * True when the container publishing `port` belongs to this project's compose stack.
 *
 * Asks Docker rather than probing the port over HTTP. A health check would answer just as happily
 * for a *different* project's gateway on the same port, and proceeding there would push a schema
 * into the wrong database. Refusing is the safe answer for a stranger; only our own stack is fine.
 */
export function portHeldByComposeProject(port: number, project: string): boolean {
  // Synchronous: `projectStackUrl` (local-stack.ts) asks it from synchronous push and seed paths.
  const result = askDockerSync(["ps", "--filter", `publish=${port}`, "--format", '{{.Label "com.docker.compose.project"}}'], {
    timeoutMs: DOCKER_QUERY_TIMEOUT_MS,
  })
  if (result.status !== 0) return false
  return composeProjectOwnsPort(result.stdout, project)
}

/**
 * What Docker says about every compose container, running or stopped, so the question "which ports
 * are other Supatype stacks configured with" can be answered by a test without Docker.
 */
export interface ComposePortReader {
  /** One `<container id> <compose project>` line per container, or null when Docker cannot be asked. */
  listContainers: () => Promise<string | null>
  /** One `HostConfig.PortBindings` JSON object per line for `ids`, or null when Docker cannot be asked. */
  portBindings: (ids: readonly string[]) => Promise<string | null>
}

/**
 * Docker's answers about compose containers, each given up on after `timeoutMs` (docker-exec.ts):
 * `init` waited on these without limit, 8 seconds for one `docker inspect` on a busy machine.
 */
export function dockerPortReader(runner?: DockerRunner, timeoutMs?: number): ComposePortReader {
  const output = async (args: readonly string[]): Promise<string | null> => {
    const answer = await askDocker(args, { ...(runner && { runner }), ...(timeoutMs !== undefined && { timeoutMs }) })
    return answer.status === 0 ? answer.stdout : null
  }
  return {
    listContainers: () =>
      output(["ps", "-a", "--filter", "label=com.docker.compose.project", "--format", '{{.ID}} {{.Label "com.docker.compose.project"}}']),
    portBindings: (ids) => output(["inspect", "-f", "{{json .HostConfig.PortBindings}}", ...ids]),
  }
}

export const dockerComposePortReader: ComposePortReader = dockerPortReader()

/** Host ports in one container's `HostConfig.PortBindings` JSON; none for anything unreadable. */
function hostPortsFromBindings(line: string): number[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== "object") return []
  return Object.values(parsed).flatMap((bindings: unknown) =>
    Array.isArray(bindings) ? bindings.map(hostPortOf).filter(isValidHostPort) : [],
  )
}

function hostPortOf(binding: unknown): number {
  if (binding === null || typeof binding !== "object" || !("HostPort" in binding)) return Number.NaN
  return Number(binding.HostPort)
}

/**
 * Container ids of Supatype compose projects (`supatype-*`) other than `ownProject`, from
 * `listContainers` output.
 */
function supatypeContainerIds(listing: string, ownProject: string | undefined): string[] {
  return listing.split("\n").flatMap((line) => {
    const [id, project] = line.trim().split(/\s+/)
    return id && project?.startsWith("supatype-") && project !== ownProject ? [id] : []
  })
}

/**
 * Every host port a Supatype compose project on this machine is configured to publish, whether
 * its containers are running or stopped (M2). `ownProject`'s containers are left out: a project's
 * own ports are its to keep (M2b).
 *
 * A stopped container holds no port, so asking the OS says it is free; handing it to a new project
 * makes the two clash the first time both run. Empty when Docker is absent or does not answer:
 * this only narrows a choice, and nothing should fail for want of it.
 */
export async function reservedComposePorts(
  reader: ComposePortReader = dockerComposePortReader,
  ownProject?: string,
): Promise<Set<number>> {
  const ids = supatypeContainerIds((await reader.listContainers()) ?? "", ownProject)
  if (ids.length === 0) return new Set()
  return new Set(((await reader.portBindings(ids)) ?? "").split("\n").flatMap(hostPortsFromBindings))
}

/**
 * The Kong port a new project gets: `SUPATYPE_KONG_PORT` from the shell when it is set, otherwise
 * the first from the default that is free and no stack claims.
 *
 * Compose binds the shell's port ahead of `.env`, and every other command reads it first
 * ({@link readPersistedKongPort}). Choosing past it had `init` write and announce a port the stack
 * would never listen on.
 */
export async function chooseInitKongPort(
  reader: ComposePortReader = dockerComposePortReader,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return kongPortFromEnvironment(env) ?? findNextFreePort(COMPOSE_DEV_KONG_PORT, await reservedComposePorts(reader))
}

export function isValidHostPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT
}

export function parseHostPortInput(raw: string): number | null {
  const port = Number(raw.trim())
  return isValidHostPort(port) ? port : null
}

const NO_PORTS: ReadonlySet<number> = new Set()

/** True when `port` is bound on this machine now, or `reserved` holds it for a stack that is not. */
async function portTaken(port: number, reserved: ReadonlySet<number>): Promise<boolean> {
  return reserved.has(port) || (await isPortInUse(port))
}

/** Next free TCP port on 127.0.0.1 starting at `start`, skipping any in `reserved`. */
export async function findNextFreePort(start: number, reserved: ReadonlySet<number> = NO_PORTS): Promise<number> {
  let port = Math.max(MIN_PORT, start)
  while (port <= MAX_PORT && (await portTaken(port, reserved))) port++
  if (port > MAX_PORT) {
    throw new Error(`No free local port found in range ${start}–${MAX_PORT}.`)
  }
  return port
}

/**
 * The Kong port this project is set to: `SUPATYPE_KONG_PORT` in the environment when it is set,
 * otherwise in `.env`. Docker Compose reads the environment ahead of `.env` and binds that port
 * whatever `.env` says, so reading `.env` alone had `dev` wait on one port while Kong listened on
 * another.
 */
export function readPersistedKongPort(cwd: string, env: NodeJS.ProcessEnv = process.env): number | null {
  return readComposeEnvInt(cwd, KONG_PORT_ENV, env)
}

/** The variable compose reads Kong's host port from. */
const KONG_PORT_ENV = "SUPATYPE_KONG_PORT"

/** `SUPATYPE_KONG_PORT` from the shell environment, when it is set to a usable port. */
function kongPortFromEnvironment(env: NodeJS.ProcessEnv): number | null {
  return shellEnvInt(KONG_PORT_ENV, env)
}

/**
 * Record a Kong port dev moved to: in `.env`, with the front end's copies of its address in
 * `.env.development.local`, since a production build reads `.env`. Exported for its tests.
 */
export function persistKongPort(cwd: string, port: number): void {
  const apiUrl = `http://localhost:${port}`
  upsertEnvFile(cwd, {
    SUPATYPE_KONG_PORT: String(port),
    API_EXTERNAL_URL: apiUrl,
    SITE_URL: apiUrl,
  })
  writeFrontendEnv(cwd, { apiUrl })
}

async function promptPortConflict(
  cwd: string,
  blockedPort: number,
  reason: "in_use" | "init",
  reserved: ReadonlySet<number> = NO_PORTS,
): Promise<number> {
  const port = await promptPortConflictWithoutPersist(blockedPort, await conflictHeadline(blockedPort, reason, reserved), reserved)
  persistKongPort(cwd, port)
  return port
}

export interface EnsureKongPortOptions {
  /** When false, fail fast instead of prompting (CI / scripts). */
  interactive?: boolean
  /** init wizard: slightly different copy */
  context?: "dev" | "init"
  /**
   * Compose project for this directory. When given, a port published by that project is accepted
   * rather than refused: that is this project's own stack, not a stranger's.
   */
  composeProject?: string
  /** The environment Docker Compose will read. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Where the ports other Supatype stacks are configured with are read. Defaults to Docker. */
  portReader?: ComposePortReader
}

/**
 * Resolve the Kong host port for this project directory.
 * - Uses `.env` when set and available.
 * - Prompts (or errors) when the configured port is taken.
 * - Auto-picks the next free port on first run when unset.
 */
export async function ensureKongPort(
  cwd: string,
  opts: EnsureKongPortOptions = {},
): Promise<number> {
  const interactive = opts.interactive ?? isInteractive()
  const context = opts.context ?? "dev"
  const env = opts.env ?? process.env
  const persisted = readPersistedKongPort(cwd, env)

  if (persisted !== null) {
    if (!(await isPortInUse(persisted))) return persisted

    // Occupied by this project's own stack is not a conflict, it is the normal state after
    // `supatype self-host compose up -d`. Refusing here made a hand-run `up -d` followed by
    // `push` impossible, and it stopped the validation soak, which does exactly that.
    if (opts.composeProject !== undefined && portHeldByComposeProject(persisted, opts.composeProject)) {
      return persisted
    }

    // A port from the shell is not ours to move. Compose binds the shell's value ahead of `.env`,
    // so a new port written to `.env` would be ignored and `dev` would wait on one port while Kong
    // tried to bind the busy one. Say where the port came from instead of offering a choice.
    if (kongPortFromEnvironment(env) === persisted) {
      fatalError(
        `Port ${persisted} is already in use, and SUPATYPE_KONG_PORT=${persisted} is set in your shell.`,
        [
          "Docker Compose uses the shell's SUPATYPE_KONG_PORT ahead of .env, so Supatype cannot move",
          "the gateway to another port while it is set.",
          "Unset it (`unset SUPATYPE_KONG_PORT`, or `Remove-Item Env:SUPATYPE_KONG_PORT` in PowerShell)",
          "to use the port in .env, set it to a free port, or stop the service using this one.",
        ],
      )
    }

    if (!interactive) {
      fatalError(`Port ${persisted} is already in use (SUPATYPE_KONG_PORT).`, [
        "Stop the other service or set a different SUPATYPE_KONG_PORT.",
        "Run `supatype dev` in a terminal to pick a new port interactively.",
      ])
    }

    return promptPortConflict(cwd, persisted, "in_use")
  }

  const reserved = await reservedComposePorts(opts.portReader, opts.composeProject)
  return firstRunKongPort(cwd, { prompt: interactive && context === "init", reserved, composeProject: opts.composeProject })
}

/**
 * The Kong port for a project with none set: the default unless the OS has it bound or another
 * Supatype stack is configured with it (M2b), then the next port that is neither, or the init
 * prompt's choice. The project's own stack on the default keeps it: with no port in `.env`, compose
 * publishes Kong there (0.9.1 release test FF1). A self-host `.env` written from the VM guide names
 * none, and push took its own gateway for a stranger's and waited 120 s on the next free port.
 */
async function firstRunKongPort(
  cwd: string,
  pick: { prompt: boolean; reserved: ReadonlySet<number>; composeProject: string | undefined },
): Promise<number> {
  const { prompt, reserved, composeProject } = pick
  const preferred = COMPOSE_DEV_KONG_PORT
  if (!(await portTaken(preferred, reserved))) return preferred
  if (composeProject !== undefined && portHeldByComposeProject(preferred, composeProject)) return preferred
  return prompt ? promptPortConflict(cwd, preferred, "init", reserved) : findNextFreePort(preferred, reserved)
}

/**
 * Wizard / init: pick a Kong port without writing `.env` (scaffold writes it). The default offered
 * is never one another Supatype stack is configured with (M2). A port typed in that something is
 * listening on is asked again; one only a stopped stack is configured with is the person's to
 * choose, once they confirm it. Each reason is part of the next prompt: a line logged between two
 * prompts is wiped when the wizard redraws (issue 59). A port exported in the shell is taken
 * without asking, as {@link chooseInitKongPort} does: compose binds it whatever is typed here.
 */
export async function promptKongPortChoice(
  reader: ComposePortReader = dockerComposePortReader,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const fromShell = kongPortFromEnvironment(env)
  if (fromShell !== null) {
    p.log.info(`Local API gateway port (Kong): ${fromShell}, from SUPATYPE_KONG_PORT in your shell.`)
    return fromShell
  }
  const reserved = await reservedComposePorts(reader)
  const freeDefault = await findNextFreePort(COMPOSE_DEV_KONG_PORT, reserved)
  const port = await askKongPort(freeDefault)
  if (await isPortInUse(port)) {
    return promptPortConflictWithoutPersist(port, portRefusal(port, true, reserved), reserved)
  }
  if (await acceptsReservedPort(port, reserved)) return port
  return askFreeKongPort(freeDefault, reserved, PICK_UNRESERVED)
}

/** Ask for the Kong port, offering `freeDefault`, saying `why` the last answer was not taken. A cancel ends init. */
async function askKongPort(freeDefault: number, why?: string): Promise<number> {
  const value = await p.text({
    message: why === undefined ? KONG_PORT_QUESTION : `${why}\n${KONG_PORT_QUESTION}`,
    defaultValue: String(freeDefault),
    validate: (raw) => {
      const port = parseHostPortInput(raw ?? "")
      if (!port) return `Enter a port between ${MIN_PORT} and ${MAX_PORT}.`
      return undefined
    },
  })
  return parseHostPortInput(ensureNotCancelled(value))!
}

const KONG_PORT_QUESTION = "Local API gateway port (Kong)"

/** Why a port another stack is configured with was not taken, for the question asked next. */
const PICK_UNRESERVED = "Pick a port no other Supatype stack is configured with."

/**
 * Whether to take a port chosen by hand: yes, unless only a stopped Supatype stack is configured
 * with it and the person, asked, says no. Docker reserves a port only while a container runs, so it
 * is free now; the clash comes when both stacks run. A cancel ends init.
 */
async function acceptsReservedPort(port: number, reserved: ReadonlySet<number>): Promise<boolean> {
  if (!reserved.has(port)) return true
  return ensureNotCancelled(
    await p.confirm({
      message: `${reservedPortClash(port)}: stop one before starting the other. Use ${port} anyway?`,
      initialValue: false,
    }),
  )
}

/** What is wrong with a port another Supatype stack is configured with, running or not. */
function reservedPortClash(port: number): string {
  return `Port ${port} is configured for another Supatype stack, and the two stacks cannot run at once`
}

/**
 * The prompt's headline: what is actually true of `port`. At init it was refused for being in use or
 * for another stack being configured with it, or both.
 */
async function conflictHeadline(port: number, reason: "in_use" | "init", reserved: ReadonlySet<number>): Promise<string> {
  if (reason === "in_use") return `Port ${port} is in use, another Supatype project or service may already be bound to it.`
  return portRefusal(port, await isPortInUse(port), reserved)
}

/**
 * Why init did not take `port`, from whether something listens on it and whether another Supatype
 * stack is configured with it: the same words at every prompt (issue 59).
 */
function portRefusal(port: number, listening: boolean, reserved: ReadonlySet<number>): string {
  if (!listening) return `${reservedPortClash(port)}.`
  return reserved.has(port)
    ? `Port ${port} is in use by another Supatype stack configured with it.`
    : `Port ${port} is in use on this machine.`
}

/** Offer the next free port, another typed in, or cancel, under `headline`: why `blockedPort` was not taken. */
async function promptPortConflictWithoutPersist(
  blockedPort: number,
  headline: string,
  reserved: ReadonlySet<number> = NO_PORTS,
): Promise<number> {
  const suggested = await findNextFreePort(blockedPort + 1, reserved)
  const choice = await p.select<"suggested" | "custom" | "cancel">({
    message: headline,
    options: [
      {
        value: "suggested",
        label: `Use ${suggested} instead`,
        hint: "next available port",
      },
      { value: "custom", label: "Enter a different port" },
      { value: "cancel", label: "Cancel" },
    ],
  })

  if (isCancel(choice) || choice === "cancel") {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  if (choice === "suggested") return suggested
  return askFreeKongPort(suggested, reserved)
}

/**
 * Ask for a port until one typed is free and, if another stack is configured with it, confirmed;
 * every answer so far is kept meanwhile. Each question says why the last answer was not taken.
 */
async function askFreeKongPort(suggested: number, reserved: ReadonlySet<number>, firstWhy?: string): Promise<number> {
  let why = firstWhy
  for (;;) {
    const port = await askKongPort(suggested, why)
    if (await isPortInUse(port)) {
      why = `${portRefusal(port, true, reserved)} Pick another port, or stop the service using it.`
    } else if (await acceptsReservedPort(port, reserved)) {
      return port
    } else {
      why = PICK_UNRESERVED
    }
  }
}

export interface EnsureDevDbPortOptions {
  /** This directory's compose project: a port its own database publishes is kept, not moved. */
  composeProject?: string
  /**
   * Only `supatype dev` moves the port, when something else holds it. Every other command keeps it
   * or stops: moving it means rewriting `.env` and recreating the database under a running stack.
   */
  mayMove?: boolean
}

/**
 * The host port for this project's Postgres, persisted in `.env` as SUPATYPE_DEV_DB_PORT.
 *
 * The project's own database holding the port is the normal state while `dev` runs, not a
 * collision. Treating it as one moved the port on every push and doctor (A3-N2, A5-N5), rewrote
 * `.env` and recreated the database under the running stack.
 */
export async function ensureDevDbPort(cwd: string, opts: EnsureDevDbPortOptions = {}): Promise<number> {
  const persisted = readComposeEnvInt(cwd, "SUPATYPE_DEV_DB_PORT")
  if (persisted === null) {
    const free = (await isPortInUse(COMPOSE_DEV_DB_PORT)) ? await findNextFreePort(COMPOSE_DEV_DB_PORT + 1) : COMPOSE_DEV_DB_PORT
    return persistDevDbPort(cwd, free)
  }
  if (!(await isPortInUse(persisted))) return persisted
  if (opts.composeProject !== undefined && portHeldByComposeProject(persisted, opts.composeProject)) {
    return persisted
  }
  // A port from the shell is not ours to move, for the reason `ensureKongPort` gives: compose binds
  // the shell's value ahead of `.env`, so a new port written there would be ignored (DR9).
  if ((process.env["SUPATYPE_DEV_DB_PORT"]?.trim() ?? "") !== "") {
    throw new Error(
      `Port ${persisted} is in use, and SUPATYPE_DEV_DB_PORT=${persisted} is set in your shell. ` +
        "Unset it to use the port in .env, set it to a free port, or stop the service using this one.",
    )
  }
  if (opts.mayMove !== true) {
    throw new Error(
      `Port ${persisted} (SUPATYPE_DEV_DB_PORT) is in use by something other than this project's ` +
        "database. Stop it, or run `supatype dev`, which moves this project to a free port.",
    )
  }
  return persistDevDbPort(cwd, await findNextFreePort(persisted + 1))
}

function persistDevDbPort(cwd: string, port: number): number {
  // The URL only over one the CLI owns: one that is yours always wins (database-url-owner.ts).
  writeCliDatabaseUrl(cwd, hostComposeDbUrl(cwd, port), { SUPATYPE_DEV_DB_PORT: String(port) })
  return port
}
