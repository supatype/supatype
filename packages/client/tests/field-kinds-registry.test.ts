/**
 * How the client learns which columns a JSON parser would destroy.
 *
 * The generated `supatype/client.ts` calls `registerFieldKinds` when it is imported, and an app
 * imports `createClient` from there rather than from this package. So the kinds arrive by the same
 * import that brings the client, compiled into the same bundle, with nothing fetched and nothing
 * read from disk.
 *
 * This replaces reading `field-kinds.json` off the filesystem and falling back to PostgREST's
 * OpenAPI document. The fallback always succeeded, which meant a project that had never generated
 * looked identical to one that had, and the gap it papered over could never be reported.
 */
import { describe, expect, it, beforeEach } from "vitest"
import {
  registerFieldKinds,
  registeredFieldsFor,
  fieldKindsAreRegistered,
  forgetRegisteredFieldKinds,
} from "../src/field-kinds-registry.js"

const document = {
  version: 1 as const,
  tables: {
    job_post: { views: "bigint" as const, equityPct: "numeric" as const },
    landing_page: { price: "numeric" as const },
  },
}

beforeEach(() => {
  forgetRegisteredFieldKinds()
})

describe("registerFieldKinds", () => {
  it("makes a table's exact columns available", () => {
    registerFieldKinds(document)
    expect(registeredFieldsFor("job_post")).toEqual({ views: "bigint", equityPct: "numeric" })
  })

  it("reports nothing for a table the schema does not describe", () => {
    registerFieldKinds(document)
    expect(registeredFieldsFor("unknown_table")).toEqual({})
  })

  it("knows whether anything registered at all", () => {
    // The distinction the OpenAPI fallback could never draw: a project that never generated is
    // not the same as a project whose tables happen to have no exact columns.
    expect(fieldKindsAreRegistered()).toBe(false)
    registerFieldKinds(document)
    expect(fieldKindsAreRegistered()).toBe(true)
  })

  it("counts an empty schema as registered", () => {
    // A project with no bigInt, decimal or money column still generated. Treating it as absent
    // would make the safety net shout at a project that has nothing to protect.
    registerFieldKinds({ version: 1, tables: {} })
    expect(fieldKindsAreRegistered()).toBe(true)
    expect(registeredFieldsFor("anything")).toEqual({})
  })

  it("lets a later registration replace an earlier one", () => {
    // Two clients against two projects in one process, which is ordinary in a monorepo.
    registerFieldKinds(document)
    registerFieldKinds({ version: 1, tables: { other: { total: "numeric" } } })
    expect(registeredFieldsFor("other")).toEqual({ total: "numeric" })
    expect(registeredFieldsFor("job_post")).toEqual({})
  })

  it("ignores a version it does not understand rather than guessing", () => {
    registerFieldKinds({ version: 99, tables: { job_post: { views: "bigint" } } } as never)
    expect(fieldKindsAreRegistered()).toBe(false)
  })

  it("drops kinds it does not recognise", () => {
    registerFieldKinds({
      version: 1,
      tables: { job_post: { views: "bigint", weird: "quantum" } },
    } as never)
    expect(registeredFieldsFor("job_post")).toEqual({ views: "bigint" })
  })
})
