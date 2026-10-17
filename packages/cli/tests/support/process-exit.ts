import { vi, type Mock, type MockInstance } from "vitest"

/**
 * `process.exit` made to throw `exit <code>`, so the code under test stops where it would have
 * exited and the test can assert the code. Restored by `vi.restoreAllMocks()`.
 */
export function exitThrows(): MockInstance<typeof process.exit> {
  return vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`)
  })
}

/** A `process.exit` stand-in that records its code and returns. */
export type ExitRecorder = Mock<(code?: string | number | null) => void>

/**
 * `process.exit` replaced by a recorder that returns, for code that exits from async work: a throw
 * there would surface only as an unhandled rejection, failing the run rather than the test.
 *
 * `process.exit` returns `never`, which nothing but a throw implements, so `mockImplementation`
 * cannot take a recorder. It is installed as the property's value instead; this is the one place a
 * test lets a returning function stand where `never` is declared. Call `restore` when done.
 */
export function recordExit(): { exit: ExitRecorder; restore: () => void } {
  const original = Object.getOwnPropertyDescriptor(process, "exit")
  const exit: ExitRecorder = vi.fn()
  Object.defineProperty(process, "exit", { value: exit, configurable: true, writable: true })
  const restore = (): void => {
    if (original !== undefined) Object.defineProperty(process, "exit", original)
  }
  return { exit, restore }
}
