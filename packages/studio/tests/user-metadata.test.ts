import { describe, expect, it } from "vitest"
import { parseMetadata } from "../src/views/AuthManagement.js"

// The user form's metadata box. JSON.parse returned `any`, so whatever parsed was saved as the
// user's metadata, including values that are not an object at all.
describe("parseMetadata", () => {
  it("accepts a JSON object", () => {
    expect(parseMetadata('{"full_name":"Ada"}')).toEqual({ metadata: { full_name: "Ada" } })
  })

  it("refuses text that is not JSON", () => {
    expect(parseMetadata("{")).toEqual({ error: "Invalid JSON in metadata" })
  })

  it.each(["[]", '"x"', "null", "3"])("refuses %s, which is JSON but not an object", (json) => {
    expect(parseMetadata(json)).toEqual({ error: "Metadata must be a JSON object" })
  })
})
