import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { NativeDevState } from "../src/native-leftover-postgres.js"
import { stopLeftoverServices } from "../src/native-leftover-services.js"
import { pidAlive } from "../src/parent-watch.js"
import { ProcessManager, readPidRecord } from "../src/process-manager.js"
import { isPortInUse } from "../src/postgres-ctl.js"
import { freePort } from "./support/ports.js"

vi.mock("../src/ui/fatal.js", () => ({
  fatalError: (message: string, hints: string[] = []): never => {
    throw new Error([message, ...hints].join("\n"))
  },
}))

const { claimNativeDevPorts } = await import("../src/commands/dev.js")

/**
 * 0.9.2 release test round 2 (FF12 remainder, Linux): a SIGKILL of the dev CLI left every service
 * running, each in a process group of its own, and the next `supatype dev` refused their ports
 * instead of stopping them, as it already does for the project's own Postgres.
 */

const roots: string[] = []
const started: number[] = []
afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Already ended, which is what most tests want.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** A project's state directory, with a script that runs until killed standing in for a service. */
function project(scriptDir = "bin"): { state: NativeDevState; script: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "supatype-leftover-svc-"))
  roots.push(root)
  mkdirSync(join(root, scriptDir), { recursive: true })
  const script = join(root, scriptDir, "fake-service.mjs")
  writeFileSync(script, "setInterval(() => {}, 1000)\n")
  const state = { dataDir: join(root, "data"), pidDir: join(root, "pid") }
  mkdirSync(state.pidDir, { recursive: true })
  return { state, script, root }
}

/** Runs `node <child>` from a launcher that exits at once, as a dev that was killed leaves it. */
function orphan(child: string, launcherArgs: string[] = []): number {
  const launch = `const c = require("child_process").spawn(process.execPath, ${JSON.stringify([child, ...launcherArgs])}, { detached: true, stdio: "ignore" }); c.unref(); console.log(c.pid)`
  const run = spawnSync(process.execPath, ["-e", launch], { encoding: "utf8" })
  const pid = Number(run.stdout.trim())
  started.push(pid)
  return pid
}

/** The id of a process that has already exited. */
function deadPid(): number {
  const run = spawnSync(process.execPath, ["-e", ""])
  if (run.pid === undefined) throw new Error("could not start a process to take a dead pid from")
  return run.pid
}

function writePidFile(state: NativeDevState, label: string, lines: Array<string | number>): void {
  writeFileSync(join(state.pidDir, `${label}.pid`), `${lines.join("\n")}\n`)
}

async function endsWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !pidAlive(pid)
}

describe("services a killed native dev left running", () => {
  it("are stopped, and their pid files removed", async () => {
    const { state, script } = project()
    const pid = orphan(script)
    writePidFile(state, "server", [pid, script])
    writePidFile(state, "dev", [deadPid()])
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    await stopLeftoverServices(state)

    expect(await endsWithin(pid, 10_000)).toBe(true)
    expect(existsSync(join(state.pidDir, "server.pid"))).toBe(false)
  })

  it("leave a process whose command line is not the program the pid file records", async () => {
    const { state, script, root } = project()
    const pid = orphan(script)
    writePidFile(state, "server", [pid, join(root, "elsewhere", "supatype-server")])

    await stopLeftoverServices(state)

    expect(pidAlive(pid)).toBe(true)
  })

  it("leave everything while the project's dev still runs", async () => {
    const { state, script } = project()
    const pid = orphan(script)
    writePidFile(state, "server", [pid, script])
    writePidFile(state, "dev", [orphan(script)])

    await stopLeftoverServices(state)

    expect(pidAlive(pid)).toBe(true)
  })

  it("leave a process whose parent is a running supatype dev, so a reused pid is never taken", async () => {
    // Another project's `supatype dev`, still running its own server under a pid this file names.
    const { state, script } = await serviceUnderParent("supatype.js", ["dev"])
    await stopLeftoverServices(state)
    expect(pidAlive(script.child)).toBe(true)
  })

  it("are stopped when their parent only runs from a folder named supatype", async () => {
    // An editor or package manager working in a checkout called supatype is no dev.
    const { state, script } = await serviceUnderParent("watcher.js", [])
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    await stopLeftoverServices(state)
    expect(await endsWithin(script.child, 10_000)).toBe(true)
  })
})

/** A project whose server pid file names a service started by a parent at `supatype/<name>`. */
async function serviceUnderParent(name: string, args: string[]): Promise<{ state: NativeDevState; script: { child: number } }> {
  const { state, script, root } = project("supatype")
  const parent = join(root, "supatype", name)
  const childFile = join(root, "child.pid")
  writeFileSync(parent, [
    `const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(script)}], { stdio: "ignore" })`,
    `require("node:fs").writeFileSync(${JSON.stringify(childFile)}, String(child.pid))`,
    "setInterval(() => {}, 1000)",
  ].join("\n"))
  orphan(parent, args)
  const child = await pidWritten(childFile)
  started.push(child)
  writePidFile(state, "server", [child, script])
  return { state, script: { child } }
}

/** The pid written to `file`, once it has been. */
async function pidWritten(file: string): Promise<number> {
  await vi.waitFor(() => expect(existsSync(file)).toBe(true), { timeout: 10_000 })
  return Number(readFileSync(file, "utf8").trim())
}

describe("a service's pid file", () => {
  it("records the program it runs, beside its pid", async () => {
    const { state, script } = project()
    const proc = new ProcessManager(process.execPath, [script], { label: "server", pidDir: state.pidDir, colour: "" })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    proc.start()
    try {
      await vi.waitFor(() => expect(readPidRecord(state.pidDir, "server")).toMatchObject({ signature: script }))
    } finally {
      await proc.stop()
    }
  })
})

describe("native dev's start", () => {
  it("stops a service a killed dev left on its port, instead of refusing the port", async () => {
    const { state, root } = project()
    const port = await freePort()
    const listener = join(root, "bin", "listener.mjs")
    writeFileSync(listener, `import { createServer } from "node:net"\ncreateServer().listen(${port}, "127.0.0.1")\n`)
    const pid = orphan(listener)
    writePidFile(state, "server", [pid, listener])
    await vi.waitFor(async () => expect(await isPortInUse(port)).toBe(true), { timeout: 10_000 })
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    const ports = { postgres: await freePort(), server: port, postgrest: await freePort(), realtime: await freePort() }
    const claim = await claimNativeDevPorts(ports, state)
    claim.postgrest.release()

    expect(pidAlive(pid)).toBe(false)
  })
})
