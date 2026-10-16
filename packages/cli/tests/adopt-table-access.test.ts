import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AdoptCallOptions, TargetCall } from "./support/engine-mocks.js"

/**
 * DR2: since the engine treats a table's grants and policies as objects of their own (ENG-DRIFT),
 * adopting only the table (`adopt --key table:item`) on a database with default privileges left
 * its grants as conflicts, and the next push refused them. The adopt walkthrough now offers the
 * table's access objects with it, as one group, and says what is left when they are not taken.
 */

const targetSchemaAdopt = vi.hoisted(() => vi.fn<TargetCall<AdoptCallOptions>>())
const confirmMock = vi.hoisted(() => vi.fn())

vi.mock("../src/config.js", () => ({ loadConfig: () => ({ project: { name: "app" } }), loadSchemaAst: () => ({}) }))
vi.mock("../src/project-config.js", () => ({ schemaPathFromProject: () => "schema", pgSchema: () => "public" }))
vi.mock("../src/resolve-target.js", () => ({
  targetSchemaAdopt,
  requireTargetFeatures: vi.fn(async () => undefined),
  schemaCommandTarget: async () => ({ mode: "direct" }),
  targetCapabilities: async () => ({ features: new Set(["identity_columns"]), source: "engine" }),
  targetSchemaIntrospect: vi.fn(async () => ({})),
}))
vi.mock("../src/ui/progress.js", () => ({ withSpinner: (_: string, run: () => unknown) => run() }))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: vi.fn(() => false) }))
vi.mock("../src/ui/clack.js", () => ({ p: { confirm: confirmMock, cancel: vi.fn() }, isCancel: () => false, CLACK_CANCEL: Symbol() }))

const { registerAdopt } = await import("../src/commands/adopt.js")
const { isInteractive } = await import("../src/ui/interactive.js")

const item = (kind: string, table: string, name: string) => ({ kind, table, name, fields: [], message: `${kind} ${table}.${name} will be Supatype's` })

/** What the engine previews for a hand-made `item` under default privileges, beside another table. */
const PREVIEW = {
  status: "preview",
  adopt: [
    item("table", "item", "item"),
    item("table_grant", "item", "anon"),
    item("table_grant", "item", "authenticated"),
    item("policy", "item", "item_read"),
    item("table", "gadget", "gadget"),
    item("table_grant", "gadget", "anon"),
  ],
}

const ACCESS = ["table_grant:item.anon", "table_grant:item.authenticated", "policy:item.item_read"]

function output(): () => string {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined)
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  return () => [...log.mock.calls, ...err.mock.calls, ...warn.mock.calls].flat().join("\n")
}

/** The keys each apply (yes) call sent. */
const applied = (): unknown[] => targetSchemaAdopt.mock.calls.filter((call) => call[2].yes).map((call) => call[2].keys)

async function adopt(...args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  registerAdopt(program)
  await program.parseAsync(["node", "supatype", "adopt", ...args])
}

beforeEach(() => {
  targetSchemaAdopt.mockReset()
  targetSchemaAdopt.mockImplementation(async (_t, _a, opts) =>
    opts.yes ? { status: "adopted", adopt: PREVIEW.adopt.filter((i) => opts.keys?.includes(`${i.kind}:${i.kind === "table" ? i.name : `${i.table}.${i.name}`}`)) } : PREVIEW,
  )
  confirmMock.mockReset()
  vi.mocked(isInteractive).mockReturnValue(true)
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe("adopt --key table:item", () => {
  it("offers the table's grants and policies with it, and adopts them together on yes", async () => {
    const printed = output()
    confirmMock.mockResolvedValue(true)
    await adopt("--key", "table:item")
    expect(applied()).toEqual([["table:item", ...ACCESS]])
    const questions = confirmMock.mock.calls.map((call) => (call[0] as { message: string }).message)
    expect(questions.some((q) => /grants and policies/.test(q))).toBe(true)
    for (const key of ACCESS) expect(printed()).toContain(key)
    // Another table's conflicts are not offered: only what belongs to the table named.
    expect(printed()).not.toContain("table_grant:gadget.anon")
  })

  it("adopts only the table when the group is declined, and says the next push refuses the rest", async () => {
    const printed = output()
    confirmMock.mockResolvedValueOnce(false).mockResolvedValue(true)
    await adopt("--key", "table:item")
    expect(applied()).toEqual([["table:item"]])
    expect(printed()).toContain("the next push refuses")
    expect(printed()).toContain("--key table_grant:item.anon")
  })

  it("asks nothing more when --key already names the table's access objects", async () => {
    output()
    confirmMock.mockResolvedValue(true)
    await adopt("--key", "table:item", ...ACCESS.flatMap((key) => ["--key", key]))
    expect(applied()).toEqual([["table:item", ...ACCESS]])
    expect(confirmMock).toHaveBeenCalledOnce()
  })

  it("with --yes adopts exactly what --key names, and says what the next push will refuse", async () => {
    vi.mocked(isInteractive).mockReturnValue(false)
    const printed = output()
    await adopt("--yes", "--key", "table:item")
    expect(applied()).toEqual([["table:item"]])
    expect(printed()).toContain("the next push refuses")
    for (const key of ACCESS) expect(printed()).toContain(key)
  })
})

describe("adopting on a push's refusal (#91)", () => {
  it("takes the refused table's grants with it: the preview's keys are what is applied", async () => {
    const { targetAdoptionSteps } = await import("../src/adopt-walkthrough.js")
    const run = vi.fn(async (yes: boolean, keys?: string[]) =>
      yes ? { status: "adopted", adopt: PREVIEW.adopt.slice(0, 4) } : { ...PREVIEW, adopt: PREVIEW.adopt.slice(0, 4) },
    )
    const steps = targetAdoptionSteps(run)
    const lines = await steps.preview()
    expect(lines).toHaveLength(4)
    await steps.apply()
    expect(run.mock.calls.at(-1)).toEqual([true, ["table:item", ...ACCESS]])
  })
})
