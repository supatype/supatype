/**
 * What a native `supatype dev` that did not stop cleanly left behind, cleaned by the next one.
 *
 * Native dev's Valkey sidecar is a Docker container, and its session record is a file. Both go when
 * dev stops, but a forced quit (a second Ctrl+C more than half a second after the first, or a piped
 * Windows Ctrl+C that delivers two) leaves them. The next dev finds the record, sees that the process
 * that wrote it is gone, removes what the record names, and says so in one line (0.9.2 e2e, S-38).
 *
 * A record whose owner is still running is not touched: that dev is live, and a second one beside it
 * is refused on its ports as before. Services and Postgres a dead dev left are stopped by
 * native-leftover-services.ts and native-leftover-postgres.ts; this is the part they cannot see.
 */
import { clearDevSessionLock, readDevSessionLock } from "./dev-session-lock.js"
import { pidAlive } from "./parent-watch.js"
import { stopValkeySidecar, type DockerCaller } from "./valkey-sidecar.js"

/** What the cleanup asks of the machine; replaced in tests. */
export interface StaleSessionDeps {
  /** Undefined for the real `docker`. */
  docker?: DockerCaller
  alive?: (pid: number) => boolean
}

/**
 * Cleans the stale native session in the project at `cwd`, if there is one. Returns the one line to
 * tell the developer, or null when there was nothing to clean: no record, a Docker dev's record
 * (recoverStaleDevSession is that provider's), or an owner that is still running.
 *
 * The record is removed even when Docker would not remove the container: it is stale either way,
 * and the line then names the command that finishes the job.
 */
export async function cleanStaleNativeSession(cwd: string, deps: StaleSessionDeps = {}): Promise<string | null> {
  const lock = readDevSessionLock(cwd)
  if (lock === null || lock.provider !== "native") return null
  const alive = deps.alive ?? pidAlive
  if (lock.pid !== undefined && (lock.pid === process.pid || alive(lock.pid))) return null

  const owner = lock.pid === undefined ? "a dev that wrote no pid" : `pid ${lock.pid}`
  const container = lock.valkeyContainer
  const removed = container === undefined ? null : await stopValkeySidecar(container, deps.docker)
  clearDevSessionLock(cwd)

  const left = `A previous dev session (${owner}) did not stop cleanly.`
  if (container === undefined) return `${left} Removed its dev-session.json.`
  return removed === true
    ? `${left} Removed its Valkey sidecar container (${container}) and its dev-session.json.`
    : `${left} Removed its dev-session.json, but could not remove the Valkey sidecar container (${container}): run \`docker rm -f ${container}\`.`
}
