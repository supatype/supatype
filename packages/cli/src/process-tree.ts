/**
 * Ending a process together with the processes it started. Native dev's server starts the Deno
 * functions worker as a child of its own, and ending the server alone left the worker holding the
 * functions port, so the next `supatype dev` refused it as taken (0.9.1 release test, FF12).
 * `functions serve` ends its Deno, and what Deno started, the same way.
 *
 * On Windows `taskkill /T` follows the parent links down from the process. On Linux and macOS the
 * process leads a process group of its own (see {@link treeSpawnOptions}), and the group is signalled.
 */

import { spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process"
import { runCaptured } from "./run-captured.js"

/** How long a stopped process, and what it started, get to end on SIGTERM before they are killed. */
const STOP_GRACE_MS = 5_000

/** The processes running now, each ended with what it started if this process ends first. */
const running = new Set<number>()
let endTreeOnExitRegistered = false

/**
 * Ends `child`'s tree if this process ends while it runs: a crash, a forced quit, any `process.exit`
 * before the command stopped it. Each pid is forgotten once its process ends, so a pid the system
 * has since given to another process is never signalled. A child that never started has no tree.
 */
export function endTreeOnExit(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  running.add(pid)
  child.once("exit", () => running.delete(pid))
  if (endTreeOnExitRegistered) return
  endTreeOnExitRegistered = true
  // Synchronous: nothing asynchronous runs once the "exit" event has fired.
  process.on("exit", () => {
    for (const left of running) signalTreeNow(left, "SIGKILL")
  })
}

/**
 * What a process is spawned with so that {@link signalTree} reaches everything it starts. On Linux
 * and macOS that is a process group of its own. Not on Windows, where `detached` would give it a
 * console of its own instead, and `taskkill /T` needs nothing.
 */
export function treeSpawnOptions(): Pick<SpawnOptions, "detached"> {
  return process.platform === "win32" ? {} : { detached: true }
}

function taskkillArgs(pid: number): string[] {
  return ["/pid", String(pid), "/T", "/F"]
}

/** Sends `signal` to the process group `pid` leads; false when there is no such group. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

/**
 * Sends `signal` to `pid` and every process it started, and resolves with whether that reached
 * them. On Windows a process takes no signal, so every one ends the tree at once. Asynchronous, so
 * several stops wait on `taskkill` side by side. Never rejects: a tree that has already ended is what
 * was wanted.
 */
export async function signalTree(pid: number, signal: NodeJS.Signals): Promise<boolean> {
  if (process.platform !== "win32") return signalGroup(pid, signal)
  return (await runCaptured("taskkill", taskkillArgs(pid))).status === 0
}

/**
 * Kills `pid` and every process it started, at once: for a process this run did not start, such as
 * one an earlier run left behind. A process need not lead a process group of its own (Vite under the
 * package manager an app was started with), so off Windows the process alone is killed when it
 * leads none. A pid that names no process is nothing to kill.
 */
export async function killPidTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return
  if ((await signalTree(pid, "SIGKILL")) || process.platform === "win32") return
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // It has already ended.
  }
}

/** {@link signalTree}, finished before it returns, for the process "exit" handler. */
function signalTreeNow(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    signalGroup(pid, signal)
    return
  }
  spawnSync("taskkill", taskkillArgs(pid), { stdio: "ignore", windowsHide: true })
}

/**
 * Whether a process of the group `pid` led is still running. On Linux and macOS what a process
 * started can outlive it; on Windows `taskkill /T` has already ended the whole tree.
 */
function groupRunning(pid: number): boolean {
  if (process.platform === "win32") return false
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Once the process `pid` has ended: waits until `deadline` for what it started to end on the signal
 * it was sent too, then ends whatever is left.
 */
export async function endTreeRemains(pid: number, deadline: number): Promise<void> {
  while (groupRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (groupRunning(pid)) await signalTree(pid, "SIGKILL")
}

/**
 * Stops `child` and everything it started: `signal` to the tree, {@link STOP_GRACE_MS} for all of it
 * to end, then SIGKILL. Returns at once for a child that has already exited: there is no "exit" event
 * left to wait for, and waiting for one held every such stop for the full grace period.
 */
export async function stopTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const deadline = Date.now() + STOP_GRACE_MS
  const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)))
  await signalTree(pid, signal)
  const timedOut = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_GRACE_MS).unref())
  if (await Promise.race([exited, timedOut])) {
    await endTreeRemains(pid, deadline)
    return
  }
  await signalTree(pid, "SIGKILL")
  child.kill("SIGKILL")
}
