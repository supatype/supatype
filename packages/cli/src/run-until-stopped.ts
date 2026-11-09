import { type ChildProcess, spawn } from "node:child_process"
import { endTreeOnExit, endTreeRemains, stopTree, treeSpawnOptions } from "./process-tree.js"
import { STOP_SIGNALS } from "./stop-signals.js"

/** 130 is how Deno and POSIX shells exit on SIGINT, 0xC000013A how a Windows console process does. */
const CTRL_C_EXIT_CODES = new Set([130, 0xc000013a])

/** Whether a child that exited with `code` or `signal` was stopped rather than failed. */
function stoppedByCtrlC(code: number | null, signal: NodeJS.Signals | null): boolean {
  if (signal !== null) return STOP_SIGNALS.includes(signal)
  return code !== null && CTRL_C_EXIT_CODES.has(code)
}

interface ChildExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/** How `child` exited; rejects when it could not start. */
function exitOf(child: ChildProcess): Promise<ChildExit> {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit)
    child.once("exit", (code, signal) => resolveExit({ code, signal }))
  })
}

/**
 * Runs `command` with this terminal until it exits, passing on Ctrl+C or a stop request rather than
 * dying first. Files removed on `exit` stay otherwise, since Node never emits it when a signal it
 * has no listener for kills it. Resolves to the exit code, 0 once asked to stop, and rejects when
 * the command cannot start. The listeners go when it settles, so a caller that is done exits
 * straight away: a late Ctrl+C after that would kill it with no `exit`.
 *
 * A stop, a crash, or the command ending on its own ends what it started too. `functions serve`
 * stopped Deno alone, and what Deno had started kept running (0.9.1 release test, FF12).
 */
export async function runUntilStopped(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number> {
  const child = spawn(command, args, { ...opts, stdio: "inherit", ...treeSpawnOptions() })
  endTreeOnExit(child)
  let stopped: Promise<void> | null = null
  // The signal heard is passed on. In a process group of its own the command no longer hears the
  // terminal's Ctrl+C, and Deno exits at once on SIGINT where on SIGTERM it lets requests finish.
  const stop = (signal: NodeJS.Signals): void => {
    stopped ??= stopTree(child, signal)
  }
  for (const signal of STOP_SIGNALS) process.on(signal, stop)
  try {
    const exit = await exitOf(child)
    if (stopped !== null) await stopped
    else if (child.pid !== undefined) await endTreeRemains(child.pid, Date.now())
    // On Windows Ctrl+C reaches the child too, which can exit from it before this process hears it.
    if (stopped !== null || stoppedByCtrlC(exit.code, exit.signal)) return 0
    return exit.code ?? 1
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, stop)
  }
}
