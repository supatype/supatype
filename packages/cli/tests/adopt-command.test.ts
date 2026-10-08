import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const targetSchemaAdopt = vi.hoisted(() => vi.fn())
const requireEngine = vi.hoisted(() => vi.fn(async () => undefined))
const confirmMock = vi.hoisted(() => vi.fn())

vi.mock("../src/config.js", () => ({ loadConfig: () => ({ project: { name: "app" } }), loadSchemaAst: () => ({}) }))
vi.mock("../src/project-config.js", () => ({ schemaPathFromProject: () => "schema", pgSchema: () => "public" }))
vi.mock("../src/resolve-target.js", () => ({ targetSchemaAdopt, schemaCommandTarget: async () => ({ mode: "direct" }) }))
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

const TWO_CONFLICTS = {
  status: "preview",
  adopt: [
    ...PREVIEW.adopt,
    { kind: "table", table: "gadget", name: "gadget", message: "Table gadget will be Supatype's" },
  ],
}

const STALE =
  "Engine /adopt failed (exit 1): Error: table:widget was to be adopted but is not a conflict now: " +
  "the database changed since the preview. Nothing was written"
const STALE_MESSAGE = "The database changed since the preview; run `supatype adopt` again."

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
    const stdout = vi.mocked(console.log)
    await adopt()
    expect(process.exitCode).toBe(1)
    // In a terminal an error is printed with the rest of the flow, on stdout.
    expect([...stdout.mock.calls, ...stderr.mock.calls].flat().join(" ")).toContain("adopt needs --yes when not interactive")
    expect(targetSchemaAdopt.mock.calls.map((call) => call[2].yes)).toEqual([false])
  })

  it("adopts with --yes when it cannot ask", async () => {
    await adopt("--yes")
    expect(process.exitCode).toBeUndefined()
    // --yes has already agreed, so one engine call adopts.
    expect(targetSchemaAdopt.mock.calls.map((call) => call[2].yes)).toEqual([true])
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
    expect(requireEngine).not.toHaveBeenCalledWith("--release", expect.anything())
    await adopt("--yes", "--release", "table:widget")
    expect(requireEngine).toHaveBeenCalledWith("--release", expect.anything())
  })
  it("checks the engine version before sending --reclaim", async () => {
    await adopt("--yes", "--reclaim", "table:widget")
    expect(requireEngine).toHaveBeenCalledWith("--reclaim", expect.anything())
    expect(requireEngine).not.toHaveBeenCalledWith("--release", expect.anything())
  })

  it("names no keys on --yes alone: it adopts every conflict there is, and says what it took", async () => {
    const stdout = vi.mocked(console.log)
    await adopt("--yes")
    expect(targetSchemaAdopt.mock.calls.every((call) => call[2].keys === undefined)).toBe(true)
    expect(targetSchemaAdopt.mock.calls.at(-1)?.[2].yes).toBe(true)
    expect(requireEngine).not.toHaveBeenCalledWith("adopt", expect.anything())
    expect(stdout.mock.calls.flat().join("\n")).toContain("Table widget will be Supatype's")
  })

  it("adopts only the conflicts the preview showed after a person agrees, checking the engine first", async () => {
    vi.mocked(isInteractive).mockReturnValue(true)
    confirmMock.mockResolvedValue(true)
    await adopt()
    expect(targetSchemaAdopt.mock.calls.map((call) => [call[2].yes, call[2].keys])).toEqual([
      [false, undefined],
      [true, ["table:widget"]],
    ])
    expect(requireEngine).toHaveBeenCalledWith("adopt", expect.anything())
  })

  it("sends no keys to an engine from before the ledger, and does not gate it", async () => {
    vi.mocked(isInteractive).mockReturnValue(true)
    confirmMock.mockResolvedValue(true)
    targetSchemaAdopt.mockImplementation(async (_t, _a, opts: { yes: boolean }) =>
      opts.yes ? { status: "adopted", stamped: 1 } : { status: "preview", stampStatements: ["COMMENT ON ..."] },
    )
    await adopt()
    expect(targetSchemaAdopt.mock.calls.map((call) => call[2].keys)).toEqual([undefined, undefined])
    expect(requireEngine).not.toHaveBeenCalled()
  })

  it("exits 1 and says to run it again when the database changed since the preview", async () => {
    vi.mocked(isInteractive).mockReturnValue(true)
    confirmMock.mockResolvedValue(true)
    targetSchemaAdopt.mockImplementation(async (_t, _a, opts: { yes: boolean }) => {
      if (!opts.yes) return PREVIEW
      throw new Error(STALE)
    })
    const stdout = vi.mocked(console.log)
    await adopt()
    expect(process.exitCode).toBe(1)
    // In a terminal an error is printed with the rest of the flow, on stdout.
    expect([...stdout.mock.calls, ...stderr.mock.calls].flat().join(" ")).toContain(STALE_MESSAGE)
  })

  it("lets any other failure to apply through", async () => {
    vi.mocked(isInteractive).mockReturnValue(true)
    confirmMock.mockResolvedValue(true)
    targetSchemaAdopt.mockImplementation(async (_t, _a, opts: { yes: boolean }) => {
      if (!opts.yes) return PREVIEW
      throw new Error("connection refused")
    })
    await expect(adopt()).rejects.toThrow("connection refused")
  })

  it("adopts only what --key names, after the engine version gate", async () => {
    await adopt("--yes", "--key", "table:widget", "--key", "index:posts.posts_title_idx")
    expect(requireEngine).toHaveBeenCalledWith("--key", expect.anything())
    const applied = targetSchemaAdopt.mock.calls.at(-1)?.[2]
    expect(applied?.yes).toBe(true)
    expect(applied?.keys).toEqual(["table:widget", "index:posts.posts_title_idx"])
  })

  it("exits 1 with --key when one is no longer a conflict", async () => {
    targetSchemaAdopt.mockImplementation(async (_t, _a, opts: { yes: boolean }) => {
      if (!opts.yes) return PREVIEW
      throw new Error(STALE)
    })
    await adopt("--yes", "--key", "table:widget")
    expect(process.exitCode).toBe(1)
    expect(stderr.mock.calls.flat().join(" ")).toContain(STALE_MESSAGE)
  })

  it("shows only the conflicts --key names before asking", async () => {
    vi.mocked(isInteractive).mockReturnValue(true)
    confirmMock.mockResolvedValue(true)
    targetSchemaAdopt.mockImplementation(async (_t, _a, opts: { yes: boolean }) =>
      opts.yes ? { status: "adopted", adopt: [PREVIEW.adopt[0]] } : TWO_CONFLICTS,
    )
    const stdout = vi.mocked(console.log)
    await adopt("--key", "table:widget")
    const printed = stdout.mock.calls.flat().join("\n")
    expect(printed).toContain("Table widget will be Supatype's")
    expect(printed).not.toContain("Table gadget")
    expect(targetSchemaAdopt.mock.calls.at(-1)?.[2].keys).toEqual(["table:widget"])
  })

  it("agrees to adopt nothing when the preview listed only what to release", async () => {
    vi.mocked(isInteractive).mockReturnValue(true)
    confirmMock.mockResolvedValue(true)
    targetSchemaAdopt.mockImplementation(async (_t, _a, opts: { yes: boolean }) => ({
      status: opts.yes ? "adopted" : "preview",
      adopt: [],
      release: [{ kind: "table", table: "widget", name: "widget", message: "Table widget will be left alone" }],
    }))
    await adopt("--release", "table:widget")
    expect(targetSchemaAdopt.mock.calls.map((call) => [call[2].yes, call[2].keys])).toEqual([
      [false, undefined],
      [true, []],
    ])
  })
})
