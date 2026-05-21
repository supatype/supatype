import { describe, expect, it } from "vitest"
import { postgresArchiveTag } from "../src/binary-cache.js"

describe("postgresArchiveTag", () => {
  it("uses PG major only for CDN archive basenames", () => {
    expect(postgresArchiveTag("17.2")).toBe("17")
    expect(postgresArchiveTag("17")).toBe("17")
  })
})
