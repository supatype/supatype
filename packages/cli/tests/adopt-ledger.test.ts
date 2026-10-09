import { describe, expect, it, vi } from "vitest"
import {
  adoptedCount,
  adoptionKey,
  adoptionLines,
  isStalePreview,
  previewedKeys,
  targetAdoptionSteps,
  type AdoptOutcome,
} from "../src/adopt-walkthrough.js"
import { previewLines } from "../src/commands/adopt.js"
import { EngineError, endpointToArgs } from "../src/engine-client.js"

/**
 * `adopt` since the managed-object ledger (supatype/schema-engine, Phase 5c): it lists the objects
 * it hands over and takes back, and writes ledger rows instead of comment stamps. A pinned engine
 * image can still be one from before, so every reader takes both shapes.
 */
const item = (kind: string, name: string, message: string) => ({ kind, table: name, name, message })

const LEDGER: AdoptOutcome = {
  status: "preview",
  adopt: [item("table", "widget", "Table widget will be Supatype's: the next push makes it match the schema")],
  release: [item("index", "posts_title_idx", "Index posts.posts_title_idx will be left alone by every push")],
}

const STAMPS: AdoptOutcome = {
  status: "preview",
  stampStatements: ['COMMENT ON TABLE "public"."widget" IS \'supatype:managed\''],
  stamped: 1,
}

describe("adoptionLines() and adoptedCount()", () => {
  it("read what a ledger engine will take", () => {
    expect(adoptionLines(LEDGER)).toEqual([LEDGER.adopt![0]!.message])
    expect(adoptedCount({ status: "adopted", adopt: LEDGER.adopt! })).toBe(1)
  })

  it("read an engine from before the ledger, which listed stamps", () => {
    expect(adoptionLines(STAMPS)).toEqual(STAMPS.stampStatements)
    expect(adoptedCount(STAMPS)).toBe(1)
  })

  it("read nothing to adopt as nothing", () => {
    expect(adoptionLines({ status: "preview", adopt: [] })).toEqual([])
    expect(adoptedCount({ status: "nothing_to_adopt", adopt: [] })).toBe(0)
  })
})

describe("targetAdoptionSteps()", () => {
  it("previews without applying and applies with yes", async () => {
    const calls: boolean[] = []
    const steps = targetAdoptionSteps(async (yes) => {
      calls.push(yes)
      return yes ? { status: "adopted", adopt: LEDGER.adopt! } : LEDGER
    })
    expect(await steps.preview()).toHaveLength(1)
    expect(await steps.apply()).toBe(1)
    expect(calls).toEqual([false, true])
  })

  it("applies only the keys the preview showed, after the version gate", async () => {
    const calls: Array<[boolean, string[] | undefined]> = []
    const gate = vi.fn(async () => undefined)
    const steps = targetAdoptionSteps(async (yes, keys) => {
      calls.push([yes, keys])
      return yes ? { status: "adopted", adopt: LEDGER.adopt! } : LEDGER
    }, gate)
    await steps.preview()
    expect(gate).toHaveBeenCalledTimes(1)
    await steps.apply()
    expect(calls).toEqual([
      [false, undefined],
      [true, ["table:widget"]],
    ])
  })

  it("sends no keys, and needs no gate, for an engine from before the ledger", async () => {
    const calls: Array<string[] | undefined> = []
    const gate = vi.fn(async () => undefined)
    const steps = targetAdoptionSteps(async (yes, keys) => {
      calls.push(keys)
      return yes ? { status: "adopted", stamped: 1 } : STAMPS
    }, gate)
    await steps.preview()
    await steps.apply()
    expect(gate).not.toHaveBeenCalled()
    expect(calls).toEqual([undefined, undefined])
  })
})

describe("previewedKeys()", () => {
  it("names a table-level object kind:name and anything else kind:table.name, as the engine parses", () => {
    expect(adoptionKey({ kind: "table", table: "widget", name: "widget" })).toBe("table:widget")
    expect(adoptionKey({ kind: "enum_type", table: "status", name: "status" })).toBe("enum_type:status")
    expect(adoptionKey({ kind: "index", table: "posts", name: "posts_title_idx" })).toBe("index:posts.posts_title_idx")
    // An object named like its table is still table-scoped.
    expect(adoptionKey({ kind: "trigger", table: "posts", name: "posts" })).toBe("trigger:posts.posts")
  })

  it("lists every conflict a ledger preview showed, and none it released", () => {
    expect(previewedKeys(LEDGER)).toEqual(["table:widget"])
    expect(previewedKeys({ status: "preview", adopt: [] })).toEqual([])
  })

  it("is undefined for an engine from before the ledger", () => {
    expect(previewedKeys(STAMPS)).toBeUndefined()
  })
})

describe("isStalePreview()", () => {
  it("recognises the engine refusing a preview the database no longer matches", () => {
    const binary = new EngineError(
      "Engine /adopt failed (exit 1): Error: table:widget was to be adopted but is not a conflict now: " +
        "the database changed since the preview. Nothing was written",
      "/adopt",
      1,
    )
    expect(isStalePreview(binary)).toBe(true)
    expect(isStalePreview(new Error("table:widget was to be adopted ... the database changed since the preview."))).toBe(true)
    expect(isStalePreview(new Error("nothing to release is named \"table:x\""))).toBe(false)
  })
})

describe("previewLines()", () => {
  it("lists what adopt hands over, then what it takes back", () => {
    expect(previewLines(LEDGER)).toEqual([LEDGER.adopt![0]!.message, LEDGER.release![0]!.message])
  })
})

describe("endpointToArgs() for /adopt", () => {
  const body = { ast: {}, database_url: "postgres://x", schema: "public" }

  it("passes each object to release as its own --release", () => {
    const args = endpointToArgs("/adopt", { ...body, release: ["table:widget", "index:posts.a"] }, "req.json")
    expect(args.slice(-4)).toEqual(["--release", "table:widget", "--release", "index:posts.a"])
  })

  it("passes no --release when nothing is released", () => {
    expect(endpointToArgs("/adopt", { ...body, yes: true }, "req.json")).not.toContain("--release")
  })

  it("passes each previewed key as its own --key", () => {
    const args = endpointToArgs("/adopt", { ...body, yes: true, keys: ["table:widget", "index:posts.a"] }, "req.json")
    expect(args.slice(-5)).toEqual(["--yes", "--key", "table:widget", "--key", "index:posts.a"])
  })

  it("passes no --key without keys", () => {
    expect(endpointToArgs("/adopt", { ...body, yes: true }, "req.json")).not.toContain("--key")
  })

  it("passes --adopt-none, and no --key, for an empty key list", () => {
    const args = endpointToArgs("/adopt", { ...body, yes: true, keys: [], release: ["table:w"] }, "req.json")
    expect(args).toContain("--adopt-none")
    expect(args).not.toContain("--key")
    expect(args.slice(-3)).toEqual(["--release", "table:w", "--adopt-none"])
  })

  it("passes no --adopt-none without keys, or with some", () => {
    expect(endpointToArgs("/adopt", { ...body, yes: true }, "req.json")).not.toContain("--adopt-none")
    expect(endpointToArgs("/adopt", { ...body, yes: true, keys: ["table:w"] }, "req.json")).not.toContain("--adopt-none")
  })
})
