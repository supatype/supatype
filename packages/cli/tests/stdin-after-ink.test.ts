import { describe, it, expect } from "vitest"
import { restoreStdinAfterInk } from "../src/ui/runtime/stdin-after-ink.js"

describe("restoreStdinAfterInk()", () => {
  it("does not throw when stdin is not a TTY", () => {
    expect(() => restoreStdinAfterInk()).not.toThrow()
  })
})
