/**
 * What happens when the client is asked to read a value it was never told about.
 *
 * The kinds arrive from generated code, compiled into the same bundle as the app. So there are
 * exactly two states worth distinguishing, and the design turns on telling them apart:
 *
 *   nothing registered   the project never generated, or the app imported `createClient` from the
 *                        package instead of from `supatype/generated/client`
 *   registered, unknown  the column is new since the last push, or reached through an embed
 *
 * Neither is papered over. The previous design fell back to fetching PostgREST's OpenAPI document,
 * which reconstructs the answer from the live database and therefore always succeeds, so the first
 * state was indistinguishable from the second and could never be reported.
 */
import { describe, expect, it, beforeEach } from "vitest"
import { parseRowsExactly, tableFromPath } from "../src/exact-response.js"
import {
  registerFieldKinds,
  forgetRegisteredFieldKinds,
} from "../src/field-kinds-registry.js"

beforeEach(() => {
  forgetRegisteredFieldKinds()
})

describe("tableFromPath", () => {
  it("reads the table out of a PostgREST path", () => {
    expect(tableFromPath("/rest/v1/job_post")).toBe("job_post")
    expect(tableFromPath("/rest/v1/job_post?select=slug")).toBe("job_post")
  })
})

describe("parseRowsExactly", () => {
  it("returns a bigint column as a native bigint", () => {
    registerFieldKinds({ version: 1, tables: { job_post: { views: "bigint" } } })
    const out = parseRowsExactly('[{"slug":"a","views":9007199254740993}]', "job_post")

    expect(out.ok).toBe(true)
    expect(out.ok && out.value).toEqual([{ slug: "a", views: 9007199254740993n }])
  })

  it("returns a numeric column as an exact string", () => {
    registerFieldKinds({ version: 1, tables: { job_post: { equityPct: "numeric" } } })
    const out = parseRowsExactly('[{"equityPct":0.20}]', "job_post")

    expect(out.ok).toBe(true)
    expect(out.ok && out.value).toEqual([{ equityPct: "0.20" }])
  })

  it("leaves ordinary columns alone", () => {
    registerFieldKinds({ version: 1, tables: { job_post: { views: "bigint" } } })
    const out = parseRowsExactly('[{"hits":42,"rate":1.5,"title":"x"}]', "job_post")

    expect(out.ok).toBe(true)
    expect(out.ok && out.value).toEqual([{ hits: 42, rate: 1.5, title: "x" }])
  })

  it("says the project has not generated when nothing is registered", () => {
    const out = parseRowsExactly('[{"views":9007199254740993}]', "job_post")

    expect(out.ok).toBe(false)
    expect(!out.ok && out.columns).toEqual(["views"])
    expect(!out.ok && out.message).toContain("supatype push")
    expect(!out.ok && out.message).toContain('import { createClient } from "./supatype/generated/client"')
  })

  it("says something different when the kinds are registered but the column is not", () => {
    // Registered and unknown is a new column or an embed, not a missing setup step, and telling
    // someone to run `push` when they already have would send them the wrong way.
    registerFieldKinds({ version: 1, tables: { job_post: { views: "bigint" } } })
    const out = parseRowsExactly('[{"author":{"views":9007199254740993}}]', "job_post")

    expect(out.ok).toBe(false)
    expect(!out.ok && out.message).toContain("embed")
    expect(!out.ok && out.message).not.toContain('import { createClient }')
  })

  it("never returns a wrong number in place of an error", () => {
    // The property that matters, in both states: a caller does not silently receive
    // 9007199254740992 where the database holds 9007199254740993.
    const unregistered = parseRowsExactly('[{"views":9007199254740993}]', "job_post")
    expect(unregistered.ok).toBe(false)

    registerFieldKinds({ version: 1, tables: { other: { x: "bigint" } } })
    const wrongTable = parseRowsExactly('[{"views":9007199254740993}]', "job_post")
    expect(wrongTable.ok).toBe(false)
  })

  it("does not complain about a project with nothing exact to protect", () => {
    // Registered but empty: the schema simply has no bigInt, decimal or money column.
    registerFieldKinds({ version: 1, tables: {} })
    const out = parseRowsExactly('[{"hits":42}]', "job_post")
    expect(out.ok).toBe(true)
  })
})

describe("parseRowsExactly with array columns", () => {
  const arrays = {
    version: 1 as const,
    tables: { ledger: { ids: "bigint[]" as const, rates: "numeric[]" as const, grid: "bigint[]" as const } },
  }

  it("keeps a bigint[] past 2^53 in a list response", () => {
    registerFieldKinds(arrays)
    const out = parseRowsExactly('[{"ids":[9007199254740993,1,-9007199254740995]}]', "ledger")

    expect(out.ok).toBe(true)
    expect(out.ok && out.value).toEqual([{ ids: [9007199254740993n, 1n, -9007199254740995n] }])
  })

  it("keeps a bigint[] past 2^53 in a single-object response", () => {
    registerFieldKinds(arrays)
    const out = parseRowsExactly('{"ids":[9007199254740993]}', "ledger")

    expect(out.ok).toBe(true)
    expect(out.ok && out.value).toEqual({ ids: [9007199254740993n] })
  })

  it("keeps trailing zeros in a numeric[] as exact strings", () => {
    registerFieldKinds(arrays)
    const out = parseRowsExactly('[{"rates":[1.10,2.500,12345678901234567890.1234]}]', "ledger")

    expect(out.ok).toBe(true)
    expect(out.ok && out.value).toEqual([{ rates: ["1.10", "2.500", "12345678901234567890.1234"] }])
  })

  it("keeps a numeric[] in a single-object response", () => {
    registerFieldKinds(arrays)
    const out = parseRowsExactly('{"rates":[1.10]}', "ledger")

    expect(out.ok && out.value).toEqual({ rates: ["1.10"] })
  })

  it("leaves nulls inside and around the array as null", () => {
    registerFieldKinds(arrays)
    const out = parseRowsExactly('[{"ids":[9007199254740993,null]},{"ids":null},{"ids":[]}]', "ledger")

    expect(out.ok && out.value).toEqual([{ ids: [9007199254740993n, null] }, { ids: null }, { ids: [] }])
  })

  it("keeps a multi-dimensional bigint[]", () => {
    registerFieldKinds(arrays)
    const out = parseRowsExactly('[{"grid":[[9007199254740993,2],[3,null]]}]', "ledger")

    expect(out.ok && out.value).toEqual([{ grid: [[9007199254740993n, 2n], [3n, null]] }])
  })

  it("leaves arrays in columns that are not registered exact kinds alone", () => {
    registerFieldKinds(arrays)
    const out = parseRowsExactly('[{"tags":[1,2],"ids":[1]}]', "ledger")

    expect(out.ok && out.value).toEqual([{ tags: [1, 2], ids: [1n] }])
  })

  it("still reads a document with only the single kinds", () => {
    registerFieldKinds({ version: 1, tables: { ledger: { views: "bigint" } } })
    const out = parseRowsExactly('[{"views":9007199254740993,"ids":[1,2]}]', "ledger")

    expect(out.ok && out.value).toEqual([{ views: 9007199254740993n, ids: [1, 2] }])
  })
})
