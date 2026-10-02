import { afterEach, describe, expect, it, vi } from "vitest"
import {
  filterComposeNoise,
  formatEnginePushMessage,
  parseEnginePushOutput,
  printPushWarnings,
} from "../src/engine-push-output.js"

describe("printPushWarnings()", () => {
  afterEach(() => vi.restoreAllMocks())

  function printed(run: () => void): string {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    run()
    return log.mock.calls.map((call) => call.join(" ")).join("\n")
  }

  it("prints what a push warned about", () => {
    const out = printed(() =>
      printPushWarnings(parseEnginePushOutput('{"status":"up_to_date","warnings":["Bucket \\"a\\" declares no delete rule"]}')!),
    )
    expect(out).toContain('[!] Bucket "a" declares no delete rule')
  })

  it("leaves out what the diff before it already showed", () => {
    const out = printed(() => printPushWarnings({ warnings: ["shown", "found after applying"] }, ["shown"]))
    expect(out).toContain("found after applying")
    expect(out).not.toContain("shown\n")
    expect(out).toContain("1 warning(s)")
  })

  it("prints nothing when there is nothing new", () => {
    expect(printed(() => printPushWarnings({ warnings: ["shown"] }, ["shown"]))).toBe("")
  })
})

describe("parseEnginePushOutput()", () => {
  it("parses JSON on its own line amid docker progress", () => {
    const output = [
      " Container supatype-to-do-db-1 Running",
      " Container supatype-to-do-db-1 Waiting",
      " Container supatype-to-do-db-1 Healthy",
      '{"status":"up_to_date","operations":0,"admin_refreshed":true}',
      " Container supatype-to-do-schema-engine-run-abc Created",
    ].join("\n")

    expect(parseEnginePushOutput(output)).toEqual({
      status: "up_to_date",
      operations: 0,
      admin_refreshed: true,
    })
  })

  it("parses bare JSON output", () => {
    expect(parseEnginePushOutput('{"status":"applied","operations":2}')).toEqual({
      status: "applied",
      operations: 2,
    })
  })

  it("returns null when no JSON present", () => {
    expect(parseEnginePushOutput("engine failed: connection refused")).toBeNull()
  })
})

describe("formatEnginePushMessage()", () => {
  it("formats up_to_date with admin refresh", () => {
    expect(
      formatEnginePushMessage({ status: "up_to_date", operations: 0, admin_refreshed: true }),
    ).toBe("Schema up to date, Studio metadata synced.")
  })

  it("formats up_to_date without admin refresh", () => {
    expect(formatEnginePushMessage({ status: "up_to_date" })).toBe("Schema up to date.")
  })

  it("formats applied operations", () => {
    expect(formatEnginePushMessage({ status: "applied", operations: 3 })).toBe(
      "Applied 3 operation(s).",
    )
  })
})

describe("filterComposeNoise()", () => {
  it("removes container progress lines but keeps errors", () => {
    const output = [
      " Container supatype-to-do-db-1 Running",
      "engine error: permission denied",
      '{"status":"up_to_date","operations":0}',
    ].join("\n")

    expect(filterComposeNoise(output)).toBe(
      'engine error: permission denied\n{"status":"up_to_date","operations":0}',
    )
  })
})
