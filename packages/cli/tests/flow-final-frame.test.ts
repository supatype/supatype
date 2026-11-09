import { afterEach, describe, expect, it, vi } from "vitest"
import { mountFlowOn } from "../src/ui/runtime/run-clack-flow.js"
import { fakeTty, tick } from "./support/fake-tty.js"
import { recordExit } from "./support/process-exit.js"
import { linesHolding, terminalScreen } from "./support/terminal-screen.js"

/**
 * What a one-shot command leaves on screen when its Ink chrome comes down.
 *
 * Issue 67: the chrome was cleared at the end and the log pane went with it, so `seed --status`
 * showed nothing. Issue 68: the fix wrote the pane's lines again after the clear, but Ink still had
 * the last frame queued behind its redraw throttle, so the frame came back after the clear and
 * every line showed twice. Issue 77: `types check` logged its reason and called `process.exit`
 * before Ink drew it, so the terminal showed the banner and nothing else.
 */

afterEach(() => {
  vi.restoreAllMocks()
})

describe("a flow's last frame", () => {
  it("leaves each logged line on screen once, without the banner or spinner", async () => {
    const tty = fakeTty(120, 40)
    await mountFlowOn(async (api) => {
      const spin = api.spinner()
      spin.start("Reading seeds")
      await tick(10)
      api.log.info("  seeds/01-demo.ts   committed")
      api.note("  seed.ts            committed")
      spin.stop("Read")
    }, tty)
    await tick(150)
    const screen = terminalScreen(tty.drawn())
    expect(linesHolding(screen, "seeds/01-demo.ts   committed")).toBe(1)
    expect(linesHolding(screen, "seed.ts            committed")).toBe(1)
    // Once, as the line above the work's: the spinner itself is gone.
    expect(linesHolding(screen, "Reading seeds")).toBe(1)
    expect(screen.filter((line) => line.trim() !== "").map((line) => line.trim())).toEqual([
      "Reading seeds",
      "seeds/01-demo.ts   committed",
      "seed.ts            committed",
      "Read",
    ])
  })

  it("keeps the lines a command logged in its last moment", async () => {
    const tty = fakeTty(120, 40)
    await mountFlowOn(async (api) => {
      await tick(40)
      api.log.info("first")
      api.log.success("last")
    }, tty)
    await tick(150)
    const screen = terminalScreen(tty.drawn())
    expect(linesHolding(screen, "first")).toBe(1)
    expect(linesHolding(screen, "last")).toBe(1)
  })

  it("shows the reason a command gave before it exited", async () => {
    const tty = fakeTty(120, 40)
    let atExit: string[] = []
    vi.spyOn(process, "exit").mockImplementation((code) => {
      // The process ends here: what is on screen now is what the user is left with.
      atExit = terminalScreen(tty.drawn())
      throw new Error(`exit ${String(code)}`)
    })
    await expect(
      mountFlowOn(async (api) => {
        api.log.error("Missing tsconfig.json in project root.")
        process.exit(1)
      }, tty),
    ).rejects.toThrow("exit 1")
    expect(linesHolding(atExit, "Missing tsconfig.json in project root.")).toBe(1)
  })

  it("draws nothing more after a Ctrl+C has already ended Ink", async () => {
    const tty = fakeTty(120, 40)
    const { exit, restore } = recordExit()
    try {
      let stop: () => void = () => undefined
      const running = mountFlowOn(async (api) => {
        api.log.info("working on it")
        await new Promise<void>((resolve) => {
          stop = resolve
        })
      }, tty)
      await tick(100)
      tty.stdin.write("\x03")
      await tick(100)
      expect(exit).toHaveBeenCalledWith(130)
      stop()
      await running
      await tick(150)
      expect(linesHolding(terminalScreen(tty.drawn()), "working on it")).toBe(1)
    } finally {
      restore()
    }
  })
})
