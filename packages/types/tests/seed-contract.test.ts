import { describe, expect, it } from "vitest"
import { REMOTE_SEED_FEATURE, REMOTE_SEED_MAX_FILES, parseRemoteSeedRequest } from "../src/index.js"

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
