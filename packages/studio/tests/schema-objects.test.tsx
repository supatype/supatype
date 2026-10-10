/**
 * The Schema objects screen: every object Supatype owns, from `_supatype.managed_objects`, read a
 * page at a time and filtered in the query (managed-object ownership plan, section 8).
 */

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import {
  fetchObjectPage,
  KINDS_SQL,
  lastPage,
  mapObjectRow,
  objectsCountQuery,
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
  page: 0,
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

  it("shows any other \"does not exist\" as the failure it is, not as an empty ledger", () => {
    for (const error of [
      'column "migration_id" does not exist',
      'relation "public.posts" does not exist',
      'role "anon" does not exist',
    ]) {
      const html = render({ load: { error, onRefresh: () => {} } })
      expect(html).not.toContain("No schema objects recorded yet")
      expect(html).toContain("does not exist")
    }
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
    const html = render({ result: { ...PAGE, page: 1 }, query: { filters: NO_FILTERS, page: 1 } })
    expect(html).toContain("Page 2 of 4 (163)")
  })

  it("names the page on screen while the next one loads, and waits for it before paging again", () => {
    const html = render({
      result: PAGE,
      query: { filters: NO_FILTERS, page: 1 },
      load: { error: null, onRefresh: () => {}, loading: true },
    })
    expect(html).toContain("Page 1 of 4 (163)")
    expect(html).not.toContain("Page 2 of 4")
    expect(html).toContain("Loading…")
    expect(html.match(/<button[^>]*disabled/g)?.length).toBe(2)
  })
})

describe("fetchObjectPage()", () => {
  const row = (name: string, total: number) => ({ kind: "table", schema_name: "public", parent: "", name, status: "managed", total })

  /** A ledger of `total` objects, answering each page with what is on it. */
  function ledger(total: number) {
    const asked: string[] = []
    return {
      asked,
      sql: async (query: string) => {
        asked.push(query)
        if (query === KINDS_SQL) return { rows: [{ kind: "table" }] }
        if (query.startsWith("SELECT count(*) AS total")) return { rows: [{ total: String(total) }] }
        const offset = Number(/OFFSET (\d+)/.exec(query)?.[1] ?? 0)
        const names = Array.from({ length: Math.max(0, Math.min(PAGE_SIZE, total - offset)) }, (_, i) => `t${offset + i}`)
        return { rows: names.map((n) => row(n, total)) }
      },
    }
  }

  it("returns the page asked for when it has rows", async () => {
    const page = await fetchObjectPage(ledger(120), { filters: NO_FILTERS, page: 1 })
    expect(page.page).toBe(1)
    expect(page.total).toBe(120)
    expect(page.objects[0]!.name).toBe(`t${PAGE_SIZE}`)
  })

  it("brings a page past the end back to the last page there is", async () => {
    const page = await fetchObjectPage(ledger(30), { filters: NO_FILTERS, page: 2 })
    expect(page.page).toBe(0)
    expect(page.total).toBe(30)
    expect(page.objects).toHaveLength(30)
  })

  it("is page 0 of nothing when every object has gone", async () => {
    const page = await fetchObjectPage(ledger(0), { filters: NO_FILTERS, page: 2 })
    expect(page).toMatchObject({ page: 0, total: 0, objects: [] })
  })

  it("counts with the same filters it pages with", () => {
    expect(objectsCountQuery({ kind: "index", table: "", status: "all" })).toContain("WHERE kind = 'index'")
    expect(lastPage(0)).toBe(0)
    expect(lastPage(PAGE_SIZE)).toBe(0)
    expect(lastPage(PAGE_SIZE + 1)).toBe(1)
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
