import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const targetSchemaAdopt = vi.hoisted(() => vi.fn())
const requireEngine = vi.hoisted(() => vi.fn(async () => undefined))
const confirmMock = vi.hoisted(() => vi.fn())

vi.mock("../src/config.js", () => ({ loadConfig: () => ({ project: { name: "app" } }), loadSchemaAst: () => ({}) }))
vi.mock("../src/project-config.js", () => ({ schemaPathFromProject: () => "schema" }))
vi.mock("../src/resolve-target.js", () => ({ targetSchemaAdopt, schemaPgSchema: () => "public" }))
vi.mock("../src/commands/doctor.js", () => ({ schemaCommandTarget: async () => ({ mode: "direct" }) }))
vi.mock("../src/ui/progress.js", () => ({ withSpinner: (_: string, run: () => unknown) => run() }))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: vi.fn(() => false) }))
vi.mock("../src/ui/clack.js", () => ({ p: { confirm: confirmMock, cancel: vi.fn() }, isCancel: () => false, CLACK_CANCEL: Symbol() }))
vi.mock("../src/engine-ownership-gate.js", () => ({ requireEngineForOwnershipFlag: requireEngine }))

import { registerAdopt } from "../src/commands/adopt.js"
import { isInteractive } from "../src/ui/interactive.js"

const PREVIEW = {
  status: "preview",
  adopt: [{ kind: "table", table: "widget", name: "widget", message: "Table widget will be Supatype's" }],
}

async function adopt(...args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  registerAdopt(program)
  await program.parseAsync(["node", "supatype", "adopt", ...args])
}

describe("supatype adopt", () => {
  let stderr: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    targetSchemaAdopt.mockReset()
    targetSchemaAdopt.mockImplementation(async (_t, _a, opts: { yes: boolean }) =>
      opts.yes ? { status: "adopted", adopt: PREVIEW.adopt } : PREVIEW,
    )
    requireEngine.mockClear()
    confirmMock.mockReset()
    vi.mocked(isInteractive).mockReturnValue(false)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it("exits 1 without adopting when it cannot ask and was not given --yes", async () => {
    await adopt()
    expect(process.exitCode).toBe(1)
    expect(stderr.mock.calls.flat().join(" ")).toContain("adopt needs --yes when not interactive")
    expect(targetSchemaAdopt.mock.calls.map((call) => call[2].yes)).toEqual([false])
  })

  it("adopts with --yes when it cannot ask", async () => {
    await adopt("--yes")
    expect(process.exitCode).toBeUndefined()
    expect(targetSchemaAdopt.mock.calls.map((call) => call[2].yes)).toEqual([false, true])
  })

  it("exits 0 when a person declines at the prompt", async () => {
    vi.mocked(isInteractive).mockReturnValue(true)
    confirmMock.mockResolvedValue(false)
    await adopt()
    expect(process.exitCode).toBeUndefined()
    expect(targetSchemaAdopt.mock.calls.map((call) => call[2].yes)).toEqual([false])
  })

  it("checks the engine version before sending --release, and only then", async () => {
    await adopt("--yes")
    expect(requireEngine).not.toHaveBeenCalled()
    await adopt("--yes", "--release", "table:widget")
    expect(requireEngine).toHaveBeenCalledWith("--release", expect.anything())
  })
})
