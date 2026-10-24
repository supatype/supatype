// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import React from "react"
import { ModelGraphQLDocs } from "../src/views/ModelGraphQLDocs.js"
import { AdminClientContext } from "../src/hooks/useAdminClient.js"
import { AdminConfigContext } from "../src/hooks/useAdminConfig.js"
import { act, button, isolateEachTest, mount, settle, testClient, testConfig, testField, testModel } from "./support.js"

/**
 * A model's GraphQL tab shows a rich text field as the object it holds, pretty-printed, rather than
 * the JSON-encoded string pg_graphql sends for its `JSON` scalar.
 */

const MODEL = testModel({ name: "talk", label: "Talk", labelPlural: "Talks", tableName: "talk", fields: [testField({ name: "abstract" })] })
const CONFIG = testConfig({ models: [MODEL] })
const CLIENT = testClient({ url: "http://localhost:8000/studio/proxy", token: "studio-user-jwt" })

const ABSTRACT = { root: { type: "root", children: [] } }

const ref = (kind: string, name: string | null, ofType: unknown = null) => ({ kind, name, ofType })
const field = (name: string, type: unknown) => ({ name, type })

const SCHEMA = {
  __schema: {
    queryType: { name: "Query" },
    mutationType: null,
    subscriptionType: null,
    types: [
      { name: "Query", kind: "OBJECT", fields: [field("talkCollection", ref("OBJECT", "talkConnection"))] },
      { name: "talkConnection", kind: "OBJECT", fields: [field("edges", ref("NON_NULL", null, ref("LIST", null, ref("OBJECT", "talkEdge"))))] },
      { name: "talkEdge", kind: "OBJECT", fields: [field("node", ref("NON_NULL", null, ref("OBJECT", "talk")))] },
      { name: "talk", kind: "OBJECT", fields: [field("id", ref("SCALAR", "UUID")), field("abstract", ref("SCALAR", "JSON"))] },
      { name: "JSON", kind: "SCALAR", fields: null },
    ],
  },
}

function serve(): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname.endsWith("/studio/auth/verify")) return Response.json({ role: "admin", mode: "elevated", canElevate: true, permissions: {} })
    if (!url.pathname.endsWith("/graphql/v1")) return Response.json([])
    const body = typeof init?.body === "string" ? init.body : ""
    if (body.includes("__schema")) return Response.json({ data: SCHEMA })
    return Response.json({ data: { talkCollection: { edges: [{ node: { id: "t1", abstract: JSON.stringify(ABSTRACT) } }] } } })
  })
}

isolateEachTest()

describe("a model's GraphQL tab", () => {
  it("shows a rich text field as its object, pretty-printed", async () => {
    serve()
    const { container } = await mount(
      <AdminConfigContext.Provider value={CONFIG}>
        <AdminClientContext.Provider value={CLIENT}>
          <ModelGraphQLDocs model={MODEL} />
        </AdminClientContext.Provider>
      </AdminConfigContext.Provider>,
    )
    await settle(4)
    await act(() => button(container, "Run").click())
    await settle(4)
    const shown = container.querySelector("pre")?.textContent ?? ""
    const expected = JSON.stringify({ talkCollection: { edges: [{ node: { id: "t1", abstract: ABSTRACT } }] } }, null, 2)
    expect(shown).toBe(expected)
  })
})
