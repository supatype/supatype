import type * as ChildProcessModule from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Freeing the app's port ran `netstat` synchronously, and on Windows it took ten seconds: the
 * dashboard and every process's output froze before the app's first start and again before each
 * restart. Here the port scan takes a second, whichever way it is run, and a timer due at 50 ms
 * has to fire while it does. The app is still only spawned once the scan and the kill are done.
 */
const { SCAN_MS, STALE_PID, PORT, events } = vi.hoisted(() => ({
  SCAN_MS: 1_000,
  STALE_PID: 4242,
  PORT: "5299",
  events: [] as string[],
}))

/** What the scan prints: a stale listener on the app's port, and one on a port that only starts the same. */
function scanOutput(port: string): string {
  return process.platform === "win32"
    ? `  TCP    0.0.0.0:${port}    0.0.0.0:0    LISTENING    ${STALE_PID}\r\n  TCP    0.0.0.0:${port}1    0.0.0.0:0    LISTENING    99\r\n`
    : `${STALE_PID}\n`
}

/** Which faked command a command line is, if any: the port scan or a kill. */
function faked(command: string): "scan" | "kill" | null {
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
  const execFileFake = (bin: string, args: readonly string[], ...rest: unknown[]): void => {
    const callback = rest.find((r): r is ExecFileCallback => typeof r === "function")
    const kind = faked(`${bin} ${args.join(" ")}`)
    // Anything else fails as a command would: dev's parent watch asks PowerShell for its parent.
    if (kind === null || callback === undefined) {
      setImmediate(() => callback?.(new Error(`not faked: ${bin}`), "", ""))
      return
    }
    if (kind === "kill") {
      events.push(`kill ${args.find((a) => /^\d+$/.test(a)) ?? "?"}`)
      setImmediate(() => callback(null, "", ""))
      return
    }
    events.push("scan")
    setTimeout(() => {
      events.push("scanned")
      callback(null, scanOutput(PORT), "")
    }, SCAN_MS)
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

import { netstatListeners, startProxyDevApp } from "../src/app/proxy-dev-app.js"
import { beginDevSession, endDevSession } from "../src/dev-session.js"
import type { ProcessManager } from "../src/process-manager.js"
import { projectConfig } from "./support/project-config.js"

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

function startApp(source: string): void {
  dir = mkdtempSync(join(tmpdir(), "supatype-proxy-port-"))
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
    expect(events).toEqual(["scan", "timer", "scanned", `kill ${STALE_PID}`, "spawn"])
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
    // The crashed run's own PID, from its PID file, is killed first in case it left children behind.
    expect(restart.filter((e) => e !== "tick")).toEqual([
      expect.stringMatching(/^kill \d+$/),
      "scan",
      "scanned",
      `kill ${STALE_PID}`,
      "spawn",
    ])
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
