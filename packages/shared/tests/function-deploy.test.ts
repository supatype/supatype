import { describe, expect, it } from "vitest"
import { isFunctionDeployBody, type FunctionDeployBody } from "../src/index.js"

/**
 * The CLI writes the functions deploy body and the self-host control plane reads it; each had its
 * own idea of its shape until both drew it from here.
 */
describe("isFunctionDeployBody", () => {
  it("takes what the CLI sends: entries with or without files, and a service-role list", () => {
    const body: FunctionDeployBody = {
      functions: [
        { name: "single", source: "export default 1", entrypoint: "single/index.ts" },
        { name: "multi", source: "x", files: { "index.ts": "x", "lib/a.ts": "y" } },
      ],
      serviceRole: ["single"],
    }
    expect(isFunctionDeployBody(body)).toBe(true)
    expect(isFunctionDeployBody({ functions: [] })).toBe(true)
  })

  it("refuses a body the reader could not use", () => {
    for (const body of [
      {},
      { functions: "x" },
      { functions: [{ name: "a" }] },
      { functions: [{ name: 1, source: "x" }] },
      { functions: [{ name: "a", source: "x", files: { "a.ts": 1 } }] },
      { functions: [], serviceRole: "a" },
    ]) {
      expect(isFunctionDeployBody(body), JSON.stringify(body)).toBe(false)
    }
  })
})
