/**
 * This project's own native Postgres, left running by a `supatype dev` that did not stop cleanly.
 *
 * 0.9.2 release test (FF12 remainder): a forced stop of native dev (Windows `taskkill /F` of the CLI,
 * Linux closing its terminal) ends every service but Postgres, which pg_ctl started detached. The
 * next dev refused "Port 54341 is already in use. Another Postgres instance may be running." about
 * its own database, and only `supatype pg stop` got past it.
 *
 * The next dev stops that Postgres and starts it fresh rather than adopting it, as dev already does
 * with everything it runs: it starts Postgres with this run's settings and stops it when it ends, and
 * the Docker provider's own recovery (`recoverStaleDevSession`) stops a stale session's stack before
 * starting again. An adopted server would keep whatever settings the earlier CLI gave it.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { comparablePath } from "./dev-session-lock.js"
import { pidAlive } from "./parent-watch.js"
import { readPostmasterPid } from "./postgres-ctl.js"
import { readPid } from "./process-manager.js"

/** Where a project's native Postgres keeps its data, and where native dev records its own pid. */
export interface NativeDevState {
  dataDir: string
  pidDir: string
}

/** The label of the pid file a running native dev keeps in its pid directory. */
export const DEV_PID_LABEL = "dev"

/**
 * The pid of this project's own Postgres on `port`, left running by a dev that is gone; null when
 * there is none. Its `postmaster.pid` has to name this data directory, this port and a live
 * process, so a data directory copied from another project, or a server moved to another port, is
 * never taken for it. A dev of this project that is still running (its pid file names a live
 * process) keeps its Postgres: a second dev started beside it is refused on the port, as before.
 */
export function leftoverOwnPostgres(state: NativeDevState, port: number, alive: (pid: number) => boolean = pidAlive): number | null {
  const postmaster = readPostmasterPid(state.dataDir)
  if (postmaster === null || postmaster.pid <= 0 || postmaster.port !== port) return null
  // Links followed: one data directory has more than one spelling (macOS's /var is /private/var).
  if (comparablePath(postmaster.dataDir) !== comparablePath(state.dataDir) || !alive(postmaster.pid)) return null
  if (otherDevRunning(state.pidDir, alive)) return null
  return postmaster.pid
}

/** True when a native dev of this project other than this one is still running. */
export function otherDevRunning(pidDir: string, alive: (pid: number) => boolean = pidAlive): boolean {
  const dev = readPid(pidDir, DEV_PID_LABEL)
  return dev !== null && dev !== process.pid && alive(dev)
}

/**
 * Records this process as the project's running native dev, so another dev started meanwhile never
 * takes its Postgres for a leftover. Returns the removal, for the shutdown.
 */
export function recordNativeDevPid(pidDir: string): () => void {
  mkdirSync(pidDir, { recursive: true })
  const file = join(pidDir, `${DEV_PID_LABEL}.pid`)
  writeFileSync(file, String(process.pid))
  return () => rmSync(file, { force: true })
}
