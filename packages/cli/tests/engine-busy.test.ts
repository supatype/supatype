import { describe, expect, it } from "vitest"
import { ENGINE_BUSY, EngineError, engineBusyMessage } from "../src/engine-client.js"
import { isEngineBusy } from "../src/adopt-walkthrough.js"
import { TargetApiError } from "../src/target-client.js"

const STDERR = [
  "\u001b[2m2026-10-09T12:00:00Z\u001b[0m \u001b[32m INFO\u001b[0m supatype-engine starting version=0.7.0",
  "Error: another push, adopt or rebaseline is running on this database; try again. Nothing was applied.",
].join("\n")

describe("engineBusyMessage()", () => {
  it("is the engine's own sentence, without the log lines or the exit code", () => {
    expect(engineBusyMessage("", STDERR)).toBe(
      "Another push, adopt or rebaseline is running on this database; try again. Nothing was applied.",
    )
  })

  it("reads a JSON refusal on stdout too", () => {
    expect(engineBusyMessage(JSON.stringify({ status: "refused", reason: "engine_busy" }), STDERR)).toMatch(/^Another push/)
    expect(engineBusyMessage(JSON.stringify({ reason: "engine_busy", message: "busy now" }), "")).toBe("busy now")
  })

  it("is undefined for any other failure", () => {
    expect(engineBusyMessage("", "Error: relation does not exist")).toBeUndefined()
    expect(engineBusyMessage('{"reason":"security_drift"}', "Error: x")).toBeUndefined()
  })
})

describe("isEngineBusy()", () => {
  it("knows the binary's refusal and a server's 409", () => {
    expect(isEngineBusy(new EngineError("Another push…", "/adopt", 1, "", ENGINE_BUSY))).toBe(true)
    expect(isEngineBusy(new EngineError("Engine /adopt failed (exit 1): x", "/adopt", 1))).toBe(false)
    expect(isEngineBusy(new TargetApiError("another push, adopt or rebaseline is running", 409, "engine_busy"))).toBe(true)
    expect(isEngineBusy(new TargetApiError("conflict", 409))).toBe(false)
    expect(isEngineBusy(new Error("another push, adopt or rebaseline is running"))).toBe(false)
  })
})
