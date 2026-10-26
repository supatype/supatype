/**
 * Tracks an active `supatype dev` session so we can recover when the CLI exits
 * without graceful shutdown (terminal closed, kill signal, etc.).
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { runDockerCompose } from "./self-host-compose.js"
import { projectNameInFile } from "./project-name-override.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import { confirm as uiConfirm } from "./ui/confirm.js"
import { success, warn } from "./ui/messages.js"
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

export function readDevSessionLock(cwd: string): DevSessionLock | null {
  const path = devSessionLockPath(cwd)
  if (!existsSync(path)) return null
  return readJsonFile(path, isDevSessionLock) ?? null
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
