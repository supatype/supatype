import { describe, expect, it } from "vitest"
import { adoptedCount, adoptionLines, targetAdoptionSteps, type AdoptOutcome } from "../src/adopt-walkthrough.js"
import { previewLines } from "../src/commands/adopt.js"
import { endpointToArgs } from "../src/engine-client.js"

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
})

describe("endpointToArgs() for /doctor", () => {
  const body = { ast: {}, database_url: "postgres://x", schema: "public" }

  it("passes --rebaseline only when asked", () => {
    expect(endpointToArgs("/doctor", body, "req.json")).not.toContain("--rebaseline")
    expect(endpointToArgs("/doctor", { ...body, rebaseline: true }, "req.json")).toContain("--rebaseline")
  })
})

describe("endpointToArgs() for /doctor --overwrite-drift", () => {
  const body = { ast: {}, database_url: "postgres://x", schema: "public" }

  it("passes --overwrite-drift only alongside --rebaseline", () => {
    expect(endpointToArgs("/doctor", { ...body, overwrite_drift: true }, "req.json")).not.toContain(
      "--overwrite-drift",
    )
    expect(
      endpointToArgs("/doctor", { ...body, rebaseline: true, overwrite_drift: true }, "req.json").slice(-2),
    ).toEqual(["--rebaseline", "--overwrite-drift"])
  })
})
