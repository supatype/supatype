/**
 * Which objects Studio badges as Supatype's: what the ledger records (Phase 6: nothing is stamped
 * any more), and what an older engine stamped before there was a ledger.
 */

import { describe, expect, it } from "vitest"
import { isOwned, ownedKey, ownedObjectsQuery } from "../src/lib/owned-objects.js"

const OWNED = new Set([ownedKey("posts", "posts_title_idx")])

describe("isOwned()", () => {
  it("is what the ledger records, with no comment at all", () => {
    expect(isOwned(OWNED, "posts", "posts_title_idx", null)).toBe(true)
  })

  it("is what an older engine stamped, before the ledger knew it", () => {
    expect(isOwned(new Set(), "posts", "posts_slug_key", "supatype:managed;kind=unique_constraint")).toBe(true)
  })

  it("is not someone else's object, whatever its comment says", () => {
    expect(isOwned(OWNED, "posts", "theirs_idx", "Indexed for the report.")).toBe(false)
  })
})

describe("ownedObjectsQuery()", () => {
  it("reads the schema's unreleased rows, with the schema quoted", () => {
    const sql = ownedObjectsQuery("o'brien")
    expect(sql).toContain("schema_name = 'o''brien'")
    expect(sql).toContain("status <> 'released'")
  })
})
