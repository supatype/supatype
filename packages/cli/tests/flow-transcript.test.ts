import { describe, expect, it } from "vitest"
import { FlowTranscript } from "../src/ui/runtime/flow-transcript.js"
import type { FlowController } from "../src/ui/flows/types.js"

/**
 * Issue 67: in a terminal, a one-shot command runs inside the Ink chrome, and the chrome is cleared
 * when the command ends. Everything the command logged went with it: `seed --status` showed nothing,
 * while piped output, which has no chrome, showed the line. The lines on screen at the end are now
 * written out again once the chrome is gone.
 */
function controller(): FlowController {
  return {
    appendLog: () => {},
    appendPlain: () => {},
    setSpinner: () => {},
    waitForPrompt: async () => undefined,
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
