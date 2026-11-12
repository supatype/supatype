/**
 * Whether native `supatype dev` serves the RESP keyspace from its own Postgres, or leaves the
 * cache to the Valkey sidecar.
 *
 * Two questions, asked at two moments. Before Postgres starts: does the project want the
 * keyspace, does the archive carry the library and can it require a password, and is there a port
 * for it. After it starts: does the port answer a client that logs in with the project's password,
 * which the extension reads itself from the file native dev wrote ({@link writeKeyspacePasswordFile}).
 * A no to any of them is the Valkey sidecar, never an error, because a missing cache must not
 * become a missing database.
 *
 * 0.9.2 release test (N-RB2): the keyspace listened on 0.0.0.0 and answered every client, so
 * native dev on Linux served an open, writable store to the network. It is served only from an
 * archive at KEYSPACE_AUTH_SINCE or later, on loopback, requiring AUTH (postgres-ctl.ts).
 *
 * The filesystem, version, port and RESP checks are parameters so the decision can be tested
 * against an archive that carries the library and one that does not, without starting anything.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { nativeKeyspaceWanted } from "./cache-provider.js"
import { firstFreePort, KEYSPACE_PORT_BASE, KEYSPACE_PORT_SPAN, nativeKeyspaceLibraryPresent } from "./postgres-ctl.js"
import { archiveHasKeyspaceAuth, KEYSPACE_AUTH_SINCE } from "./postgres-image.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import { answersPing, type RespCredentials } from "./valkey-sidecar.js"

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
 * The port native Postgres should serve RESP on, or null for the Valkey sidecar. `version` is the
 * archive's, as dev resolved it to find the archive; null when it is not known, as for a local build.
 *
 * `cache.provider: "valkey"` is honoured here, and this is the only place it could be: without
 * asking the config, an archive that carries the library would serve RESP anyway and a project
 * that deliberately kept the sidecar would never get it.
 */
export async function nativeKeyspacePort(
  config: SupatypeProjectConfig,
  pgBinDir: string | null,
  version: string | null,
  checks: NativeKeyspaceChecks = machineChecks,
): Promise<number | null> {
  if (!nativeKeyspaceWanted(config) || !checks.libraryPresent(pgBinDir)) return null
  if (!archiveHasKeyspaceAuth(version)) {
    console.log(
      `[supatype] This Postgres archive (${version ?? "a local build"}) cannot require a keyspace password ` +
        `(${KEYSPACE_AUTH_SINCE} or later can), so the cache uses the Valkey sidecar.`,
    )
    return null
  }
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
 * Writes the project's keyspace password to `<state root>/keyspace/password`, and says where:
 * `pg_keyspace.password_file`, which the extension reads at start and on every reload, giving the
 * `supatype` user that password and refusing every client that has not logged in. Only the path
 * is ever a setting, so the password is in no command line, setting or log.
 *
 * Readable by this user alone: the directory 0700 and the file 0600, put right when an earlier one
 * was wider, since the mode given at creation applies to a new file only. Written at every start,
 * so a password changed in .env is the one the next start reads. No newline is written; the
 * extension would drop one, and anything else would be part of the password.
 */
export function writeKeyspacePasswordFile(stateRoot: string, password: string): string {
  const dir = join(stateRoot, "keyspace")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const file = join(dir, "password")
  writeFileSync(file, password, { mode: 0o600 })
  chmodSync(file, 0o600)
  return file
}

/**
 * The address the cache should talk to when Postgres serves RESP, or null for the Valkey sidecar.
 *
 * The probe logs in, since the keyspace refuses PING before AUTH, and is not ceremony: shared
 * memory limits, a preload ordering mistake, a password file that could not be read or a port
 * taken between the check and the start all leave a Postgres that is running and a keyspace that
 * is not, and the difference is a cache that silently never hits.
 */
export async function nativeKeyspaceAddr(
  keyspacePort: number,
  credentials: RespCredentials,
  respAnswers: (port: number) => Promise<boolean> = (port) => answersPing("127.0.0.1", port, { timeoutMs: 800, credentials }),
): Promise<string | null> {
  if (await respAnswers(keyspacePort)) return `127.0.0.1:${keyspacePort}`
  console.warn(
    `[supatype] ⚠  Postgres has pg_keyspace but is not serving RESP on :${keyspacePort}. ` +
      "See logs/postgres.log. Falling back to the Valkey sidecar.",
  )
  return null
}
