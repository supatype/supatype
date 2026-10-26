/**
 * Whether the process that started `supatype dev` is still there.
 *
 * A script that starts `dev` and is then killed outright (SIGKILL, a cancelled CI job, a tool
 * timeout) runs no cleanup of its own, and `dev` ran on, holding the stack, its ports and its
 * compose project until someone found it. `dev` now watches its parent and stops, the way Ctrl+C
 * stops it, once the parent is gone.
 *
 * Two signs, for the two families of platform:
 *  - Linux and macOS hand an orphan to a new parent, so `process.ppid` changes.
 *  - Windows does not, so the parent's PID is checked for life.
 * Git Bash adds one wrinkle: a script's `(cd dir && exec node ...)` leaves a bash stub between the
 * script and node, and the stub outlives a killed script. On Windows the grandparent is therefore
 * watched too (watchAlso), resolved once at start.
 */

import { execFile } from "node:child_process"

export interface ProcessProbe {
  ppid(): number
  alive(pid: number): boolean
}

/** True when a process with this PID exists. EPERM means it exists and belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export const liveProbe: ProcessProbe = {
  ppid: () => process.ppid,
  alive: pidAlive,
}

export interface ParentWatch {
  /** Watch one more ancestor; its death counts as the parent's. */
  watchAlso(pid: number): void
  stop(): void
}

export interface WatchParentOptions {
  intervalMs?: number
  probe?: ProcessProbe
}

/**
 * Calls `onGone` once, within `intervalMs`, after the parent (or an ancestor added with
 * `watchAlso`) exits. Started without a parent to lose (PID 0 or 1: already orphaned, or the
 * container's init), it watches nothing. The timer does not keep the process alive.
 */
export function watchParent(onGone: () => void, opts: WatchParentOptions = {}): ParentWatch {
  const probe = opts.probe ?? liveProbe
  const parent = probe.ppid()
  const watched = new Set<number>()
  let timer: ReturnType<typeof setInterval> | undefined

  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  if (parent > 1) {
    watched.add(parent)
    timer = setInterval(() => {
      const gone = probe.ppid() !== parent || [...watched].some((pid) => !probe.alive(pid))
      if (!gone) return
      stop()
      onGone()
    }, opts.intervalMs ?? 2000)
    timer.unref?.()
  }
  return {
    watchAlso: (pid) => {
      if (timer !== undefined && pid > 1) watched.add(pid)
    },
    stop,
  }
}

/** The parent of `pid` on Windows, or undefined when it cannot be read. */
export function windowsParentOf(pid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
      { timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        const parent = Number(stdout.trim())
        resolve(err || !Number.isInteger(parent) || parent <= 0 ? undefined : parent)
      },
    )
  })
}
