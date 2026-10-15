/**
 * Whether native `supatype dev` serves the RESP keyspace from its own Postgres, or leaves the
 * cache to the Valkey sidecar.
 *
 * Two questions, asked at two moments. Before Postgres starts: does the project want the
 * keyspace, does the archive carry the library, and is there a port for it. After it starts: does
 * that port answer. A no to any of them is the Valkey sidecar, never an error, because a missing
 * cache must not become a missing database.
 *
 * The filesystem, port and RESP checks are parameters so the decision can be tested against an
 * archive that carries the library and one that does not, without starting anything.
 */
import { nativeKeyspaceWanted } from "./cache-provider.js"
import {
  firstFreePort,
  KEYSPACE_PORT_BASE,
  KEYSPACE_PORT_SPAN,
  nativeKeyspaceLibraryPresent,
} from "./postgres-ctl.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import { probeTcp } from "./valkey-sidecar.js"

/** What the native keyspace decision asks of the machine before Postgres starts. */
export interface NativeKeyspaceChecks {
  libraryPresent: (pgBinDir: string | null) => boolean
  freePort: () => Promise<number | null>
}

const machineChecks: NativeKeyspaceChecks = {
  libraryPresent: nativeKeyspaceLibraryPresent,
  freePort: () => firstFreePort(KEYSPACE_PORT_BASE, KEYSPACE_PORT_SPAN),
}

/**
 * The port native Postgres should serve RESP on, or null for the Valkey sidecar.
 *
 * `cache.provider: "valkey"` is honoured here, and this is the only place it could be: without
 * asking the config, an archive that carries the library would serve RESP anyway and a project
 * that deliberately kept the sidecar would never get it.
 */
export async function nativeKeyspacePort(
  config: SupatypeProjectConfig,
  pgBinDir: string | null,
  checks: NativeKeyspaceChecks = machineChecks,
): Promise<number | null> {
  if (!nativeKeyspaceWanted(config) || !checks.libraryPresent(pgBinDir)) return null
  const port = await checks.freePort()
  if (port === null) {
    console.warn(
      `[supatype] ⚠  No free port in ${KEYSPACE_PORT_BASE}-${KEYSPACE_PORT_BASE + KEYSPACE_PORT_SPAN - 1} ` +
        "for the Postgres keyspace, starting without it.",
    )
  }
  return port
}

/**
 * The address the cache should talk to when Postgres serves RESP, or null for the Valkey sidecar.
 *
 * The probe is not ceremony: shared memory limits, a preload ordering mistake or a port taken
 * between the check and the start all leave a Postgres that is running and a keyspace that is
 * not, and the difference is a cache that silently never hits.
 */
export async function nativeKeyspaceAddr(
  keyspacePort: number | null,
  respAnswers: (port: number) => Promise<boolean> = (port) => probeTcp("127.0.0.1", port),
): Promise<string | null> {
  if (keyspacePort === null) return null
  if (await respAnswers(keyspacePort)) return `127.0.0.1:${keyspacePort}`
  console.warn(
    `[supatype] ⚠  Postgres has pg_keyspace but is not serving RESP on :${keyspacePort}. ` +
      "See logs/postgres.log. Falling back to the Valkey sidecar.",
  )
  return null
}
