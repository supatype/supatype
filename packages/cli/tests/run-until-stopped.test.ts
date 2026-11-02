import { describe, expect, it } from "vitest"
import { runUntilStopped } from "../src/run-until-stopped.js"

/**
 * `functions serve` runs Deno through this. Ctrl+C reaches Deno as well as the CLI, and Deno can
 * exit from it before the CLI hears the signal, so a deliberate stop used to be reported as
 * "Function server exited with errors." and exit 1.
 */
function exitWith(source: string): Promise<number> {
  return runUntilStopped(process.execPath, ["-e", source], { cwd: process.cwd(), env: process.env })
}

describe("runUntilStopped", () => {
  it("resolves to the command's exit code", async () => {
    expect(await exitWith("process.exit(3)")).toBe(3)
  })

  it("takes the exit code of a command stopped with Ctrl+C as a clean stop", async () => {
    expect(await exitWith("process.exit(130)")).toBe(0)
  })

  it.skipIf(process.platform === "win32")("takes a command ended by SIGINT as a clean stop", async () => {
    expect(await exitWith("process.kill(process.pid, 'SIGINT')")).toBe(0)
  })

  it("rejects when the command cannot start", async () => {
    await expect(
      runUntilStopped("supatype-no-such-command", [], { cwd: process.cwd(), env: process.env }),
    ).rejects.toThrow()
  })
})
