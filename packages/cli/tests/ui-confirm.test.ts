import { describe, expect, it, vi, beforeEach } from "vitest"

vi.mock("@clack/prompts", () => ({
  confirm: vi.fn(),
  isCancel: vi.fn((v: unknown) => v === Symbol.for("cancel")),
  cancel: vi.fn(),
}))

vi.mock("../src/ui/interactive.js", () => ({
  isInteractive: vi.fn(() => true),
}))

import * as clack from "@clack/prompts"
import { confirm, logSkippedConfirm } from "../src/ui/confirm.js"
import { isInteractive } from "../src/ui/interactive.js"

describe("ui confirm", () => {
  beforeEach(() => {
    vi.mocked(clack.confirm).mockReset()
    vi.mocked(isInteractive).mockReturnValue(true)
  })

  it("returns clack confirm result in TTY mode", async () => {
    vi.mocked(clack.confirm).mockResolvedValue(true)
    await expect(confirm("Proceed?")).resolves.toBe(true)
    expect(clack.confirm).toHaveBeenCalledWith({ message: "Proceed?", initialValue: false })
  })

  it("uses nonInteractive fallback when not a TTY", async () => {
    vi.mocked(isInteractive).mockReturnValue(false)
    await expect(confirm("Proceed?", { nonInteractive: false })).resolves.toBe(false)
    expect(clack.confirm).not.toHaveBeenCalled()
  })

  it("logSkippedConfirm mentions --yes", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    logSkippedConfirm("3 risky operations")
    expect(log.mock.calls[0]?.[0]).toContain("--yes")
    log.mockRestore()
  })
})
