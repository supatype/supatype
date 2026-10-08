/**
 * Which objects Studio badges as Supatype's: what the ledger records (Phase 6: nothing is stamped
 * any more), and what an older engine stamped before there was a ledger.
 */

import { describe, expect, it } from "vitest"
import {
  CONSTRAINT_KINDS,
  INDEX_KINDS,
  isMissingLedger,
  isOwned,
  ownedKey,
  ownedObjectsQuery,
} from "../src/lib/owned-objects.js"

const OWNED = new Set([ownedKey("index", "posts", "posts_title_idx")])

describe("isOwned()", () => {
  it("is what the ledger records, with no comment at all", () => {
    expect(isOwned(OWNED, INDEX_KINDS, "posts", "posts_title_idx", null)).toBe(true)
  })

  it("is what an older engine stamped, before the ledger knew it", () => {
    expect(isOwned(new Set(), ["unique"], "posts", "posts_slug_key", "supatype:managed;kind=unique_constraint")).toBe(true)
  })

  it("is not someone else's object, whatever its comment says", () => {
    expect(isOwned(OWNED, INDEX_KINDS, "posts", "theirs_idx", "Indexed for the report.")).toBe(false)
  })

  it("is not an object that only shares its name with a different kind of owned row", () => {
    // A column, trigger or grant called `posts_title_idx` on posts is not the index of that name.
    const owned = new Set([
      ownedKey("column", "posts", "posts_slug_key"),
      ownedKey("trigger", "posts", "posts_slug_key"),
      ownedKey("table_grant", "posts", "posts_slug_key"),
    ])
    expect(isOwned(owned, INDEX_KINDS, "posts", "posts_slug_key", null)).toBe(false)
    expect(isOwned(owned, CONSTRAINT_KINDS["UNIQUE"]!, "posts", "posts_slug_key", null)).toBe(false)
  })

  it("badges the index Postgres builds for an owned unique constraint or primary key", () => {
    const owned = new Set([ownedKey("unique", "posts", "posts_slug_key"), ownedKey("primary_key", "posts", "posts_pkey")])
    expect(isOwned(owned, INDEX_KINDS, "posts", "posts_slug_key", null)).toBe(true)
    expect(isOwned(owned, INDEX_KINDS, "posts", "posts_pkey", null)).toBe(true)
    expect(isOwned(owned, CONSTRAINT_KINDS["FOREIGN KEY"]!, "posts", "posts_pkey", null)).toBe(false)
  })
})

describe("ownedObjectsQuery()", () => {
  it("reads each unreleased row's kind, with the schema quoted", () => {
    const sql = ownedObjectsQuery("o'brien")
    expect(sql).toContain("SELECT kind, parent, name")
    expect(sql).toContain("schema_name = 'o''brien'")
    expect(sql).toContain("status <> 'released'")
  })
})

describe("isMissingLedger()", () => {
  it("is a database with no ledger yet", () => {
    expect(isMissingLedger('relation "_supatype.managed_objects" does not exist')).toBe(true)
    expect(isMissingLedger('schema "_supatype" does not exist')).toBe(true)
  })

  it("is not any other failure", () => {
    expect(isMissingLedger("permission denied for table managed_objects")).toBe(false)
    expect(isMissingLedger('column "kind" does not exist')).toBe(false)
  })
})
