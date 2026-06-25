/**
 * Tracks an active `supatype dev` session so we can recover when the CLI exits
 * without graceful shutdown (terminal closed, kill signal, etc.).
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import * as p from "@clack/prompts"
import { runDockerCompose } from "./self-host-compose.js"
import { isInteractive } from "./ui/interactive.js"
import { warn } from "./ui/messages.js"

const LOCK_VERSION = 1 as const

export interface DevSessionLock {
  version: typeof LOCK_VERSION
  composeProject: string
  projectRef: string
  composePath: string
  kongPort: number
  startedAt: string
}

export function devSessionLockPath(cwd: string): string {
  return resolve(cwd, ".supatype/dev-session.json")
}

export function readDevSessionLock(cwd: string): DevSessionLock | null {
  const path = devSessionLockPath(cwd)
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as DevSessionLock
    if (data.version !== LOCK_VERSION) return null
    return data
  } catch {
    return null
  }
}

export function writeDevSessionLock(cwd: string, lock: Omit<DevSessionLock, "version">): void {
  const dir = join(cwd, ".supatype")
  mkdirSync(dir, { recursive: true })
  const payload: DevSessionLock = { version: LOCK_VERSION, ...lock }
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

  const stop = await p.confirm({
    message: `${message}\n\nStop the orphaned stack before starting?`,
    initialValue: true,
  })

  if (p.isCancel(stop) || !stop) {
    warn(`Leaving "${lock.composeProject}" running.`)
    return
  }

  const status = runDockerCompose(lock.composePath, ["down"], cwd, lock.composeProject, { quiet: true })
  if (status === 0) {
    clearDevSessionLock(cwd)
    p.log.success(`Stopped orphaned stack "${lock.composeProject}".`)
  } else {
    warn(`Could not stop "${lock.composeProject}" (exit ${status}).`)
  }
}
