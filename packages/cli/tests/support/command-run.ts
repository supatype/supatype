import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Command } from "commander"
import { vi } from "vitest"

/** Everything a command printed, and the code it exited with, if it did. */
export interface CommandRun {
  output: string
  exitCode: number | undefined
}

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

/**
 * Run one CLI command the way `supatype` would, in `cwd`, capturing what it prints.
 *
 * `process.exit` is turned into a thrown error so a refusal ends the command without ending the
 * test run, and its code is reported back.
 */
export async function runCommand(
  register: (program: Command) => void,
  argv: readonly string[],
  cwd: string,
): Promise<CommandRun> {
  const lines: string[] = []
  const capture = (...args: unknown[]): void => void lines.push(args.map(String).join(" "))
  const spies = [
    vi.spyOn(console, "log").mockImplementation(capture),
    vi.spyOn(console, "error").mockImplementation(capture),
    vi.spyOn(console, "warn").mockImplementation(capture),
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(code === undefined || code === null ? undefined : Number(code))
    }),
  ]
  const previous = process.cwd()
  process.chdir(cwd)
  let exitCode: number | undefined
  try {
    const program = new Command().name("supatype").exitOverride()
    register(program)
    await program.parseAsync(["node", "supatype", ...argv])
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err
    exitCode = err.code
  } finally {
    process.chdir(previous)
    for (const spy of spies) spy.mockRestore()
  }
  return { output: lines.join("\n"), exitCode }
}

/** A fresh, empty project directory; remove it with the returned function. */
export function tempProject(label: string): { dir: string; remove: () => void } {
  const dir = join(tmpdir(), `supatype-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) }
}
