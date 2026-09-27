/**
 * What happens when the client is asked to read a value it was never told about.
 *
 * The kinds arrive from generated code, compiled into the same bundle as the app. So there are
 * exactly two states worth distinguishing, and the design turns on telling them apart:
 *
 *   nothing registered   the project never generated, or the app imported `createClient` from the
 *                        package instead of from `supatype/client`
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
    expect(out.ok && (out.value as [{ views: bigint }])[0].views).toBe(9007199254740993n)
  })

  it("returns a numeric column as an exact string", () => {
    registerFieldKinds({ version: 1, tables: { job_post: { equityPct: "numeric" } } })
    const out = parseRowsExactly('[{"equityPct":0.20}]', "job_post")

    expect(out.ok).toBe(true)
    expect(out.ok && (out.value as [{ equityPct: string }])[0].equityPct).toBe("0.20")
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
    expect(!out.ok && out.message).toContain('import { createClient } from "./supatype/client"')
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
