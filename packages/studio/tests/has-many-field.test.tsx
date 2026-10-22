// @vitest-environment jsdom
import React from "react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { FieldWidget } from "../src/widgets/FieldWidget.js"
import { isolateEachTest, mount, settle, testClient, testConfig, testField, testModel } from "./support.js"

/**
 * C25 (fresh-test): a has-many field on the edit form (an author's Posts) said "None selected"
 * while the author had posts. The record holds no column for the relation, so the widget had
 * nothing to show. It now reads the related rows through the other side's foreign key.
 */

isolateEachTest()

const POSTS_FIELD = testField({
  name: "posts",
  label: "Posts",
  widget: "multirelation",
  options: { target: "post", cardinality: "hasMany" },
})
const AUTHOR = testModel({ name: "Author", tableName: "author", fields: [testField({ name: "name" }), POSTS_FIELD] })
const POST = testModel({
  name: "Post",
  tableName: "post",
  fields: [
    testField({ name: "title" }),
    testField({ name: "author_id", widget: "relation", options: { target: "author", cardinality: "belongsTo", foreignKey: "author_id" } }),
  ],
})

let related: URL[] = []

function serve(): void {
  related = []
  vi.stubGlobal("fetch", async (raw: string) => {
    const url = new URL(raw)
    if (!url.pathname.endsWith("/rest/v1/post")) return Response.json([])
    if (url.searchParams.get("author_id") === "eq.a1") {
      related.push(url)
      return Response.json([{ id: "p1" }, { id: "p2" }])
    }
    return Response.json([{ id: "p1", title: "Welcome" }, { id: "p2", title: "Second post" }])
  })
}

async function renderPosts(): Promise<HTMLElement> {
  serve()
  const { container } = await mount(
    <MemoryRouter>
      <AdminConfigContext.Provider value={testConfig({ models: [AUTHOR, POST] })}>
        <AdminClientContext.Provider value={testClient({ url: "http://localhost:8000/studio/proxy", token: "t" })}>
          <FieldWidget config={POSTS_FIELD} value={undefined} onChange={() => undefined} readOnly={false} record={{ id: "a1", name: "Ada" }} />
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>
    </MemoryRouter>,
  )
  await settle()
  return container
}

describe("a has-many field on the edit form", () => {
  it("shows the rows that point at the record", async () => {
    const container = await renderPosts()
    expect(related).toHaveLength(1)
    expect(container.textContent).toContain("Welcome")
    expect(container.textContent).toContain("Second post")
    expect(container.textContent).not.toContain("None selected")
  })

  it("offers no picker, since the rows belong to the other side", async () => {
    const container = await renderPosts()
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Add…")).toBe(false)
  })
})
