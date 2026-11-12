/**
 * Tracks an active `supatype dev` session so we can recover when the CLI exits
 * without graceful shutdown (terminal closed, kill signal, etc.).
 */

import { existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { askDockerSync, DOCKER_QUERY_TIMEOUT_MS } from "./docker-exec.js"
import { composeProjectName, runDockerCompose, selfHostComposePaths } from "./self-host-compose.js"
import { projectNameInFile, projectNameOverride } from "./project-name-override.js"
import type { SupatypeProjectConfig } from "./project-config.js"
import { confirm as uiConfirm } from "./ui/confirm.js"
import { info, success, warn } from "./ui/messages.js"
import { isInteractive } from "./ui/interactive.js"
import { isNumber, isOneOf, isRecordOf, isShape, isString, optional, type Guard } from "@supatype/shared"
import { readJsonFile } from "./json-file.js"
import { pidAlive } from "./parent-watch.js"
import { DEV_DB_PORT_ENV } from "./db-port.js"
import { applyForThisRun } from "./shell-ports.js"
import { fatalError } from "./ui/fatal.js"
import { refuseOtherFoldersStack } from "./stack-folder.js"

const LOCK_VERSION = 1 as const

export interface DevSessionLock {
  version: typeof LOCK_VERSION
  composeProject: string
  projectRef: string
  composePath: string
  /**
   * Who runs the stack. Absent in a lock Docker dev wrote before native dev wrote one too. Native dev
   * records its session so host commands take its database port and refuse another (0.9.2 round 5,
   * FF-7 on native): it has no compose stack, so only Docker's lock makes compose renders dev.
   */
  provider?: "docker" | "native"
  /** The stack's gateway port; absent for native dev, which has no Kong. */
  kongPort?: number
  /**
   * The host port the stack publishes its database on; absent for an external database, and in a
   * lock written before it was kept. A port the shell gave dev stays out of .env (DR9), so host
   * commands read it here, or reached the default port, another project's (0.9.2 round 2, R2-S17).
   */
  dbPort?: number
  /**
   * The values dev holds for its run only, kept out of `.env` (DR9): a port its shell gave and every
   * value built from it (the API and site URLs, the front end's URLs, DATABASE_URL). Absent in a
   * lock written before it was kept, which then gives its two ports alone.
   */
  runEnv?: Record<string, string>
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
  provider: optional(isOneOf(["docker", "native"])),
  kongPort: optional(isNumber),
  dbPort: optional(isNumber),
  runEnv: optional(isRecordOf(isString)),
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
export function comparablePath(p: string): string {
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
 * The compose project of the local stack for the project at `cwd`, called `projectName` in this run.
 *
 * `supatype dev` under SUPATYPE_PROJECT_NAME names its stack after that name, and a command run
 * later from a shell without it looked under the config's name: `admin create-user` said the stack
 * was not running while dev ran (0.9.2 round 2, N2). So while this folder's dev session runs, its
 * stack is the one it recorded. A name this run was given still wins: that is the stack it asked for.
 * A lookup only: a path that goes on to work with the stack enters it ({@link enterLocalStack}).
 */
export function localStackComposeProject(cwd: string, projectName: string): string {
  const lock = liveDevSessionLock(cwd)
  return projectNameOverride() !== undefined || lock === null ? composeProjectName(projectName) : lock.composeProject
}

/**
 * Enter this folder's local stack: its compose project ({@link localStackComposeProject}), and the
 * live dev session's run values loaded into this run's environment. Loading them is the point, and
 * the one place a command takes them.
 *
 * Compose interpolates the stack's ports, and the URLs built from them, from the environment ahead
 * of `.env`, and what dev's shell gave it stays out of `.env` (DR9). So `push` from another shell
 * rendered the stack on the default ports and its `up -d` recreated the running database and Kong
 * there, while dev went on advertising its own (0.9.2 release test, FF-7). `diff` and `adopt` did
 * the same through the engine's `compose run`, and `self-host compose up` with `.env`'s stale URLs.
 *
 * Called only by a path that has settled on the local stack, before it reads a port. A command
 * aimed at a linked self-host server or at cloud never enters it: dev's local ports and URLs are not
 * that stack's. Only for the session's own stack: a project name this run was given that names
 * another stack takes nothing.
 *
 * A port this run's shell sets to another than the one the stack runs on is refused. Compose binds
 * the shell's port ahead of all else, so a stale export in another terminal moved the running Kong
 * there with exit 0, while dev and the server went on naming the old one, and another database port
 * waited 69 s to fail (0.9.2 round 4). Any other value the shell sets still wins.
 *
 * A stack of that name another folder started is refused too ({@link refuseOtherFoldersStack}).
 */
export function enterLocalStack(cwd: string, projectName: string, env: NodeJS.ProcessEnv = process.env): string {
  const lock = liveDevSessionLock(cwd)
  if (lock !== null && runTargetsSessionStack(lock)) {
    refuseOtherShellPorts(lock, env)
    applyForThisRun(sessionRunEnv(lock), env)
    // This folder's own dev runs that stack, and checked whose it was when it started it.
    return lock.composeProject
  }
  const composeProject = localStackComposeProject(cwd, projectName)
  refuseOtherFoldersStack(cwd, composeProject)
  return composeProject
}

/**
 * Exit 1 naming each port this run's shell sets to another than the one `lock`'s stack runs on.
 *
 * Compared as the shell wrote it, not trimmed: compose takes the raw value, so `" 19276"` passed a
 * trimmed check and then failed as `invalid hostPort:  19276` (0.9.2 round 5, S-3).
 */
function refuseOtherShellPorts(lock: DevSessionLock, env: NodeJS.ProcessEnv): void {
  const ports: Array<[string, number | undefined]> = [["SUPATYPE_KONG_PORT", lock.kongPort], [DEV_DB_PORT_ENV, lock.dbPort]]
  const clashes = ports.filter(([key, port]) => {
    const shell = env[key] ?? ""
    return port !== undefined && shell !== "" && shell !== String(port)
  })
  if (clashes.length === 0) return
  const keys = clashes.map(([key]) => key)
  fatalError(`The supatype dev running in this folder (pid ${lock.pid ?? "unknown"}) holds other ports than this shell names.`, [
    ...clashes.map(([key, port]) => `${key}=${shellValue(env[key] ?? "")} is set in this shell, and the stack runs on ${port}.`),
    // Said for every command: one that starts services moves the stack, and one that only reads it looks on the wrong port (S-5).
    "This shell's ports would win over the stack's: a command that starts services would move the stack onto them, and any other would look for it on the wrong port.",
    `Unset ${keys.join(" and ")} here (\`unset ${keys.join(" ")}\`, or \`Remove-Item ${keys.map((key) => `Env:${key}`).join(", ")}\` in PowerShell), or stop dev first.`,
  ])
}

/** A shell value as written, quoted when spaces around it would not show. */
function shellValue(value: string): string {
  return value.trim() === value ? value : JSON.stringify(value)
}

/** Whether this run works with `lock`'s stack: no project name of its own, or the session's. */
function runTargetsSessionStack(lock: DevSessionLock): boolean {
  const name = projectNameOverride()
  return name === undefined || composeProjectName(name) === lock.composeProject
}

/** The session's run-only values, or its two ports from a lock written before they were kept. */
function sessionRunEnv(lock: DevSessionLock): Record<string, string> {
  if (lock.runEnv !== undefined) return lock.runEnv
  return {
    ...(lock.kongPort !== undefined && { SUPATYPE_KONG_PORT: String(lock.kongPort) }),
    ...(lock.dbPort !== undefined && { [DEV_DB_PORT_ENV]: String(lock.dbPort) }),
  }
}

/** Whether `lock` is a Docker dev session's: its stack is a compose stack dev renders. */
export function isDockerSession(lock: DevSessionLock): boolean {
  return lock.provider !== "native"
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
  stack: Pick<DevSessionLock, "provider" | "composeProject" | "composePath" | "kongPort" | "dbPort" | "runEnv">,
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
  // Synchronous: dev's exit path asks this too, where nothing may be awaited.
  const result = askDockerSync(
    ["ps", "-a", "--filter", `label=com.docker.compose.project=${composeProject}`, "--format", "{{.Names}}"],
    { shell: process.platform === "win32", timeoutMs: DOCKER_QUERY_TIMEOUT_MS },
  )
  return result.stdout.trim() !== ""
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
