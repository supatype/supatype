import { afterEach, describe, expect, it } from "vitest"
import { ProcessManager } from "../src/process-manager.js"
import { cliModule, runScriptInChild } from "./support/child-script.js"
import { alive, cleanupProcessTrees, fakeProcessTree, until, workerPid } from "./support/process-tree-fixture.js"

/**
 * 0.9.1 release test, FF12: native dev's server starts the Deno functions worker as a child of its
 * own. Stopping the server ended the server alone, so after Ctrl+C the worker kept the functions
 * port and the next `supatype dev` refused it as taken. Here a fake server starts a worker the same
 * way, and what is checked is that the worker is gone too.
 */
afterEach(cleanupProcessTrees)

describe("stopping a process that started processes of its own", () => {
  it("stops them too", async () => {
    const server = fakeProcessTree()
    const proc = new ProcessManager(process.execPath, [server.script, server.pidFile], { label: "server", pidDir: server.dir })
    proc.start()
    const worker = await workerPid(server)
    expect(alive(worker)).toBe(true)
    await proc.stop()
    expect(await until(() => !alive(worker), 3_000)).toBe(true)
  }, 30_000)

  it("stops them when dev ends without stopping it, as a crash does", async () => {
    const server = fakeProcessTree()
    const { out } = await runScriptInChild([
      `const { ProcessManager } = await import(${cliModule("process-manager.ts")})`,
      "const fs = await import('node:fs')",
      `const proc = new ProcessManager(process.execPath, [${JSON.stringify(server.script)}, ${JSON.stringify(server.pidFile)}], { label: "server", pidDir: ${JSON.stringify(server.dir)} })`,
      "proc.start()",
      `while (!fs.existsSync(${JSON.stringify(server.pidFile)})) await new Promise((r) => setTimeout(r, 50))`,
      "await new Promise((r) => setTimeout(r, 200))",
      "throw new Error('dev crashed')",
    ])
    expect(out).toContain("dev crashed")
    const worker = await workerPid(server)
    expect(await until(() => !alive(worker), 3_000)).toBe(true)
  }, 30_000)
})
