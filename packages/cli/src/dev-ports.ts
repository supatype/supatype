/**
 * Kong / Postgres host port resolution for local Docker dev.
 * Persists SUPATYPE_KONG_PORT in `.env` so re-runs are stable, but re-checks
 * availability so multiple projects and port collisions are surfaced clearly.
 */

import { CLACK_CANCEL, isCancel, p } from "./ui/clack.js"
import { COMPOSE_DEV_KONG_PORT } from "./project-config.js"
import { isPortInUse } from "./postgres-ctl.js"
import { readEnvInt, upsertEnvFile } from "./env-file.js"
import { isInteractive } from "./ui/interactive.js"
import { fatalError } from "./ui/fatal.js"

const MIN_PORT = 1024
const MAX_PORT = 65535

export function isValidHostPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT
}

export function parseHostPortInput(raw: string): number | null {
  const port = Number(raw.trim())
  return isValidHostPort(port) ? port : null
}

/** Next free TCP port on 127.0.0.1 starting at `start`. */
export async function findNextFreePort(start: number): Promise<number> {
  let port = Math.max(MIN_PORT, start)
  while (port <= MAX_PORT && (await isPortInUse(port))) port++
  if (port > MAX_PORT) {
    throw new Error(`No free local port found in range ${start}–${MAX_PORT}.`)
  }
  return port
}

export function readPersistedKongPort(cwd: string): number | null {
  return readEnvInt(cwd, "SUPATYPE_KONG_PORT")
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
): Promise<number> {
  const port = await promptPortConflictWithoutPersist(blockedPort, reason)
  persistKongPort(cwd, port)
  return port
}

export interface EnsureKongPortOptions {
  /** When false, fail fast instead of prompting (CI / scripts). */
  interactive?: boolean
  /** init wizard — slightly different copy */
  context?: "dev" | "init"
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
  const persisted = readPersistedKongPort(cwd)

  if (persisted !== null) {
    if (!(await isPortInUse(persisted))) return persisted

    if (!interactive) {
      fatalError(`Port ${persisted} is already in use (SUPATYPE_KONG_PORT in .env).`, [
        "Stop the other service or set a different SUPATYPE_KONG_PORT.",
        "Run `supatype dev` in a terminal to pick a new port interactively.",
      ])
    }

    return promptPortConflict(cwd, persisted, "in_use")
  }

  const preferred = COMPOSE_DEV_KONG_PORT
  const port =
    (await isPortInUse(preferred))
      ? interactive && context === "init"
        ? await promptPortConflict(cwd, preferred, "init")
        : await findNextFreePort(preferred)
      : preferred

  return port
}

/** Wizard / init — pick a Kong port without writing `.env` (scaffold writes it). */
export async function promptKongPortChoice(): Promise<number> {
  const freeDefault = (await isPortInUse(COMPOSE_DEV_KONG_PORT))
    ? await findNextFreePort(COMPOSE_DEV_KONG_PORT)
    : COMPOSE_DEV_KONG_PORT

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
  if (await isPortInUse(port)) {
    return promptPortConflictWithoutPersist(port, "init")
  }
  return port
}

async function promptPortConflictWithoutPersist(
  blockedPort: number,
  reason: "in_use" | "init",
): Promise<number> {
  const suggested = await findNextFreePort(blockedPort + 1)
  const headline =
    reason === "init"
      ? `Port ${blockedPort} is already in use on this machine.`
      : `Port ${blockedPort} is in use — another Supatype project or service may already be bound to it.`

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

  if (await isPortInUse(port)) {
    fatalError(`Port ${port} is still in use.`, [
      "Pick another port or stop the service using it.",
      "Check Docker Desktop for other Supatype stacks.",
    ])
  }

  return port
}

const COMPOSE_DEV_DB_PORT = 54329

function devDbConnectionUrl(port: number): string {
  return `postgresql://supatype_admin:postgres@localhost:${port}/supatype?sslmode=disable`
}

export async function ensureDevDbPort(cwd: string): Promise<number> {
  const persisted = readEnvInt(cwd, "SUPATYPE_DEV_DB_PORT")

  const persist = (port: number): number => {
    upsertEnvFile(cwd, {
      SUPATYPE_DEV_DB_PORT: String(port),
      DATABASE_URL: devDbConnectionUrl(port),
    })
    return port
  }

  if (persisted !== null) {
    if (!(await isPortInUse(persisted))) return persisted
    const next = await findNextFreePort(persisted + 1)
    return persist(next)
  }

  let port = COMPOSE_DEV_DB_PORT
  if (await isPortInUse(port)) {
    port = await findNextFreePort(port + 1)
  }
  return persist(port)
}
