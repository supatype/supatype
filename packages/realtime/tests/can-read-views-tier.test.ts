import { afterEach, describe, expect, it } from "vitest"
import { RlsFilter } from "../src/rls.js"

/**
 * 0.9.2 release test round 2 (R2-S8 review): a row join is refused when the subscriber's role
 * cannot read the table. Tier 2 masking gives the API roles nothing on the model tables: they read
 * the api views, and a change reaches them through the engine's can_read_<table>, which delivery
 * runs as them. Asking for SELECT on the table there refused every row join on such a project.
 */

const filters: RlsFilter[] = []
afterEach(async () => {
  for (const filter of filters.splice(0)) await filter.shutdown()
})

/** A filter whose catalog says the masking tier is `tier` and the table has a read predicate or not. */
function filterOn(tier: "views" | "extension", predicate: boolean): RlsFilter {
  const filter = new RlsFilter("postgresql://nobody:nothing@127.0.0.1:1/none")
  filters.push(filter)
  Object.assign(filter, {
    fieldMasks: { tier: async () => tier, invalidate: () => undefined },
    tables: { shape: async () => ({ columns: [], primaryKey: [], readPredicate: predicate ? { schema: "public", name: "can_read_note" } : null }) },
  })
  return filter
}

describe("whether a role can read a table, under tier 2 views", () => {
  it("is yes for a model table the engine gave a read predicate, without asking for SELECT on it", async () => {
    expect(await filterOn("views", true).canRead("authenticated", "public", "note")).toBe(true)
  })

  it("still asks the database for a table with no read predicate", async () => {
    await expect(filterOn("views", false).canRead("authenticated", "auth", "users")).rejects.toThrow()
  })
})
