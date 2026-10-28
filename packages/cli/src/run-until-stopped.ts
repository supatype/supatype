import { spawn } from "node:child_process"

/** Ctrl+C, a stop request, a closed terminal, and Ctrl+Break on Windows, as dev-shutdown.ts hears. */
const STOP_SIGNALS: NodeJS.Signals[] = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  ...(process.platform === "win32" ? ["SIGBREAK" as const] : []),
]

/** 130 is how Deno and POSIX shells exit on SIGINT, 0xC000013A how a Windows console process does. */
const CTRL_C_EXIT_CODES = new Set([130, 0xc000013a])

/** Whether a child that exited with `code` or `signal` was stopped rather than failed. */
function stoppedByCtrlC(code: number | null, signal: NodeJS.Signals | null): boolean {
  if (signal !== null) return STOP_SIGNALS.includes(signal)
  return code !== null && CTRL_C_EXIT_CODES.has(code)
}

/**
 * Runs `command` with this terminal until it exits, passing on Ctrl+C or a stop request rather than
 * dying first. Files removed on `exit` stay otherwise, since Node never emits it when a signal it
 * has no listener for kills it. Resolves to the exit code, 0 once asked to stop, and rejects when
 * the command cannot start.
 */
export async function runUntilStopped(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number> {
  const child = spawn(command, args, { ...opts, stdio: "inherit" })
  let stopping = false
  const stop = (): void => {
    stopping = true
    child.kill()
  }
  for (const signal of STOP_SIGNALS) process.on(signal, stop)
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        child.once("error", rejectExit)
        child.once("exit", (code, signal) => resolveExit({ code, signal }))
      },
    )
    // Ctrl+C reaches the child too, which can exit from it before this process hears the signal.
    if (stopping || stoppedByCtrlC(exit.code, exit.signal)) return 0
    return exit.code ?? 1
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, stop)
  }
}
