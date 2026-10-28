/**
 * Kong / Postgres host port resolution for local Docker dev.
 * Persists SUPATYPE_KONG_PORT in `.env` so re-runs are stable, but re-checks
 * availability so multiple projects and port collisions are surfaced clearly.
 */

import { spawnSync } from "node:child_process"
import { CLACK_CANCEL, isCancel, p } from "./ui/clack.js"
import { COMPOSE_DEV_KONG_PORT } from "./project-config.js"
import { isPortInUse } from "./postgres-ctl.js"
import { readComposeEnvInt, readEnvInt, upsertEnvFile } from "./env-file.js"
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
  const result = spawnSync(
    "docker",
    ["ps", "--filter", `publish=${port}`, "--format", '{{.Label "com.docker.compose.project"}}'],
    { encoding: "utf8" },
  )
  if (result.status !== 0 || typeof result.stdout !== "string") return false
  return composeProjectOwnsPort(result.stdout, project)
}

/**
 * What Docker says about every compose container, running or stopped, so the question "which ports
 * are other Supatype stacks configured with" can be answered by a test without Docker.
 */
export interface ComposePortReader {
  /** One `<container id> <compose project>` line per container, or null when Docker cannot be asked. */
  listContainers: () => string | null
  /** One `HostConfig.PortBindings` JSON object per line for `ids`, or null when Docker cannot be asked. */
  portBindings: (ids: readonly string[]) => string | null
}

function dockerOutput(args: readonly string[]): string | null {
  const result = spawnSync("docker", [...args], { encoding: "utf8" })
  return result.status === 0 && typeof result.stdout === "string" ? result.stdout : null
}

export const dockerComposePortReader: ComposePortReader = {
  listContainers: () =>
    dockerOutput([
      "ps", "-a",
      "--filter", "label=com.docker.compose.project",
      "--format", '{{.ID}} {{.Label "com.docker.compose.project"}}',
    ]),
  portBindings: (ids) => dockerOutput(["inspect", "-f", "{{json .HostConfig.PortBindings}}", ...ids]),
}

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
export function reservedComposePorts(
  reader: ComposePortReader = dockerComposePortReader,
  ownProject?: string,
): Set<number> {
  const ids = supatypeContainerIds(reader.listContainers() ?? "", ownProject)
  if (ids.length === 0) return new Set()
  return new Set((reader.portBindings(ids) ?? "").split("\n").flatMap(hostPortsFromBindings))
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
  return kongPortFromEnvironment(env) ?? findNextFreePort(COMPOSE_DEV_KONG_PORT, reservedComposePorts(reader))
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
  return kongPortFromEnvironment(env) ?? readEnvInt(cwd, "SUPATYPE_KONG_PORT")
}

/** `SUPATYPE_KONG_PORT` from the shell environment, when it is set to a usable port. */
function kongPortFromEnvironment(env: NodeJS.ProcessEnv): number | null {
  const port = Number(env["SUPATYPE_KONG_PORT"]?.trim())
  return isValidHostPort(port) ? port : null
}

function persistKongPort(cwd: string, port: number): void {
  const apiUrl = `http://localhost:${port}`
  upsertEnvFile(cwd, {
    SUPATYPE_KONG_PORT: String(port),
    PUBLIC_SUPATYPE_URL: apiUrl,
    API_EXTERNAL_URL: apiUrl,
    SITE_URL: apiUrl,
  })
}

async function promptPortConflict(
  cwd: string,
  blockedPort: number,
  reason: "in_use" | "init",
  reserved: ReadonlySet<number> = NO_PORTS,
): Promise<number> {
  const port = await promptPortConflictWithoutPersist(blockedPort, reason, reserved)
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

  const reserved = reservedComposePorts(opts.portReader, opts.composeProject)
  return firstRunKongPort(cwd, interactive && context === "init", reserved)
}

/**
 * The Kong port for a project with none set: the default unless the OS has it bound or another
 * Supatype stack is configured with it (M2b), then the next port that is neither, or the init
 * prompt's choice.
 */
async function firstRunKongPort(cwd: string, prompt: boolean, reserved: ReadonlySet<number>): Promise<number> {
  const preferred = COMPOSE_DEV_KONG_PORT
  if (!(await portTaken(preferred, reserved))) return preferred
  return prompt ? promptPortConflict(cwd, preferred, "init", reserved) : findNextFreePort(preferred, reserved)
}

/**
 * Wizard / init: pick a Kong port without writing `.env` (scaffold writes it). Neither the default
 * offered nor a port typed in may be one another Supatype stack is configured with (M2). A port
 * exported in the shell is taken without asking, as {@link chooseInitKongPort} does: compose binds it
 * whatever is typed here.
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
  const reserved = reservedComposePorts(reader)
  const freeDefault = await findNextFreePort(COMPOSE_DEV_KONG_PORT, reserved)

  const value = await p.text({
    message: "Local API gateway port (Kong)",
    defaultValue: String(freeDefault),
    placeholder: String(COMPOSE_DEV_KONG_PORT),
    validate: (raw) => {
      const port = parseHostPortInput(raw ?? "")
      if (!port) return `Enter a port between ${MIN_PORT} and ${MAX_PORT}.`
      return undefined
    },
  })

  if (isCancel(value)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  const port = parseHostPortInput(value)!
  if (await portTaken(port, reserved)) {
    return promptPortConflictWithoutPersist(port, "init", reserved)
  }
  return port
}

async function promptPortConflictWithoutPersist(
  blockedPort: number,
  reason: "in_use" | "init",
  reserved: ReadonlySet<number> = NO_PORTS,
): Promise<number> {
  const suggested = await findNextFreePort(blockedPort + 1, reserved)
  const headline =
    reason === "init"
      ? `Port ${blockedPort} is in use on this machine, or another Supatype stack is configured with it.`
      : `Port ${blockedPort} is in use, another Supatype project or service may already be bound to it.`

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

  const custom = await p.text({
    message: "Local API gateway port (Kong)",
    defaultValue: String(suggested),
    validate: (value) => {
      const port = parseHostPortInput(value ?? "")
      if (!port) return `Enter a port between ${MIN_PORT} and ${MAX_PORT}.`
      return undefined
    },
  })

  if (isCancel(custom)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  const port = parseHostPortInput(custom)
  if (!port) {
    p.cancel("Invalid port.")
    process.exit(1)
  }

  if (await portTaken(port, reserved)) {
    fatalError(`Port ${port} is still in use.`, [
      "Pick another port or stop the service using it.",
      "Check Docker Desktop for other Supatype stacks.",
    ])
  }

  return port
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
  upsertEnvFile(cwd, {
    SUPATYPE_DEV_DB_PORT: String(port),
    DATABASE_URL: hostComposeDbUrl(cwd, port),
  })
  return port
}
