import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"

const DEV_SHUTDOWN = pathToFileURL(join(import.meta.dirname, "../src/dev-shutdown.ts")).href

/**
 * The end of `supatype dev` in a process of its own, with nothing else holding the event loop:
 * no watcher, no child app, no TUI reading stdin. That is `dev --stream --no-watch` with stdin
 * not a terminal, the way the zero-to-running soak runs it.
 *
 * Not a top-level await, because `dev` is not one either: it runs inside a commander action.
 */
function startDevTail(wait: "waitForDevShutdown" | "bare promise") {
  const dir = mkdtempSync(join(tmpdir(), "supatype-dev-hold-"))
  const script = join(dir, "dev-tail.mjs")
  writeFileSync(
    script,
    [
      "void (async () => {",
      `  const { registerDevShutdown, waitForDevShutdown } = await import(${JSON.stringify(DEV_SHUTDOWN)})`,
      '  registerDevShutdown(async () => { console.log("shutdown work ran") })',
      '  console.log("ready")',
      wait === "waitForDevShutdown"
        ? "  await waitForDevShutdown()"
        : "  await new Promise(() => undefined)",
      "})()",
      "",
    ].join("\n"),
  )
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: join(import.meta.dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let out = ""
  child.stdout.on("data", (d: Buffer) => { out += d.toString() })
  child.stderr.on("data", (d: Buffer) => { out += d.toString() })
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)))
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", () => { if (out.includes("ready")) resolve() })
    void exited.then(() => (out.includes("ready") ? resolve() : reject(new Error(`exited before ready:\n${out}`))))
  })
  return { child, exited, ready, output: () => out }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("supatype dev after it reports ready", () => {
  it("keeps running with nothing else holding it open, until a signal shuts it down", async () => {
    const dev = startDevTail("waitForDevShutdown")
    await dev.ready
    await settle(1500)
    expect(dev.child.exitCode).toBeNull()

    if (process.platform === "win32") {
      dev.child.kill()
      await dev.exited
      return
    }
    dev.child.kill("SIGTERM")
    expect(await dev.exited).toBe(0)
    expect(dev.output()).toContain("shutdown work ran")
  }, 30_000)

  // What it replaced, so the test above is known to catch the failure: the process ends on its
  // own, exit 0, without the shutdown work, and the exit hook is all that runs (in dev, a silent
  // `docker compose down` of the stack that just reported ready).
  it("is not held open by a bare pending promise", async () => {
    const dev = startDevTail("bare promise")
    await dev.ready
    expect(await dev.exited).toBe(0)
    expect(dev.output()).not.toContain("shutdown work ran")
  }, 30_000)
})
