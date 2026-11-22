import { describe, expect, it } from "vitest"
import {
  REMOTE_SEED_FEATURE,
  REMOTE_SEED_MAX_FILES,
  REMOTE_SEED_MESSAGES,
  REMOTE_SEED_REFUSALS,
  formatRemoteSeedRefusal,
  isRemoteSeedRefusal,
  parseRemoteSeedRequest,
} from "../src/index.js"

const VALID = {
  ast: { models: [] },
  irDocuments: ['{"file":"seed.ts","operations":[]}'],
  atomic: false,
  runOnce: true,
  confirmProduction: false,
}

describe("parseRemoteSeedRequest", () => {
  it("accepts a well formed body and keeps the documents as the exact strings sent", () => {
    const parsed = parseRemoteSeedRequest({ ...VALID, environment: "staging", pushedFrom: "ci" })
    expect(parsed).toEqual({ ...VALID, environment: "staging", pushedFrom: "ci" })
  })

  it("leaves optional fields out when they were not sent", () => {
    expect(parseRemoteSeedRequest(VALID)).toEqual(VALID)
  })

  it.each([
    ["not an object", []],
    ["no ast", { ...VALID, ast: undefined }],
    ["no documents", { ...VALID, irDocuments: [] }],
    ["a document that is not a string", { ...VALID, irDocuments: [{ file: "seed.ts" }] }],
    ["a flag that is not a boolean", { ...VALID, confirmProduction: "yes" }],
    ["an empty environment", { ...VALID, environment: " " }],
    ["too many files", { ...VALID, irDocuments: Array.from({ length: REMOTE_SEED_MAX_FILES + 1 }, () => "{}") }],
  ])("refuses %s", (_label, body) => {
    expect(parseRemoteSeedRequest(body)).toHaveProperty("invalid")
  })

  it("names the capability feature both control planes list", () => {
    expect(REMOTE_SEED_FEATURE).toBe("seed")
  })
})

describe("the remote seed message table", () => {
  it("has one message for every refusal code", () => {
    for (const code of REMOTE_SEED_REFUSALS) {
      if (code === "validation_error") continue
      expect(REMOTE_SEED_MESSAGES).toHaveProperty(code)
    }
  })

  it("names the environment and the count in the schema_not_pushed message", () => {
    const said = REMOTE_SEED_MESSAGES.schema_not_pushed({ environment: "staging", changes: 3 })
    expect(said).toContain("staging")
    expect(said).toContain("3 change(s)")
    expect(said).toContain("supatype push --env staging")
  })

  it("names both environments in the environment_mismatch message", () => {
    const said = REMOTE_SEED_MESSAGES.environment_mismatch({ requested: "staging", target: "production" })
    expect(said).toContain('"staging"')
    expect(said).toContain('"production"')
  })

  it("prints a refusal as [code] message", () => {
    expect(formatRemoteSeedRefusal("seed_busy", "Another seed is running.")).toBe("[seed_busy] Another seed is running.")
  })

  it("tells a refusal code from any other text", () => {
    expect(isRemoteSeedRefusal("seed_busy")).toBe(true)
    expect(isRemoteSeedRefusal("forbidden")).toBe(false)
    expect(isRemoteSeedRefusal(undefined)).toBe(false)
  })
})
