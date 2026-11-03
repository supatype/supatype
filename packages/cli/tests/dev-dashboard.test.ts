import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/dev-shutdown.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dev-shutdown.js")>()),
  requestDevShutdown: vi.fn(),
}))

import type { Instance } from "ink"
import { DevLogBus } from "../src/dev-log-bus.js"
import { requestDevShutdown } from "../src/dev-shutdown.js"
import { renderDevDashboard } from "../src/dev-session.js"
import { enqueueDevPrompt, resetDevPromptQueueForTests } from "../src/ui/runtime/dev-prompt-queue.js"
import { fakeTty, tick, type FakeTty } from "./support/fake-tty.js"

/** The `supatype dev` dashboard as dev mounts it, on a fake terminal. */

let instance: Instance | undefined

afterEach(() => {
  instance?.unmount()
  instance = undefined
  vi.mocked(requestDevShutdown).mockClear()
  resetDevPromptQueueForTests()
})

/** The dashboard on a fake terminal, given a moment to subscribe to `bus`. */
async function mount(bus: DevLogBus): Promise<FakeTty & { instance: Instance }> {
  const tty = fakeTty(120, 40)
  // Ink wraps the console in a Console of its own, which vitest's console cannot construct.
  instance = renderDevDashboard(bus, { stdin: tty.stdin, stdout: tty.stdout, patchConsole: false })
  await tick()
  return { ...tty, instance }
}

describe("the dev dashboard", () => {
  // Ink handled Ctrl+C itself by default: the first one unmounted the dashboard and nothing else,
  // so dev kept running without a screen until a second Ctrl+C reached it as a signal.
  it("starts dev's shutdown on the first Ctrl+C, and stays up while it runs", async () => {
    const tty = await mount(new DevLogBus())
    let exited = false
    void tty.instance.waitUntilExit().then(() => {
      exited = true
    })

    tty.stdin.write("\x03")
    await tick()

    expect(requestDevShutdown).toHaveBeenCalledTimes(1)
    expect(exited).toBe(false)
  })

  // The start used to show the logo over an idle log while Docker pulled images for minutes.
  it("names the step dev is waiting on, until the stack is up", async () => {
    const bus = new DevLogBus()
    const tty = await mount(bus)
    bus.setStep("Starting Postgres")
    await tick()
    expect(tty.drawn()).toContain("Starting Postgres")

    tty.clear()
    bus.setReadyPanel({ title: "Services running", links: [{ label: "API", url: "http://localhost:18479" }] })
    await tick()
    expect(tty.drawn()).toContain("Services running")
    expect(tty.drawn()).not.toContain("Starting Postgres")
  })

  // A question waits on the person, not on a step: its spinner would say dev is busy when it is not.
  it("hides the step while a question is on screen", async () => {
    const bus = new DevLogBus()
    const tty = await mount(bus)
    bus.setStep("Checking for an admin user")
    void enqueueDevPrompt({ kind: "confirm", message: "Create an admin user now?", initialValue: false })
    await tick()
    tty.clear()
    bus.setStep("Checking for an admin user")
    await tick()
    expect(tty.drawn()).toContain("Create an admin user now?")
    expect(tty.drawn()).not.toContain("Checking for an admin user")
  })
})
