import { afterEach, describe, expect, it } from "vitest"
import { cliModule, runScriptInChild } from "./support/child-script.js"
import { alive, cleanupProcessTrees, fakeProcessTree, until, workerPid, type FakeProcessTree } from "./support/process-tree-fixture.js"

/**
 * `functions serve` runs Deno through runUntilStopped, and Deno starts processes of its own (what a
 * function runs). A stop ended Deno alone, so what it started kept running and could hold the port
 * (0.9.1 release test, FF12, applied to `functions serve`). The signal is emitted in the child, so
 * this runs on Windows too, where a sent SIGTERM ends a process outright.
 */
afterEach(cleanupProcessTrees)

/** A `functions serve` running the fake tree in place of Deno, then `then`. */
function serve(tree: FakeProcessTree, then: string[]): string[] {
  const args = `[${JSON.stringify(tree.script)}, ${JSON.stringify(tree.pidFile)}]`
  return [
    `const { runUntilStopped } = await import(${cliModule("run-until-stopped.ts")})`,
    "const fs = await import('node:fs')",
    `const served = runUntilStopped(process.execPath, ${args}, { cwd: process.cwd(), env: process.env })`,
    `while (!fs.existsSync(${JSON.stringify(tree.pidFile)})) await new Promise((r) => setTimeout(r, 50))`,
    "await new Promise((r) => setTimeout(r, 200))",
    ...then,
  ]
}

describe("stopping functions serve", () => {
  it("ends what Deno started on a stop request", async () => {
    const tree = fakeProcessTree()
    const stop = ['process.emit("SIGTERM", "SIGTERM")', "const status = await served", 'console.log("status " + status)', "process.exit(status)"]
    const { code, out } = await runScriptInChild(serve(tree, stop))
    expect(out).toContain("status 0")
    expect(code).toBe(0)
    const worker = await workerPid(tree)
    expect(await until(() => !alive(worker), 3_000)).toBe(true)
  }, 30_000)

  it("ends what Deno started when the CLI ends without stopping it, as a crash does", async () => {
    const tree = fakeProcessTree()
    const { out } = await runScriptInChild(serve(tree, ["void served", "throw new Error('serve crashed')"]))
    expect(out).toContain("serve crashed")
    const worker = await workerPid(tree)
    expect(await until(() => !alive(worker), 3_000)).toBe(true)
  }, 30_000)
})
