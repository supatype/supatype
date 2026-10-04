/**
 * The Schema objects screen: every object Supatype owns, from `_supatype.managed_objects`, in each
 * state the screen can be in, and the filters an operator narrows it with (managed-object
 * ownership plan, section 8).
 */

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import {
  filterObjects,
  mapObjectRow,
  migrationLink,
  NO_FILTERS,
  objectLabel,
  SchemaObjectsView,
  type ManagedObject,
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

const OBJECTS: ManagedObject[] = [
  object({ kind: "table", name: "posts" }),
  object({ kind: "index", parent: "posts", name: "posts_title_idx", status: "adopted", migration_id: null }),
  object({ kind: "security_label", parent: "posts.email", name: "supatype", status: "released" }),
  object({ kind: "table", name: "comments" }),
]

function render(props: Partial<React.ComponentProps<typeof SchemaObjectsView>>): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SchemaObjectsView objects={null} loading={false} error={null} onRefresh={() => {}} {...props} />
    </MemoryRouter>,
  )
}

describe("before any push has recorded anything", () => {
  it("says so, and says what to do about it", () => {
    const html = render({ objects: [] })
    expect(html).toContain("No schema objects recorded yet")
    expect(html).toContain("supatype push")
  })

  it("treats a missing ledger as empty, not as an error", () => {
    const html = render({ error: 'relation "_supatype.managed_objects" does not exist' })
    expect(html).toContain("No schema objects recorded yet")
  })

  it("shows any other failure as one", () => {
    expect(render({ error: "permission denied" })).toContain("permission denied")
  })
})

describe("the recorded objects", () => {
  it("lists each with its status and the migration that last changed it", () => {
    const html = render({ objects: OBJECTS })
    expect(html).toContain("posts.posts_title_idx")
    expect(html).toContain("released")
    expect(html).toContain(`href="${migrationLink(12)}"`)
    expect(html).toContain("4 of 4 objects shown")
  })

  it("says an adopted object has no migration yet, rather than leaving the cell blank", () => {
    expect(render({ objects: OBJECTS })).toContain("not yet pushed")
  })
})

describe("filterObjects()", () => {
  it("narrows by kind and by status", () => {
    expect(filterObjects(OBJECTS, { ...NO_FILTERS, kind: "table" }).map(objectLabel)).toEqual(["posts", "comments"])
    expect(filterObjects(OBJECTS, { ...NO_FILTERS, status: "released" }).map(objectLabel)).toEqual([
      "posts.email.supatype",
    ])
  })

  it("narrows by table, counting a column's objects as their table's", () => {
    expect(filterObjects(OBJECTS, { ...NO_FILTERS, table: "POSTS" }).map(objectLabel)).toEqual([
      "posts",
      "posts.posts_title_idx",
      "posts.email.supatype",
    ])
    // `email` is a column of posts, not a table, so nothing is on a table of that name.
    expect(filterObjects(OBJECTS, { ...NO_FILTERS, table: "email" })).toEqual([])
  })
})

describe("mapObjectRow()", () => {
  it("reads a ledger row, keeping a missing migration as none", () => {
    const mapped = mapObjectRow({
      kind: "policy",
      schema_name: "public",
      parent: "posts",
      name: "posts_select",
      status: "adopted",
      migration_id: null,
      updated_at: "2026-10-04",
    })
    expect(mapped).toEqual(
      object({ kind: "policy", parent: "posts", name: "posts_select", status: "adopted", migration_id: null, updated_at: "2026-10-04" }),
    )
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
