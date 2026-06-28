import { describe, expect, it, vi, beforeEach } from "vitest"

const confirmMock = vi.hoisted(() => vi.fn())

vi.mock("../src/ui/clack.js", () => ({
  p: {
    confirm: confirmMock,
    cancel: vi.fn(() => process.exit(0)),
  },
  isCancel: vi.fn((v: unknown) => v === Symbol.for("cancel")),
  CLACK_CANCEL: Symbol.for("cancel"),
}))

vi.mock("../src/ui/interactive.js", () => ({
  isInteractive: vi.fn(() => true),
}))

import { confirm, logSkippedConfirm } from "../src/ui/confirm.js"
import { isInteractive } from "../src/ui/interactive.js"

describe("ui confirm", () => {
  beforeEach(() => {
    confirmMock.mockReset()
    vi.mocked(isInteractive).mockReturnValue(true)
  })

  it("returns ink confirm result in TTY mode", async () => {
    confirmMock.mockResolvedValue(true)
    await expect(confirm("Proceed?")).resolves.toBe(true)
    expect(confirmMock).toHaveBeenCalledWith({ message: "Proceed?", initialValue: false })
  })

  it("uses nonInteractive fallback when not a TTY", async () => {
    vi.mocked(isInteractive).mockReturnValue(false)
    await expect(confirm("Proceed?", { nonInteractive: false })).resolves.toBe(false)
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it("logSkippedConfirm mentions --yes", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    logSkippedConfirm("3 risky operations")
    expect(log.mock.calls[0]?.[0]).toContain("--yes")
    log.mockRestore()
  })
})
