import { afterEach, describe, expect, it, vi } from "vitest"

// Before Ink loads: with CI=true it draws nothing until it unmounts.
vi.hoisted(() => {
  vi.stubEnv("CI", "false")
})

import { beginDevSession, endDevSession, getActiveDevSession } from "../src/dev-session.js"
import { stopQuietlyDuringStart } from "../src/dev-shutdown.js"
import { reportCliFatal } from "../src/ui/fatal.js"
import { fakeTty, tick } from "./support/fake-tty.js"

/**
 * 0.9.2 release test N-FF6: a start that failed on the dashboard (a db volume whose password .env no
 * longer matched, under SUPATYPE_STRICT=1) exited 1 on the dashboard's last frame, "Starting
 * Postgres" and a spinner, with no error anywhere on screen. `dev --stream` printed the error. The
 * dashboard held the console as the CLI reported the failure, so the message went to its pane.
 */
afterEach(() => {
  endDevSession()
  vi.restoreAllMocks()
})

describe("a dev start that fails on the dashboard", () => {
  it("takes the dashboard down, so the error is printed on the terminal after it", async () => {
    const printed: string[] = []
    const keep = (...args: unknown[]): void => void printed.push(args.map(String).join(" "))
    vi.spyOn(console, "log").mockImplementation(keep)
    vi.spyOn(console, "error").mockImplementation(keep)
    const tty = fakeTty(120, 40)
    beginDevSession("tui", { stdin: tty.stdin, stdout: tty.stdout })
    await tick()

    const failure = "password authentication failed for user \"supatype_admin\""
    const start = stopQuietlyDuringStart(async () => {
      throw new Error(failure)
    })
    // As cli.ts reports what a command threw.
    await start().catch(reportCliFatal)

    expect(printed.join("\n")).toContain(failure)
    expect(getActiveDevSession()).toBeNull()
  }, 10_000)
})
