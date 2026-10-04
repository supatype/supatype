/**
 * The Schema objects screen: every object Supatype owns, from `_supatype.managed_objects`, read a
 * page at a time and filtered in the query (managed-object ownership plan, section 8).
 */

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import {
  mapObjectRow,
  migrationLink,
  NO_FILTERS,
  objectsQuery,
  PAGE_SIZE,
  SchemaObjectsView,
  toPage,
  type ManagedObject,
  type ObjectPage,
} from "../src/views/SchemaObjects.js"
import { linkedMigrationId } from "../src/views/MigrationHistory.js"

function object(overrides: Partial<ManagedObject> & { kind: string; name: string }): ManagedObject {
  return {
    schema: "public",
    parent: "",
    status: "managed",
    migration_id: 12,
    updated_at: "2026-10-04 11:00:00+00",
    ...overrides,
  }
}

const PAGE: ObjectPage = {
  objects: [
    object({ kind: "table", name: "posts" }),
    object({ kind: "index", parent: "posts", name: "posts_title_idx", status: "adopted", migration_id: null }),
    object({ kind: "security_label", parent: "posts.email", name: "supatype", status: "released" }),
  ],
  total: 163,
  kinds: ["index", "security_label", "table"],
}

function render(props: Partial<React.ComponentProps<typeof SchemaObjectsView>>): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SchemaObjectsView
        result={null}
        query={{ filters: NO_FILTERS, page: 0 }}
        onQuery={() => {}}
        load={{ error: null, onRefresh: () => {} }}
        {...props}
      />
    </MemoryRouter>,
  )
}

describe("before any push has recorded anything", () => {
  it("says so, and says what to do about it", () => {
    const html = render({ result: { objects: [], total: 0, kinds: [] } })
    expect(html).toContain("No schema objects recorded yet")
    expect(html).toContain("supatype push")
  })

  it("treats a missing ledger as empty, not as an error", () => {
    const html = render({ load: { error: 'relation "_supatype.managed_objects" does not exist', onRefresh: () => {} } })
    expect(html).toContain("No schema objects recorded yet")
  })

  it("shows any other failure as one", () => {
    expect(render({ load: { error: "permission denied", onRefresh: () => {} } })).toContain("permission denied")
  })
})

describe("a page of the recorded objects", () => {
  it("lists each with its status and the migration that last changed it", () => {
    const html = render({ result: PAGE })
    expect(html).toContain("posts.posts_title_idx")
    expect(html).toContain("released")
    expect(html).toContain(`href="${migrationLink(12)}"`)
  })

  it("says an adopted object has no migration yet, rather than leaving the cell blank", () => {
    expect(render({ result: PAGE })).toContain("not yet pushed")
  })

  it("says where in the whole list the page is", () => {
    expect(render({ result: PAGE, query: { filters: NO_FILTERS, page: 1 } })).toContain("Page 2 of 4 (163)")
  })
})

describe("objectsQuery()", () => {
  it("asks for one page, with the count of every match", () => {
    const sql = objectsQuery({ filters: NO_FILTERS, page: 2 })
    expect(sql).toContain(`LIMIT ${PAGE_SIZE} OFFSET ${2 * PAGE_SIZE}`)
    expect(sql).toContain("count(*) OVER ()")
    expect(sql).not.toContain("WHERE")
  })

  it("filters by kind and status in the query", () => {
    const sql = objectsQuery({ filters: { kind: "index", table: "", status: "released" }, page: 0 })
    expect(sql).toContain("kind = 'index'")
    expect(sql).toContain("status = 'released'")
  })

  it("matches a table by its own row or as the first part of a column's parent", () => {
    const sql = objectsQuery({ filters: { ...NO_FILTERS, table: "posts" }, page: 0 })
    expect(sql).toContain("split_part(parent, '.', 1)")
    expect(sql).toContain("ILIKE '%posts%'")
  })

  it("quotes what was typed, and takes LIKE's wildcards literally", () => {
    const sql = objectsQuery({ filters: { ...NO_FILTERS, table: "o'brien_%" }, page: 0 })
    expect(sql).toContain("'%o''brien\\_\\%%'")
  })
})

describe("toPage() and mapObjectRow()", () => {
  it("reads the count from the rows and keeps a missing migration as none", () => {
    const page = toPage(
      [{ kind: "policy", schema_name: "public", parent: "posts", name: "p", status: "adopted", migration_id: null, total: "7" }],
      ["policy"],
    )
    expect(page.total).toBe(7)
    expect(page.objects[0]!.migration_id).toBeNull()
  })

  it("reads an unknown status as managed rather than inventing one", () => {
    expect(mapObjectRow({ kind: "table", name: "t", status: "weird" }).status).toBe("managed")
  })
})

describe("linkedMigrationId()", () => {
  it("is the id a link names, and nothing for anything else", () => {
    expect(linkedMigrationId("12")).toBe(12)
    expect(linkedMigrationId(null)).toBeNull()
    expect(linkedMigrationId("12abc")).toBeNull()
    expect(linkedMigrationId("")).toBeNull()
  })
})
