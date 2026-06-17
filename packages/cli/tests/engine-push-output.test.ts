import { describe, expect, it } from "vitest"
import {
  filterComposeNoise,
  formatEnginePushMessage,
  parseEnginePushOutput,
} from "../src/engine-push-output.js"

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
    ).toBe("Schema up to date — Studio metadata synced.")
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
