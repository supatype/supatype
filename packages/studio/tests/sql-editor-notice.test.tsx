import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SqlEditorAccessNotice } from "../src/views/SqlRunner.js"

/**
 * C26 (fresh-test): the notice over the SQL editor said it "runs as the project's owning role", but
 * `select current_user` answered `supatype_sql_editor`. The editor logs in as that role, which is
 * not a superuser and holds the owning role's rights, so the notice now names it.
 */

describe("the SQL editor's access notice", () => {
  it("names the role a query runs as, which select current_user returns", () => {
    const text = renderToStaticMarkup(<SqlEditorAccessNotice />)
    expect(text).toContain("supatype_sql_editor")
    expect(text).not.toContain("runs as the project&#x27;s owning role")
    expect(text).toContain("Row Level Security does not apply")
  })
})
