/**
 * A port native dev binds, claimed in a file every other native dev's start reads, for as long as
 * the dev that claimed it runs.
 *
 * 0.9.2 release test (N-FF12): two projects started 10 s apart both passed the port check, which
 * runs about 20 s before PostgREST binds, and both PostgRESTs listened on 127.0.0.1:3001. PostgREST
 * binds with SO_REUSEADDR, which on Windows lets a second listener share a port the first holds, so
 * neither failed.
 *
 * Round 2 (R2-RB1): the first fix claimed the port by listening on it. The installed CLI is a Bun
 * program, and on Windows Bun gives every process it starts a copy of its open sockets. Postgres
 * and the server, started while the port was held, kept it open after the CLI closed its own, so
 * PostgREST's port was taken on every native start. A file gives a child process nothing to keep.
 *
 * `~/.supatype/ports/<port>.lock` holds the claiming dev's process id. A claim whose process is
 * gone, from a dev that crashed, is taken over.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { errorCode } from "./error-message.js"
import { pidAlive } from "./parent-watch.js"

/** A claimed port, until released. */
export interface PortLock {
  release: () => void
}

/** The claim another running process holds on a port: its process id and the file that says so. */
export interface PortClaimHeld {
  holder: number
  path: string
}

/** Where the claim on `port` lives. Read at each call, so a test's own home is used. */
export function portLockPath(port: number): string {
  return join(homedir(), ".supatype", "ports", `${port}.lock`)
}

/** The process id a claim names, or null when it names none. */
function claimHolder(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** True when the claim was taken, not refused. */
export function isPortLock(claim: PortLock | PortClaimHeld): claim is PortLock {
  return "release" in claim
}

/**
 * Claims `port` for this process, or names the running process that holds it. A home folder that
 * cannot be written leaves the port unclaimed rather than refusing to start: the port checks still
 * run, as before claims.
 */
export function claimPortLock(port: number): PortLock | PortClaimHeld {
  const path = portLockPath(port)
  const unclaimed: PortLock = { release: () => undefined }
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    return unclaimed
  }
  // Twice: once more after removing a claim whose process is gone.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" })
    } catch (err) {
      if (errorCode(err) !== "EEXIST") return unclaimed
      const holder = claimHolder(path)
      if (holder !== null && pidAlive(holder)) return { holder, path }
      rmSync(path, { force: true })
      continue
    }
    // Two starts that both removed the same dead claim can both write one. The file names the last.
    const holder = claimHolder(path)
    if (holder !== process.pid && holder !== null) return { holder, path }
    return { release: () => rmSync(path, { force: true }) }
  }
  // A claim that came back dead after it was removed: start unclaimed, as before claims.
  return unclaimed
}
