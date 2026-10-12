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
  isUnreadableLedger,
  ownedKey,
  ownedObjectsQuery,
} from "../src/lib/owned-objects.js"
import type { DatabaseFailure } from "../src/lib/database-error.js"

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

/** A failure as a server that sends no SQLSTATE reports it: the message is all there is. */
function said(message: string): DatabaseFailure {
  return { message, code: null }
}

/** A failure with its SQLSTATE, in a message Studio cannot read (a server set to another language). */
function coded(code: string): DatabaseFailure {
  return { message: "FEHLER: eine Meldung in einer anderen Sprache", code }
}

describe("isUnreadableLedger()", () => {
  it("is a ledger this role cannot read: missing, behind a schema it may not use, or a table it may not select", () => {
    expect(isUnreadableLedger(said('relation "_supatype.managed_objects" does not exist'))).toBe(true)
    expect(isUnreadableLedger(said("ERROR: permission denied for schema _supatype"))).toBe(true)
    // USAGE on `_supatype` but no SELECT on the ledger: as good as no ledger, so no banner.
    expect(isUnreadableLedger(said("permission denied for table managed_objects"))).toBe(true)
    expect(isUnreadableLedger(said("permission denied for relation managed_objects"))).toBe(true)
  })

  it("is not a permission on anything else, nor a ledger missing a column", () => {
    expect(isUnreadableLedger(said("permission denied for schema billing"))).toBe(false)
    expect(isUnreadableLedger(said("permission denied for schema _supatype_extra"))).toBe(false)
    expect(isUnreadableLedger(said("permission denied for table managed_objects_v2"))).toBe(false)
    expect(isUnreadableLedger(said('column "kind" does not exist'))).toBe(false)
  })

  it("goes by the SQLSTATE when there is one, whatever language the message is in", () => {
    expect(isUnreadableLedger(coded("42501"))).toBe(true)
    expect(isUnreadableLedger(coded("42P01"))).toBe(true)
    expect(isUnreadableLedger(coded("3F000"))).toBe(true)
    expect(isUnreadableLedger(coded("42703"))).toBe(false)
  })

  it("trusts the SQLSTATE over a message that happens to look like a ledger error", () => {
    // A missing column whose message mentions the ledger is still a missing column.
    expect(isUnreadableLedger({ message: "permission denied for schema _supatype", code: "42703" })).toBe(false)
  })
})

describe("isMissingLedger()", () => {
  it("is a database with no ledger yet", () => {
    expect(isMissingLedger(said('relation "_supatype.managed_objects" does not exist'))).toBe(true)
    expect(isMissingLedger(said('schema "_supatype" does not exist'))).toBe(true)
    expect(isMissingLedger(coded("42P01"))).toBe(true)
    expect(isMissingLedger(coded("3F000"))).toBe(true)
  })

  it("is not any other failure", () => {
    expect(isMissingLedger(said("permission denied for table managed_objects"))).toBe(false)
    expect(isMissingLedger(said('column "kind" does not exist'))).toBe(false)
    expect(isMissingLedger(said('column "kind" of relation "_supatype.managed_objects" does not exist'))).toBe(false)
    expect(isMissingLedger(said('function _supatype.managed_objects_fp() does not exist'))).toBe(false)
    // A role that may not read the ledger is not a database without one: Schema objects says so.
    expect(isMissingLedger(coded("42501"))).toBe(false)
    expect(isMissingLedger(coded("42703"))).toBe(false)
  })
})
