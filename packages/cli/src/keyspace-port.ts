/**
 * Where native dev puts the RESP keyspace, and the Valkey sidecar that stands in for it.
 *
 * `SUPATYPE_KEYSPACE_PORT` names the port for a run, in the shell or in the project's `.env` (the
 * shell wins, as it does for Compose), as the other native port variables do. Left unset, the
 * keyspace takes the first free port from 6379, which stays the usual answer. A named port is
 * exact: it is that port or none, since quietly using another would put the keyspace somewhere the
 * developer who named a port is not looking.
 */
import { readEnvFile } from "./env-file.js"
import { firstFreePort, KEYSPACE_PORT_BASE, KEYSPACE_PORT_SPAN } from "./postgres-ctl.js"

export const KEYSPACE_PORT_ENV = "SUPATYPE_KEYSPACE_PORT"

/** The ports a keyspace may take: `span` ports from `base`, and whether the developer named one. */
export interface KeyspacePorts {
  base: number
  span: number
  named: boolean
}

const PORT = /^\d+$/

/** The ports for the project at `cwd`; throws for a `SUPATYPE_KEYSPACE_PORT` that is not a port number. */
export function keyspacePorts(cwd: string): KeyspacePorts {
  const value = (process.env[KEYSPACE_PORT_ENV]?.trim() || readEnvFile(cwd)[KEYSPACE_PORT_ENV]?.trim()) ?? ""
  if (value === "") return { base: KEYSPACE_PORT_BASE, span: KEYSPACE_PORT_SPAN, named: false }
  const port = Number(value)
  if (!PORT.test(value) || port < 1 || port > 65535) {
    throw new Error(`${KEYSPACE_PORT_ENV} must be a port number from 1 to 65535, got "${value}".`)
  }
  return { base: port, span: 1, named: true }
}

/** The first free port among `ports`, or null when none is. */
export function firstFreeKeyspacePort(ports: KeyspacePorts): Promise<number | null> {
  return firstFreePort(ports.base, ports.span)
}

/** Where a keyspace looked for a port, for a message: the named port, or the range. */
export function describeKeyspacePorts(ports: KeyspacePorts): string {
  if (ports.named) return `${ports.base} (${KEYSPACE_PORT_ENV}=${ports.base})`
  return `${ports.base}-${ports.base + ports.span - 1}`
}
