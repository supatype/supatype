/**
 * Who a process is, so `supatype dev` ends only what belongs to this project.
 *
 * 0.9.1 release test (FF22): before each start of the app, dev force-killed every listener on the
 * app's port. Two projects proxying the same port each ended the other's dev server before every
 * restart, and each saw its own app exit with code 1 and no error, every few seconds.
 */

import { runCaptured } from "../run-captured.js"
import { windowsProcessFields } from "../windows-processes.js"

/** What a process says about itself: its command line, and its working directory where known. */
export interface ProcessIdentity {
  commandLine: string
  /** Not available on Windows without native code; the command line has to do there. */
  cwd?: string
}

/** The app dev runs: its directory, and the command line it is started with. */
export interface AppIdentity {
  dir: string
  command: string
}

/** A path as compared here: resolved, and on Windows with one separator and one case. */
function comparable(path: string, win32: boolean): string {
  return win32 ? path.replace(/\//g, "\\").toLowerCase() : path
}

/** True when `text` names `dir` or something inside it, not a sibling that only starts the same. */
function mentionsDir(text: string, dir: string, win32: boolean): boolean {
  const haystack = comparable(text, win32)
  const needle = comparable(dir, win32).replace(/[\\/]+$/, "")
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    const next = haystack.charAt(at + needle.length)
    if (next === "" || /[\\/"'\s]/.test(next)) return true
  }
  return false
}

/**
 * True when the process belongs to the app in `appDir`: its command line or working directory is
 * in it (a Vite run straight from the app's node_modules, or one a package manager shim left behind),
 * or its command line is the very command dev runs for this app (a shell around `npm run dev`).
 */
export function belongsToApp(
  identity: ProcessIdentity,
  app: AppIdentity,
  win32: boolean = process.platform === "win32",
): boolean {
  if (identity.cwd !== undefined && mentionsDir(identity.cwd, app.dir, win32)) return true
  if (mentionsDir(identity.commandLine, app.dir, win32)) return true
  return app.command !== "" && identity.commandLine.includes(app.command)
}

/** The command line of each of `pids` still running, from one `ps` call. */
async function posixCommandLines(pids: readonly number[]): Promise<Map<number, string>> {
  const run = await runCaptured("ps", ["-o", "pid=,args=", ...pids.flatMap((pid) => ["-p", String(pid)])])
  const lines = new Map<number, string>()
  for (const line of run.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*\S)/.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) lines.set(Number(match[1]), match[2])
  }
  return lines
}

/** The working directory of `pid`, where `lsof` can read it. */
async function posixCwd(pid: number): Promise<string | undefined> {
  const run = await runCaptured("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
  return run.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1)
}

/**
 * Whether each of `pids` belongs to the app (see {@link belongsToApp}). A process that has ended, or
 * whose command line cannot be read, is left out. All of them are looked up at once, and off Windows
 * the working directory is read only for a process its command line does not already place in the app.
 */
export async function appOwnership(pids: readonly number[], app: AppIdentity): Promise<Map<number, boolean>> {
  const ids = [...new Set(pids)]
  const owned = new Map<number, boolean>()
  if (ids.length === 0) return owned
  if (process.platform === "win32") {
    for (const [pid, commandLine] of await windowsProcessFields(ids, "CommandLine")) {
      owned.set(pid, belongsToApp({ commandLine }, app))
    }
    return owned
  }
  const commandLines = await posixCommandLines(ids)
  await Promise.all(
    [...commandLines].map(async ([pid, commandLine]) => {
      if (belongsToApp({ commandLine }, app)) return owned.set(pid, true)
      const cwd = await posixCwd(pid)
      return owned.set(pid, belongsToApp({ commandLine, ...(cwd !== undefined && { cwd }) }, app))
    }),
  )
  return owned
}
