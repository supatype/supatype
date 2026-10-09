import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `supatype adopt --key column:t.c` through the command, with the engine mocked: the column is
 * adopted, and then declared in the schema (asked first in a terminal, without asking under --yes).
 */
const targetSchemaAdopt = vi.hoisted(() => vi.fn())
const targetSchemaIntrospect = vi.hoisted(() => vi.fn())
const regenerateTypes = vi.hoisted(() => vi.fn(async () => ["Types written"]))
const confirmMock = vi.hoisted(() => vi.fn())
const schemaPath = vi.hoisted(() => ({ value: "" }))

vi.mock("../src/config.js", () => ({ loadConfig: () => ({ project: { name: "app" } }), loadSchemaAst: () => ({}) }))
vi.mock("../src/project-config.js", () => ({ schemaPathFromProject: () => schemaPath.value }))
vi.mock("../src/resolve-target.js", () => ({
  targetSchemaAdopt,
  targetSchemaIntrospect,
  schemaPgSchema: () => "public",
}))
vi.mock("../src/commands/doctor.js", () => ({ schemaCommandTarget: async () => ({ mode: "direct" }) }))
vi.mock("../src/commands/generate.js", () => ({ regenerateTypes }))
vi.mock("../src/ui/progress.js", () => ({ withSpinner: (_: string, run: () => unknown) => run() }))
vi.mock("../src/ui/interactive.js", () => ({ isInteractive: vi.fn(() => false) }))
vi.mock("../src/ui/clack.js", () => ({ p: { confirm: confirmMock, cancel: vi.fn() }, isCancel: () => false, CLACK_CANCEL: Symbol() }))
vi.mock("../src/engine-ownership-gate.js", () => ({ requireEngineForOwnershipFlag: vi.fn(async () => undefined) }))

import { registerAdopt } from "../src/commands/adopt.js"
import { isInteractive } from "../src/ui/interactive.js"

const SCHEMA = `import type { Model, Public } from "@supatype/types"

export type Widget = Model<{
  name: string
}, { access: { read: Public } }>
`

const COLUMN = { kind: "column", table: "widget", name: "colour", message: "Column widget.colour will be Supatype's" }

async function adopt(...args: string[]): Promise<void> {
  const program = new Command().exitOverride()
  registerAdopt(program)
  await program.parseAsync(["node", "supatype", "adopt", ...args])
}

let dir: string
let output: () => string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "adopt-command-columns-"))
  schemaPath.value = join(dir, "index.ts")
  writeFileSync(schemaPath.value, SCHEMA)
  targetSchemaAdopt.mockReset()
  targetSchemaAdopt.mockImplementation(async (_t, _a, opts: { yes: boolean }) =>
    opts.yes ? { status: "adopted", adopt: [COLUMN] } : { status: "preview", adopt: [] },
  )
  targetSchemaIntrospect.mockReset()
  targetSchemaIntrospect.mockResolvedValue({
    tables: [{ name: "widget", columns: [{ name: "colour", dataType: "text", udtName: "text", nullable: true }] }],
  })
  regenerateTypes.mockClear()
  confirmMock.mockReset()
  vi.mocked(isInteractive).mockReturnValue(false)
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined)
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  output = () => [...log.mock.calls, ...err.mock.calls, ...warn.mock.calls].flat().join("\n")
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
  process.exitCode = undefined
})

describe("supatype adopt column:<table>.<name>", () => {
  it("adopts, then declares the field in the model and regenerates types under --yes", async () => {
    await adopt("--yes", "--key", "column:widget.colour")
    expect(targetSchemaAdopt.mock.calls.at(-1)?.[2]).toMatchObject({ yes: true, keys: ["column:widget.colour"] })
    expect(readFileSync(schemaPath.value, "utf8")).toContain("  name: string\n  colour: Optional<string>\n}")
    expect(regenerateTypes).toHaveBeenCalledTimes(1)
    expect(confirmMock).not.toHaveBeenCalled()
    expect(output()).toContain("Added `colour: Optional<string>` to model Widget")
    expect(process.exitCode).toBeUndefined()
  })

  it("asks in a terminal, and edits once a person agrees", async () => {
    vi.mocked(isInteractive).mockReturnValue(true)
    confirmMock.mockResolvedValue(true)
    await adopt("--key", "column:widget.colour")
    // The preview names the column and the field before anything is asked.
    expect(output()).toContain(
      `column widget.colour: record as managed by Supatype, and add \`colour: Optional<string>\` to ${schemaPath.value} (Widget)`,
    )
    expect(output().indexOf("Adopt will:")).toBeLessThan(output().indexOf("column widget.colour: record"))
    expect(confirmMock.mock.calls[0]?.[0]).toMatchObject({ message: expect.stringContaining("Go ahead?") })
    // Once for the adopt, once for the edit.
    expect(confirmMock).toHaveBeenCalledTimes(2)
    expect(readFileSync(schemaPath.value, "utf8")).toContain("colour: Optional<string>")
    expect(regenerateTypes).toHaveBeenCalledTimes(1)
  })

  it("leaves the schema alone and prints the field to add when a person declines the edit", async () => {
    vi.mocked(isInteractive).mockReturnValue(true)
    confirmMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await adopt("--key", "column:widget.colour")
    expect(readFileSync(schemaPath.value, "utf8")).toBe(SCHEMA)
    expect(regenerateTypes).not.toHaveBeenCalled()
    expect(output()).toContain("Add this field to model Widget")
    expect(output()).toContain("colour: Optional<string>")
    expect(process.exitCode).toBeUndefined()
  })

  it("still succeeds, printing the field to add, when the type cannot be declared exactly", async () => {
    targetSchemaIntrospect.mockResolvedValue({
      tables: [{ name: "widget", columns: [{ name: "colour", dataType: "character varying", udtName: "varchar", nullable: true }] }],
    })
    await adopt("--yes", "--key", "column:widget.colour")
    expect(readFileSync(schemaPath.value, "utf8")).toBe(SCHEMA)
    expect(output()).toContain("was adopted, but the schema was not edited")
    expect(process.exitCode).toBeUndefined()
  })

  it("exits 1 having adopted nothing, and edited nothing, when it cannot ask and was not given --yes", async () => {
    await adopt("--key", "column:widget.colour")
    expect(process.exitCode).toBe(1)
    expect(readFileSync(schemaPath.value, "utf8")).toBe(SCHEMA)
    expect(targetSchemaAdopt.mock.calls.every((call) => call[2].yes === false)).toBe(true)
    expect(regenerateTypes).not.toHaveBeenCalled()
  })

  it("previews a column it cannot declare exactly as one to add by hand", async () => {
    targetSchemaIntrospect.mockResolvedValue({
      tables: [{ name: "widget", columns: [{ name: "colour", dataType: "character varying", udtName: "varchar", nullable: true }] }],
    })
    vi.mocked(isInteractive).mockReturnValue(true)
    confirmMock.mockResolvedValue(false)
    await adopt("--key", "column:widget.colour")
    expect(output()).toContain("column widget.colour: record as managed by Supatype; declare it in your schema by hand (")
    expect(output()).toContain("Adoption cancelled.")
    expect(readFileSync(schemaPath.value, "utf8")).toBe(SCHEMA)
  })

  it("does not read the database for adopted objects that are not columns", async () => {
    targetSchemaAdopt.mockImplementation(async () => ({
      status: "adopted",
      adopt: [{ kind: "table", table: "w", name: "w", message: "m" }],
    }))
    await adopt("--yes")
    expect(targetSchemaIntrospect).not.toHaveBeenCalled()
  })
})
