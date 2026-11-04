import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { recordExit } from "./support/process-exit.js"

/**
 * Fresh-user test: an interactive `init formflow` said "Supatype project ready in formflow/." twice,
 * once as the flow's outro and again at the head of the next steps. Said once, on either path.
 */

const said = vi.hoisted(() => ({ lines: [] as string[] }))

vi.mock("../src/ui/clack.js", () => {
  const answer = (options: { message: string; initialValue?: unknown; defaultValue?: unknown }): Promise<unknown> =>
    Promise.resolve(options.message.startsWith("Create an admin user") ? false : (options.initialValue ?? options.defaultValue ?? ""))
  const say = (message: string) => void said.lines.push(message)
  const p = {
    intro: say,
    outro: say,
    note: say,
    text: answer,
    select: answer,
    confirm: answer,
    password: answer,
    log: { info: say, warn: say, error: say, success: say, message: say, step: say },
  }
  return { p, runClackFlow: (run: (api: typeof p) => Promise<unknown>) => run(p), isCancel: () => false, CLACK_CANCEL: Symbol.for("cancel") }
})
vi.mock("../src/dev-ports.js", () => ({
  promptKongPortChoice: () => Promise.resolve(18478),
  chooseInitKongPort: () => Promise.resolve(18478),
}))
vi.mock("../src/docker-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/docker-runtime.js")>()),
  probeDockerDaemonAsync: () => Promise.resolve({ ok: true }),
}))
vi.mock("../src/ui/progress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ui/progress.js")>()),
  withProgressView: <T,>(task: (spinner: undefined) => Promise<T>) => task(undefined),
}))

const { registerInit } = await import("../src/commands/init.js")

let root = ""
let exitStub: ReturnType<typeof recordExit>
const tty = process.stdin.isTTY

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "supatype-init-ready-"))
  said.lines.length = 0
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })))
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => void said.lines.push(parts.map(String).join(" ")))
  // Interactive init exits 0 once it is done; the test carries on to count what it said.
  exitStub = recordExit()
})

afterEach(() => {
  exitStub.restore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true })
  rmSync(root, { recursive: true, force: true })
})

/** Everything init said, run with `--no-install --no-keys` and `flags`. */
async function init(interactive: boolean, ...flags: string[]): Promise<string[]> {
  Object.defineProperty(process.stdin, "isTTY", { value: interactive, configurable: true })
  const program = new Command().exitOverride()
  registerInit(program)
  await program.parseAsync(["node", "supatype", "init", join(root, "formflow"), "--no-install", "--no-keys", ...flags])
  return said.lines
}

const readyLines = (lines: string[]) => lines.filter((line) => line.includes("Supatype project ready")).length

describe("init's ready line", () => {
  it("is said once by an interactive init", async () => {
    expect(readyLines(await init(true))).toBe(1)
  })

  it("is said once by init --defaults", async () => {
    expect(readyLines(await init(false, "--defaults"))).toBe(1)
  })
})

/**
 * The interactive init and `init -y` disagreed about keys: with `--no-keys`, `-y` listed
 * `supatype keys` as a step left to do and the interactive one did not. Both list it whenever the
 * keys were not generated, since the project needs them before it can run.
 */
describe("init's next steps about keys", () => {
  const listsKeys = (lines: string[]) => lines.some((line) => line.trim() === "supatype keys")

  it.each([
    ["an interactive init", true, []],
    ["init --defaults", false, ["--defaults"]],
  ])("%s lists supatype keys when it generated none", async (_label, interactive, flags) => {
    expect(listsKeys(await init(interactive, ...flags))).toBe(true)
  })
})
