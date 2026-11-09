import type * as ChildProcessModule from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Freeing the app's port ran `netstat` synchronously, and on Windows it took ten seconds: the
 * dashboard and every process's output froze before the app's first start and again before each
 * restart. Here the port scan takes a second, whichever way it is run, and a timer due at 50 ms
 * has to fire while it does. The app is still only spawned once the scan and the kill are done.
 */
const { SCAN_MS, STALE_PID, PORT, events, holder } = vi.hoisted(() => ({
  SCAN_MS: 1_000,
  STALE_PID: 4242,
  PORT: "5299",
  events: [] as string[],
  /** The command line the listener on the port reports: set per test to this project's or another's. */
  holder: { commandLine: "" },
}))

/** What the scan prints: a stale listener on the app's port, and one on a port that only starts the same. */
function scanOutput(port: string): string {
  return process.platform === "win32"
    ? `  TCP    0.0.0.0:${port}    0.0.0.0:0    LISTENING    ${STALE_PID}\r\n  TCP    0.0.0.0:${port}1    0.0.0.0:0    LISTENING    99\r\n`
    : `${STALE_PID}\n`
}

/**
 * What faked processes report about themselves, one line per PID the lookup names: the listener
 * answers with `holder`; any other PID is the app run this dev started (its PID file), whose command
 * is the package manager running `start`.
 */
function describeOutput(command: string): string {
  if (command.includes("-d cwd")) return ""
  events.push("describe")
  const pids = [...command.matchAll(/(?:ProcessId=|-p )(\d+)/g)].map((match) => Number(match[1]))
  const separator = process.platform === "win32" ? "\t" : " "
  return pids.map((pid) => `${pid}${separator}${pid === STALE_PID ? holder.commandLine : "npm run start"}`).join("\n")
}

/** Which faked command a command line is, if any: the port scan, a kill, or a process lookup. */
function faked(command: string): "scan" | "kill" | "describe" | null {
  if (command.includes(".CommandLine") || /^ps\b/.test(command) || command.includes("-d cwd")) return "describe"
  if (/^(netstat|lsof)\b/.test(command)) return "scan"
  if (/^(taskkill|kill)\b/.test(command)) return "kill"
  return null
}

function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void
  const execSyncFake = (command: string): string => {
    const kind = faked(command)
    if (kind === "scan") {
      events.push("scan")
      blockFor(SCAN_MS)
      events.push("scanned")
      return scanOutput(PORT)
    }
    if (kind === "kill") {
      events.push(`kill ${command.match(/\d+/)?.[0] ?? "?"}`)
      return ""
    }
    throw new Error(`not faked: ${command}`)
  }
  // The faked run has no stdin for the CLI to close.
  const fakeChild = { stdin: null }
  const execFileFake = (bin: string, args: readonly string[], ...rest: unknown[]): typeof fakeChild => {
    const callback = rest.find((r): r is ExecFileCallback => typeof r === "function")
    const kind = faked(`${bin} ${args.join(" ")}`)
    // Anything else fails as a command would: dev's parent watch asks PowerShell for its parent.
    if (kind === null || callback === undefined) {
      setImmediate(() => callback?.(new Error(`not faked: ${bin}`), "", ""))
      return fakeChild
    }
    if (kind === "kill") {
      events.push(`kill ${args.find((a) => /^\d+$/.test(a)) ?? "?"}`)
      setImmediate(() => callback(null, "", ""))
      return fakeChild
    }
    if (kind === "describe") {
      setImmediate(() => callback(null, describeOutput(`${bin} ${args.join(" ")}`), ""))
      return fakeChild
    }
    events.push("scan")
    setTimeout(() => {
      events.push("scanned")
      callback(null, scanOutput(PORT), "")
    }, SCAN_MS)
    return fakeChild
  }
  const spawnFake = (...args: Parameters<typeof real.spawn>): ReturnType<typeof real.spawn> => {
    events.push("spawn")
    return real.spawn(...args)
  }
  return { ...real, execSync: execSyncFake, execFile: execFileFake, spawn: spawnFake }
})

vi.mock("ink", () => ({
  render: vi.fn(() => ({ unmount: vi.fn() })),
}))

import { freeProxyDevPort, netstatListeners, startProxyDevApp } from "../src/app/proxy-dev-app.js"
import { beginDevSession, endDevSession } from "../src/dev-session.js"
import type { ProcessManager } from "../src/process-manager.js"
import { projectConfig } from "./support/project-config.js"

const { spawn: realSpawn } = await vi.importActual<typeof ChildProcessModule>("node:child_process")

let dir = ""
let manager: ProcessManager | null = null

afterEach(async () => {
  await manager?.stop()
  manager = null
  endDevSession()
  events.length = 0
  // Waited for: on Windows the app can outlive its stopped shim for a moment, holding its directory.
  await vi.waitUntil(removeDir, { timeout: 10_000, interval: 200 })
})

function removeDir(): boolean {
  try {
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function startApp(source: string, listener: "ours" | "foreign" = "ours"): void {
  dir = mkdtempSync(join(tmpdir(), "supatype-proxy-port-"))
  holder.commandLine =
    listener === "ours" ? `node ${join(dir, "node_modules", "vite", "bin", "vite.js")}` : "node /other-project/server.js"
  writeFileSync(join(dir, "fake-app.cjs"), source)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake", scripts: { start: "node fake-app.cjs" } }))
  const config = projectConfig({
    project: { name: "fake" },
    app: { mode: "proxy", start: "start", upstream: `http://localhost:${PORT}` },
  })
  manager = startProxyDevApp(dir, config, join(dir, ".pids"))
}

const UNTIL = { timeout: 15_000, interval: 50 }

describe("startProxyDevApp() freeing the app's port", () => {
  it("keeps the event loop running while the port is scanned, and spawns after the kill", async () => {
    beginDevSession("tui")
    setTimeout(() => events.push("timer"), 50)
    // Ends on its own: a package manager shim can leave it running after the stop kills the shim.
    startApp("setTimeout(() => {}, 1500)")
    await vi.waitUntil(() => events.includes("spawn"), UNTIL)
    expect(events).toEqual(["scan", "timer", "scanned", "describe", `kill ${STALE_PID}`, "spawn"])
  }, 20_000)

  it("frees the port again before each restart without blocking", async () => {
    beginDevSession("tui")
    startApp("process.exit(3)")
    await vi.waitUntil(() => events.filter((e) => e === "spawn").length >= 1, UNTIL)
    const ticker = setInterval(() => events.push("tick"), 50)
    await vi.waitUntil(() => events.filter((e) => e === "spawn").length >= 2, UNTIL)
    clearInterval(ticker)
    await manager?.stop()
    const restart = events.slice(events.indexOf("spawn") + 1, events.lastIndexOf("spawn") + 1)
    const scanning = restart.slice(restart.indexOf("scan"), restart.indexOf("scanned"))
    expect(scanning).toContain("tick")
    // The crashed run's own PID, from its PID file, has ended: it is neither looked up nor killed.
    expect(restart.filter((e) => e !== "tick")).toEqual(["scan", "scanned", "describe", `kill ${STALE_PID}`, "spawn"])
  }, 20_000)
})

describe("freeProxyDevPort() and the app's PID file", () => {
  it("looks a running PID-file process up with the listeners in one call, and kills it first", async () => {
    dir = mkdtempSync(join(tmpdir(), "supatype-proxy-port-"))
    holder.commandLine = `node ${join(dir, "server.js")}`
    const stale = realSpawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" })
    try {
      mkdirSync(join(dir, ".pids"))
      writeFileSync(join(dir, ".pids", "app.pid"), String(stale.pid))
      const app = { dir, command: "npm run start" }
      await expect(freeProxyDevPort(join(dir, ".pids"), Number(PORT), app)).resolves.toBeNull()
      expect(events).toEqual(["scan", "scanned", "describe", `kill ${stale.pid}`, `kill ${STALE_PID}`])
    } finally {
      stale.kill()
    }
  }, 20_000)

  it("skips a PID-file process that has ended", async () => {
    dir = mkdtempSync(join(tmpdir(), "supatype-proxy-port-"))
    holder.commandLine = `node ${join(dir, "server.js")}`
    const ended = realSpawn(process.execPath, ["-e", ""], { stdio: "ignore" })
    await new Promise((resolve) => ended.once("exit", resolve))
    mkdirSync(join(dir, ".pids"))
    writeFileSync(join(dir, ".pids", "app.pid"), String(ended.pid))
    await expect(freeProxyDevPort(join(dir, ".pids"), Number(PORT), { dir, command: "npm run start" })).resolves.toBeNull()
    expect(events).toEqual(["scan", "scanned", "describe", `kill ${STALE_PID}`])
  }, 20_000)
})

// 0.9.1 release test (FF22): two dev sessions proxying the same port each killed whatever held it
// before every start, so each one's app was ended by the other (exit 1, no error) every few seconds.
describe("startProxyDevApp() and a port another program holds", () => {
  it("does not kill it, does not start the app, and names the port and pid", async () => {
    const session = beginDevSession("tui")
    startApp("setTimeout(() => {}, 1500)", "foreign")
    const pane = (): readonly string[] => session.bus.getTask("app")?.lines ?? []
    await vi.waitUntil(() => events.includes("scanned"), UNTIL)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(events).not.toContain(`kill ${STALE_PID}`)
    expect(events).not.toContain("spawn")
    expect(pane()).toContain(`✗ port ${PORT} is used by another program (pid ${STALE_PID})`)
  }, 20_000)
})

describe("netstatListeners()", () => {
  it("takes only TCP listeners whose local address is on exactly the port", () => {
    const out = [
      "Active Connections",
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:5285           0.0.0.0:0              LISTENING       100",
      "  TCP    [::]:5285              [::]:0                 LISTENING       100",
      "  TCP    127.0.0.1:52851        0.0.0.0:0              LISTENING       200",
      "  TCP    127.0.0.1:60000        127.0.0.1:5285         ESTABLISHED     300",
      "  TCP    127.0.0.1:5285         127.0.0.1:60000        ESTABLISHED     100",
      "  UDP    0.0.0.0:5285           *:*                                    400",
      "  TCP    [::1]:5285             [::]:0                 LISTENING       500",
    ].join("\r\n")
    expect(netstatListeners(out, 5285)).toEqual([100, 500])
  })
})
