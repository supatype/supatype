import { describe, expect, it } from "vitest"
import { FlowTranscript } from "../src/ui/runtime/flow-transcript.js"
import type { FlowController } from "../src/ui/flows/types.js"

/**
 * Issue 77: a command that calls `process.exit` inside its Ink chrome goes before Ink writes the
 * frame it holds, so `types check` showed the banner and not its reason. The lines the pane shows
 * are kept here, and written out in the frame's place when that happens.
 */
function controller(): FlowController {
  return {
    appendLog: () => {},
    appendPlain: () => {},
    setSpinner: () => {},
    waitForPrompt: async () => undefined,
    finish: async () => undefined,
  }
}

describe("FlowTranscript", () => {
  it("keeps what the log pane shows, as plain terminal text", () => {
    const transcript = new FlowTranscript()
    const recorded = transcript.record(controller())
    recorded.appendLog("info", "  seeds/01-tasks.ts  committed")
    recorded.appendLog("warn", "careful")
    recorded.appendPlain("as it is")
    const text = transcript.text()
    expect(text).toContain("seeds/01-tasks.ts  committed")
    expect(text).toContain("⚠ careful")
    expect(text.endsWith("as it is\n")).toBe(true)
  })

  it("drops what a prompt cleared from the pane", async () => {
    const transcript = new FlowTranscript()
    const recorded = transcript.record(controller())
    recorded.appendLog("info", "before the question")
    await recorded.waitForPrompt({ kind: "confirm", message: "Go?", initialValue: true })
    recorded.appendLog("success", "after it")
    expect(transcript.text()).not.toContain("before the question")
    expect(transcript.text()).toContain("✓ after it")
  })

  it("is empty when nothing was logged", () => {
    expect(new FlowTranscript().text()).toBe("")
  })
})
