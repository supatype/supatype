import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AuthSection, exampleRestUrl } from "../src/views/ApiDocs.js"
import { testModel } from "./support.js"

/**
 * C27 (fresh-test): the REST docs page's curl examples called
 * https://your-project.supatype.dev/rest/v1/posts, a host no local project answers on and a table
 * the project did not have. They now use the project's gateway and one of its own tables.
 */

const POST = testModel({ name: "Post", tableName: "post" })

describe("the REST docs examples", () => {
  it("call the project's own gateway and table", () => {
    const url = exampleRestUrl("http://localhost:18700/studio/proxy", [POST])
    expect(url).toBe("http://localhost:18700/rest/v1/post")
    const html = renderToStaticMarkup(<AuthSection url={url} />)
    expect(html).toContain("http://localhost:18700/rest/v1/post")
    expect(html).not.toContain("your-project.supatype.dev")
  })

  it("name the URL to replace where Studio cannot know it", () => {
    expect(exampleRestUrl("https://cloud.example.com/v1/projects/abc/proxy", [])).toBe("YOUR_PROJECT_URL/rest/v1/your_table")
  })
})
