import { afterEach, describe, expect, it, vi } from "vitest"

// Before Ink loads: with CI=true it draws nothing until it unmounts, and these tests read the frames
// it draws as the dashboard changes.
vi.hoisted(() => {
  vi.stubEnv("CI", "false")
})

vi.mock("../src/dev-shutdown.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dev-shutdown.js")>()),
  requestDevShutdown: vi.fn(),
}))

import type { Instance } from "ink"
import { DevLogBus } from "../src/dev-log-bus.js"
import { requestDevShutdown } from "../src/dev-shutdown.js"
import { DevSession, renderDevDashboard, withSavePushOutput } from "../src/dev-session.js"
import { reportAppliedPush } from "../src/engine-push-output.js"
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
  instance = renderDevDashboard(bus, { stdin: tty.stdin, stdout: tty.stdout })
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

// The supatype pane stayed at "Services running." through every save: Ink's own console patch,
// taken when the dashboard mounted, sent the push's lines past the pane, and the pane's filter
// dropped the access lines a save changed. `dev --stream` printed all of it.
describe("a save's push on the dashboard", () => {
  it("shows what the save did on the supatype pane, once each", async () => {
    const tty = fakeTty(160, 50)
    const session = new DevSession("tui")
    session.enableConsoleCapture(false)
    session.startInk({ stdin: tty.stdin, stdout: tty.stdout })
    try {
      await tick()
      await withSavePushOutput(async () => {
        console.log("\n[supatype] Change detected in index.ts, pushing schema...")
        reportAppliedPush({
          status: "applied",
          operations: 2,
          access: [{ model: "Post", table: "posts", role: "anon", before: [], after: ["read"] }],
        })
        console.log("[supatype] Types written to src/supatype.ts")
      })
      await tick()
      expect(session.bus.getTask("stack")?.lines).toEqual([
        "Change detected in index.ts, pushing schema...",
        "Applied 2 operation(s).",
        "Access for anon (signed out):",
        "  posts   none -> read",
        "Types written to src/supatype.ts",
      ])
      expect(tty.drawn()).toContain("none -> read")
    } finally {
      session.stop()
    }
  })
})
