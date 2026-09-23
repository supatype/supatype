import { describe, expect, it, vi, beforeEach } from "vitest"

const isInteractiveMock = vi.hoisted(() => vi.fn(() => false))

vi.mock("../src/ui/interactive.js", () => ({
  isInteractive: isInteractiveMock,
}))

import { file, info, plain, step, SUPATYPE_PREFIX } from "../src/ui/messages.js"

describe("ui messages", () => {
  beforeEach(() => {
    isInteractiveMock.mockReturnValue(false)
  })

  it("info prefixes with [supatype] when non-interactive", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    info("hello")
    expect(log.mock.calls[0]?.[0]).toBe(`${SUPATYPE_PREFIX} hello`)
    log.mockRestore()
  })

  it("info uses themed plain output in interactive mode", () => {
    isInteractiveMock.mockReturnValue(true)
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    info("hello")
    expect(String(log.mock.calls[0]?.[0])).toContain("hello")
    expect(String(log.mock.calls[0]?.[0])).toContain("ℹ")
    log.mockRestore()
  })

  it("file action uses scaffold-style columns", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    file("created", "schema/index.ts")
    expect(log.mock.calls[0]?.[0]).toBe("  created  schema/index.ts")
    log.mockRestore()
  })

  it("step prints a titled section", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    step("Schema Push")
    expect(log.mock.calls[0]?.[0]).toBe("\nSchema Push")
    log.mockRestore()
  })

  it("plain writes unprefixed lines", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    plain("no prefix")
    expect(log.mock.calls[0]?.[0]).toBe("no prefix")
    log.mockRestore()
  })
})
