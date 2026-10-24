/**
 * Tracks an active `supatype dev` session so we can recover when the CLI exits
 * without graceful shutdown (terminal closed, kill signal, etc.).
 */

import { existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { runDockerCompose, selfHostComposePaths } from "./self-host-compose.js"
import { projectNameInFile } from "./project-name-override.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import { confirm as uiConfirm } from "./ui/confirm.js"
import { info, success, warn } from "./ui/messages.js"
import { isInteractive } from "./ui/interactive.js"
import { isNumber, isOneOf, isShape, isString, optional, type Guard } from "@supatype/shared"
import { readJsonFile } from "./json-file.js"
import { pidAlive } from "./parent-watch.js"

const LOCK_VERSION = 1 as const

export interface DevSessionLock {
  version: typeof LOCK_VERSION
  composeProject: string
  projectRef: string
  composePath: string
  kongPort: number
  startedAt: string
  /** The `supatype dev` process holding the session. Absent in a lock written before it was kept. */
  pid?: number
}

/** A lock this version of the CLI wrote. One from another version reads as no lock. */
const isDevSessionLock: Guard<DevSessionLock> = isShape({
  version: isOneOf([LOCK_VERSION]),
  composeProject: isString,
  projectRef: isString,
  composePath: isString,
  kongPort: isNumber,
  startedAt: isString,
  pid: optional(isNumber),
})

export function devSessionLockPath(cwd: string): string {
  return resolve(cwd, ".supatype/dev-session.json")
}

/**
 * The lock in this project, only when it was written for this project.
 *
 * A folder copied while `supatype dev` runs carries the original's lock, and the copy then took itself
 * for that dev stack: its renders came out dev, on the original's database port (C4). A lock counts
 * only when the compose file it names, an absolute path, is this project's own. The compose project
 * name is not compared: under `--project-name` a live session's name differs from the config's.
 * A lock from another folder is removed with a one-line note; the original keeps its own.
 */
export function readDevSessionLock(cwd: string): DevSessionLock | null {
  const path = devSessionLockPath(cwd)
  if (!existsSync(path)) return null
  const lock = readJsonFile(path, isDevSessionLock) ?? null
  if (lock === null || lockBelongsTo(lock, cwd)) return lock
  info(`Ignoring .supatype/dev-session.json: it belongs to the dev stack "${lock.composeProject}" of another folder, not this project. Removed it.`)
  clearDevSessionLock(cwd)
  return null
}

/**
 * A path as compared here: with links followed, and case-folded on Windows, whose paths ignore case.
 *
 * Links matter because one folder has more than one spelling: on macOS the temp folder is `/var/...`
 * and a process's cwd reports it as `/private/var/...`. Compared unresolved, a session's own lock
 * read through the other spelling looked like a copy's and was removed. The compose file may not
 * exist yet, so the nearest folder that does is resolved and the rest appended.
 */
function comparablePath(p: string): string {
  const real = realPath(resolve(p))
  return process.platform === "win32" ? real.toLowerCase() : real
}

/** `abs` with every link followed, as far up as the path exists. */
function realPath(abs: string): string {
  try {
    return realpathSync.native(abs)
  } catch {
    const parent = dirname(abs)
    return parent === abs ? abs : join(realPath(parent), basename(abs))
  }
}

/** Whether a lock was written by `supatype dev` in the project at `cwd`. */
function lockBelongsTo(lock: DevSessionLock, cwd: string): boolean {
  return comparablePath(lock.composePath) === comparablePath(selfHostComposePaths(cwd).composePath)
}

/**
 * The lock, only while the `supatype dev` that wrote it is still running.
 *
 * A dev killed without its exit hooks (a closed terminal on Windows, `kill -9`) leaves its lock
 * behind, and a lock alone made every later compose render dev, so a production stack rendered by
 * `push` or `self-host compose up` came up with open CORS and an open Studio (SHa). A lock whose
 * process is gone, or that names none, is removed and read as no session at all.
 */
export function liveDevSessionLock(cwd: string): DevSessionLock | null {
  const lock = readDevSessionLock(cwd)
  if (lock === null) return null
  if (lock.pid !== undefined && pidAlive(lock.pid)) return lock
  clearDevSessionLock(cwd)
  return null
}

/**
 * The session record for a stack `dev` has started.
 *
 * `projectRef` is the config file's name, as `environment.json` records it: under
 * `--project-name` / SUPATYPE_PROJECT_NAME the run has a name of its own, which is the compose
 * project's and not the project's.
 */
export function devSessionLockFor(
  config: SupatypeProjectConfig,
  stack: Pick<DevSessionLock, "composeProject" | "composePath" | "kongPort">,
  startedAt: Date = new Date(),
): Omit<DevSessionLock, "version" | "pid"> {
  return { ...stack, projectRef: projectNameInFile(config), startedAt: startedAt.toISOString() }
}

export function writeDevSessionLock(cwd: string, lock: Omit<DevSessionLock, "version" | "pid">): void {
  const dir = join(cwd, ".supatype")
  mkdirSync(dir, { recursive: true })
  const payload: DevSessionLock = { version: LOCK_VERSION, ...lock, pid: process.pid }
  writeFileSync(devSessionLockPath(cwd), `${JSON.stringify(payload, null, 2)}\n`, "utf8")
}

export function clearDevSessionLock(cwd: string): void {
  const path = devSessionLockPath(cwd)
  if (existsSync(path)) unlinkSync(path)
}

export function composeStackHasContainers(composeProject: string): boolean {
  const result = spawnSync(
    "docker",
    ["ps", "-a", "--filter", `label=com.docker.compose.project=${composeProject}`, "--format", "{{.Names}}"],
    { encoding: "utf8", shell: process.platform === "win32" },
  )
  return Boolean(result.stdout?.trim())
}

/**
 * When a previous dev session did not shut down cleanly, offer to stop its stack
 * before starting a new one.
 */
export async function recoverStaleDevSession(cwd: string): Promise<void> {
  const lock = readDevSessionLock(cwd)
  if (!lock) return
  if (!composeStackHasContainers(lock.composeProject)) {
    clearDevSessionLock(cwd)
    return
  }

  const message =
    `Previous dev session for "${lock.projectRef}" may not have shut down cleanly ` +
    `(stack "${lock.composeProject}" is still running).`

  if (!isInteractive()) {
    warn(message)
    warn(`Stop it manually: docker compose -p ${lock.composeProject} down`)
    return
  }

  const stop = await uiConfirm(`${message}\n\nStop the orphaned stack before starting?`, { default: true })

  if (!stop) {
    warn(`Leaving "${lock.composeProject}" running.`)
    return
  }

  const status = runDockerCompose(lock.composePath, ["down"], cwd, lock.composeProject, { quiet: true })
  if (status === 0) {
    clearDevSessionLock(cwd)
    success(`Stopped orphaned stack "${lock.composeProject}".`)
  } else {
    warn(`Could not stop "${lock.composeProject}" (exit ${status}).`)
  }
}
