import { afterEach, describe, it, expect, vi } from "vitest"
import { prepareStdinForInk, restoreStdinAfterInk, type InkStdin } from "../src/ui/runtime/stdin-after-ink.js"

/** A TTY stdin whose native handle is reading, as Ink leaves it once it has turned raw mode off. */
function ttyStdin(): { stdin: InkStdin; handle: { reading: boolean; readStart: () => number; readStop: () => number } } {
  const handle = { reading: true, readStart: vi.fn(() => 0), readStop: vi.fn(() => 0) }
  const stdin = { isTTY: true, isRaw: false, _handle: handle, pause: vi.fn(), setRawMode: vi.fn() }
  vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  return { stdin, handle }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("restoreStdinAfterInk()", () => {
  it("does not throw when stdin is not a TTY", () => {
    expect(() => restoreStdinAfterInk()).not.toThrow()
  })
})

/**
 * Local test round 5 (N26): `supatype link` asking for the key after the target and URL questions,
 * two flows in a row, printed its result and never exited. Ink turns raw mode off while stdin still
 * reads, which on Windows leaves a line-mode console read that only Enter ends; `pause()` did not
 * stop it.
 */
describe("stdin between Ink flows", () => {
  it("stops the console read when a flow ends", () => {
    const { stdin, handle } = ttyStdin()
    restoreStdinAfterInk(stdin)
    expect(handle.readStop).toHaveBeenCalledTimes(1)
    expect(handle.reading).toBe(false)
  })

  it("starts it again for the next flow, which would otherwise get no keys", () => {
    const { stdin, handle } = ttyStdin()
    restoreStdinAfterInk(stdin)
    prepareStdinForInk(stdin)
    expect(handle.readStart).toHaveBeenCalledTimes(1)
    expect(handle.reading).toBe(true)
  })

  it("leaves a read that is running alone", () => {
    const { stdin, handle } = ttyStdin()
    prepareStdinForInk(stdin)
    expect(handle.readStart).not.toHaveBeenCalled()
  })
})
