import { describe, expect, it, vi, beforeEach, afterAll } from "vitest"

const isInteractiveMock = vi.hoisted(() => vi.fn(() => false))
const clackInfoMock = vi.hoisted(() => vi.fn())

vi.mock("../src/ui/interactive.js", () => ({
  isInteractive: isInteractiveMock,
}))

vi.mock("@clack/prompts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@clack/prompts")>()
  return {
    ...original,
    log: {
      ...original.log,
      info: clackInfoMock,
    },
  }
})

import { file, info, plain, step, SUPATYPE_PREFIX } from "../src/ui/messages.js"

describe("ui messages", () => {
  beforeEach(() => {
    isInteractiveMock.mockReturnValue(false)
    clackInfoMock.mockClear()
  })

  it("info prefixes with [supatype] when non-interactive", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    info("hello")
    expect(log.mock.calls[0]?.[0]).toBe(`${SUPATYPE_PREFIX} hello`)
    expect(clackInfoMock).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it("info uses Clack log in interactive mode", () => {
    isInteractiveMock.mockReturnValue(true)
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    info("hello")
    expect(clackInfoMock).toHaveBeenCalledWith("hello")
    expect(log).not.toHaveBeenCalled()
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
