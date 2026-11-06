import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { recordExit } from "./support/process-exit.js"

/**
 * Issue 33: Ctrl+C on `supatype dev` printed "Shutting down compose...", then "Docker is installed
 * but the daemon is not running... Docker did not answer within 15s", with Docker up the whole time.
 *
 * The shutdown's `docker compose down` went through the daemon gate every compose command has
 * (`docker version`, then `docker info`, each given 15 s). A Docker Desktop busy enough to be slow
 * with `docker info` made that gate say the daemon was down and exit 1 before `down` ran; the exit
 * hook's fallback `down` then stopped the stack, so the stop worked and the message was false.
 *
 * Here every probe call times out and `compose down` succeeds: the shutdown must still bring the
 * stack down, and must not claim the daemon is not running.
 */

const docker = vi.hoisted(() => ({ calls: [] as string[][] }))

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const timedOut = Object.assign(new Error("spawnSync docker ETIMEDOUT"), { code: "ETIMEDOUT" })
  const fake = (_command: string, args: readonly string[] = []) => {
    docker.calls.push([...args])
    // `compose down` itself answers; only the daemon probe's `version` and `info` are slow.
    if (args[0] === "compose") return { status: 0, stdout: "", stderr: "", pid: 0, output: [], signal: null }
    return { status: null, stdout: "", stderr: "", pid: 0, output: [], signal: "SIGKILL", error: timedOut }
  }
  return { ...actual, spawnSync: fake }
})

import { stopDevComposeStack, type DevComposeShutdownState } from "../src/dev-compose.js"

let cwd: string
let printed: string[]

/** Everything the code under test prints, through console or straight to the streams. */
function capturePrinted(): void {
  printed = []
  const keep = (...parts: unknown[]): void => {
    printed.push(parts.map(String).join(" "))
  }
  for (const method of ["log", "warn", "error", "info"] as const) vi.spyOn(console, method).mockImplementation(keep)
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => (keep(chunk), true))
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => (keep(chunk), true))
}

function emptyState(): DevComposeShutdownState {
  return { studioProc: null, appProc: null, schemaWatcher: null, functionsWatcher: null }
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "supatype-shutdown-probe-"))
  docker.calls.length = 0
  capturePrinted()
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

describe("stopping dev's compose stack while Docker is slow to answer a probe", () => {
  it("brings the stack down and does not say the daemon is not running", async () => {
    const { exit, restore } = recordExit()
    try {
      await stopDevComposeStack(emptyState(), { project: "demo", composePath: join(cwd, "docker-compose.yml") }, cwd)
    } finally {
      restore()
    }
    const output = printed.join("\n")
    expect(output).not.toMatch(/daemon is not running/i)
    expect(output).not.toMatch(/did not answer within/i)
    expect(exit).not.toHaveBeenCalled()
    expect(docker.calls.some((args) => args[0] === "compose" && args.at(-1) === "down")).toBe(true)
    expect(output).toContain("Compose stack stopped.")
  })
})
