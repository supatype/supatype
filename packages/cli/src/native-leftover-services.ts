/**
 * This project's native services, left running by a `supatype dev` that was killed.
 *
 * 0.9.2 release test round 2 (FF12 remainder, Linux): a SIGKILL of the dev CLI left every service
 * running. Each leads a process group of its own (process-tree.ts), and nothing runs in a process
 * that is killed, so nothing stopped them, and the next dev refused their ports. Native dev already
 * stops its own leftover Postgres (native-leftover-postgres.ts); the services get the same.
 *
 * A pid file names a pid and the program that ran under it. A process is stopped only when all of
 * these hold, so a pid the system has since given to something else is never taken for a service:
 * - no dev of this project is still running;
 * - its command line names the program its pid file records;
 * - the process that started it is not a running `supatype` (another project's dev, whose own
 *   service took a pid this project's file still names).
 */
import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { comparable } from "./app/port-holder.js"
import { DEV_PID_LABEL, otherDevRunning, type NativeDevState } from "./native-leftover-postgres.js"
import { pidAlive } from "./parent-watch.js"
import { commandLines, processInfo, type ProcessInfo } from "./process-info.js"
import { readPidRecord, type PidRecord } from "./process-manager.js"
import { killPidTree } from "./process-tree.js"

/** Pid files the services' sweep leaves alone: dev's own, and the app, which proxy-dev-app.ts checks. */
const NOT_SERVICES = new Set([DEV_PID_LABEL, "app"])

/** A service's pid file and what it names. */
interface ServicePid extends PidRecord {
  label: string
  signature: string
}

/** The services' pid files in `pidDir` that name a running process and the program it ran. */
function recordedServices(pidDir: string): ServicePid[] {
  let files: string[]
  try {
    files = readdirSync(pidDir)
  } catch {
    return []
  }
  return files.flatMap((file) => {
    const label = file.endsWith(".pid") ? file.slice(0, -".pid".length) : ""
    if (label === "" || NOT_SERVICES.has(label)) return []
    const record = readPidRecord(pidDir, label)
    if (record?.signature === undefined || !pidAlive(record.pid)) return []
    return [{ label, pid: record.pid, signature: record.signature }]
  })
}

/** True when `commandLine` names `path`, compared as the platform compares paths. */
function names(commandLine: string, path: string): boolean {
  const win32 = process.platform === "win32"
  return comparable(commandLine, win32).includes(comparable(path, win32))
}

/** The recorded services a killed dev of this project left running (see the file's header). */
export async function leftoverOwnServices(state: NativeDevState): Promise<ServicePid[]> {
  if (otherDevRunning(state.pidDir)) return []
  const recorded = recordedServices(state.pidDir)
  if (recorded.length === 0) return []
  const running = await processInfo(recorded.map((service) => service.pid))
  const named = recorded.filter((service) => {
    const info = running.get(service.pid)
    return info !== undefined && names(info.commandLine, service.signature)
  })
  const parents = await commandLines(named.flatMap((service) => running.get(service.pid)?.ppid ?? []))
  return named.filter((service) => !startedBySupatype(running.get(service.pid), parents))
}

/**
 * A command line running `supatype dev`: the installed program, or the CLI's script under node.
 * Not any process whose path names a folder called supatype, such as an editor in a checkout.
 */
const SUPATYPE_DEV = /supatype(?:\.exe|\.js)?["']?\s+dev(?:\s|$)/i

/** True when the process that started the one `info` describes is a running `supatype dev`. */
function startedBySupatype(info: ProcessInfo | undefined, parents: Map<number, string>): boolean {
  const parent = info === undefined ? undefined : parents.get(info.ppid)
  return parent !== undefined && SUPATYPE_DEV.test(parent)
}

/** Stops each service a killed dev of this project left running, saying so, and removes its pid file. */
export async function stopLeftoverServices(state: NativeDevState): Promise<void> {
  const leftovers = await leftoverOwnServices(state)
  await Promise.all(
    leftovers.map(async ({ label, pid }) => {
      console.log(`[supatype] This project's ${label} (pid ${pid}) was still running from a dev that did not stop cleanly; stopping it.`)
      await killPidTree(pid)
      rmSync(join(state.pidDir, `${label}.pid`), { force: true })
    }),
  )
}
