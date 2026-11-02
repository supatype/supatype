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

/**
 * Local test round 6: an `n` typed into "Create an admin user now?", the second flow of a first
 * dev, was lost. The read restarted with raw mode off, so on Windows it began as a line-mode console
 * read, and Ink turning raw mode on then cancelled that read with the key in it.
 */
describe("stdin restarted for the next flow", () => {
  it("is in raw mode before its read starts", () => {
    const { stdin, handle } = ttyStdin()
    const order: string[] = []
    stdin.setRawMode = (mode: boolean) => void order.push(`raw ${String(mode)}`)
    handle.readStart = () => {
      order.push("read")
      return 0
    }
    handle.reading = false
    prepareStdinForInk(stdin)
    expect(order).toEqual(["raw true", "read"])
  })
})
