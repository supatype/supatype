import { vi } from "vitest"

/** Every console method a line could go out on, so "silent" means silent on all of them. */
const METHODS = ["log", "info", "debug", "warn", "error"] as const

export interface ConsoleCall {
  method: (typeof METHODS)[number]
  args: unknown[]
}

/** Capture everything written to the console until `restore` is called. */
export function captureConsole(): { calls: ConsoleCall[]; restore: () => void } {
  const calls: ConsoleCall[] = []
  const spies = METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      calls.push({ method, args })
    }),
  )
  return { calls, restore: () => spies.forEach((spy) => spy.mockRestore()) }
}
