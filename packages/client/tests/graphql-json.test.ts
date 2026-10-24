/**
 * pg_graphql types every json and jsonb column as its `JSON` scalar, which it serializes as a string.
 * A rich text, blocks or json field therefore arrives as `"{\"root\":...}"`, and an app would have to
 * know which fields to `JSON.parse`. The client knows instead: it reads the schema's field types once
 * and decodes exactly the response keys whose field is a `JSON` scalar, following the query through
 * aliases, fragments, nested relations and lists. A key it cannot place stays as returned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createClient, decodeGraphqlJsonFields, readGraphqlSchema } from "../src/index.js"
import { fetchCalls, jsonBody, jsonResponse, mockFetch, type FetchMock } from "./support/fetch-mock.js"

type TypeRef = { kind: string; name: string | null; ofType: TypeRef | null }

const named = (kind: string, name: string): TypeRef => ({ kind, name, ofType: null })
const nonNull = (type: TypeRef): TypeRef => ({ kind: "NON_NULL", name: null, ofType: type })
const list = (type: TypeRef): TypeRef => ({ kind: "LIST", name: null, ofType: type })
const object = (name: string): TypeRef => named("OBJECT", name)
const JSON_TYPE = named("SCALAR", "JSON")
const STRING = named("SCALAR", "String")

function objectType(name: string, fields: Record<string, TypeRef>, kind = "OBJECT"): Record<string, unknown> {
  return { name, kind, fields: Object.entries(fields).map(([field, type]) => ({ name: field, type })) }
}

/** The shape pg_graphql gives a `talk` table with a `speaker` relation, trimmed to what the tests use. */
const INTROSPECTION = {
  data: {
    __schema: {
      queryType: { name: "Query" },
      mutationType: { name: "Mutation" },
      types: [
        objectType("Query", { talkCollection: object("TalkConnection"), node: named("INTERFACE", "Node") }),
        objectType("Mutation", { insertIntoTalkCollection: object("TalkInsertResponse") }),
        objectType("TalkInsertResponse", { records: nonNull(list(nonNull(object("Talk")))) }),
        objectType("TalkConnection", { edges: nonNull(list(nonNull(object("TalkEdge")))) }),
        objectType("TalkEdge", { node: nonNull(object("Talk")) }),
        objectType("Talk", {
          nodeId: nonNull(named("SCALAR", "ID")),
          title: STRING,
          abstract: JSON_TYPE,
          body: JSON_TYPE,
          tags: list(JSON_TYPE),
          speaker: object("Speaker"),
        }),
        objectType("Speaker", { name: STRING, bio: JSON_TYPE, talkCollection: object("TalkConnection") }),
        objectType("Node", { nodeId: nonNull(named("SCALAR", "ID")) }, "INTERFACE"),
        { name: "JSON", kind: "SCALAR", fields: null },
        { name: "String", kind: "SCALAR", fields: null },
      ],
    },
  },
}

const ABSTRACT = { root: { type: "root", children: [{ type: "paragraph", children: [] }] } }
const BLOCKS = [{ type: "quote", data: { text: "Ship it" } }]
const BIO = { en: { root: { type: "root", children: [] } } }
const encoded = (value: unknown): string => JSON.stringify(value)

let introspect: () => Response
let answer: unknown

/** A GraphQL endpoint: the schema for an introspection query, `answer` for anything else. */
function serve(): FetchMock {
  const fetch = mockFetch((_input, init) => {
    const query = jsonBody(init ?? {})["query"]
    const isIntrospection = typeof query === "string" && query.includes("__schema")
    return Promise.resolve(isIntrospection ? introspect() : jsonResponse({ data: answer }))
  })
  vi.stubGlobal("fetch", fetch)
  return fetch
}

const client = () => createClient({ url: "http://api.test", anonKey: "anon", auth: { persistSession: false } })

beforeEach(() => {
  vi.restoreAllMocks()
  introspect = () => jsonResponse(INTROSPECTION)
})

describe("graphql: JSON scalar fields come back as values, not strings", () => {
  it("decodes a rich text field", async () => {
    serve()
    answer = { talkCollection: { edges: [{ node: { title: "Keynote", abstract: encoded(ABSTRACT) } }] } }
    const { data, error } = await client().graphql("{ talkCollection { edges { node { title abstract } } } }")
    expect(error).toBeNull()
    expect(data).toEqual({ talkCollection: { edges: [{ node: { title: "Keynote", abstract: ABSTRACT } }] } })
  })

  it("follows an alias to the field it names, and leaves a text field aliased to a JSON field's name alone", async () => {
    serve()
    answer = { talkCollection: { edges: [{ node: { summary: encoded(ABSTRACT), abstract: "{\"looks\":\"like json\"}" } }] } }
    const { data } = await client().graphql("{ talkCollection { edges { node { summary: abstract abstract: title } } } }")
    expect(data).toEqual({ talkCollection: { edges: [{ node: { summary: ABSTRACT, abstract: "{\"looks\":\"like json\"}" } }] } })
  })

  it("decodes fields selected through a named fragment and an inline fragment on an interface", async () => {
    serve()
    answer = { node: { nodeId: "WyJ0YWxrIl0=", abstract: encoded(ABSTRACT), body: encoded(BLOCKS) } }
    const query = `query Read($id: ID!) { node(nodeId: $id) { nodeId ...TalkBody ... on Talk { abstract } } }
      fragment TalkBody on Talk { body }`
    const { data } = await client().graphql(query, { id: "WyJ0YWxrIl0=" })
    expect(data).toEqual({ node: { nodeId: "WyJ0YWxrIl0=", abstract: ABSTRACT, body: BLOCKS } })
  })

  it("decodes inside a nested relation's list, and every item of a list of JSON", async () => {
    serve()
    const talk = { abstract: encoded(ABSTRACT), tags: [encoded({ a: 1 }), encoded("plain")] }
    answer = { talkCollection: { edges: [{ node: { speaker: { bio: encoded(BIO), talkCollection: { edges: [{ node: talk }] } } } }] } }
    const query = "{ talkCollection { edges { node { speaker { bio talkCollection { edges { node { abstract tags } } } } } } } }"
    const { data } = await client().graphql(query)
    const inner = { edges: [{ node: { abstract: ABSTRACT, tags: [{ a: 1 }, "plain"] } }] }
    expect(data).toEqual({ talkCollection: { edges: [{ node: { speaker: { bio: BIO, talkCollection: inner } } }] } })
  })

  it("decodes the records a mutation returns", async () => {
    serve()
    answer = { insertIntoTalkCollection: { records: [{ abstract: encoded(ABSTRACT) }] } }
    const { data } = await client().graphql("mutation { insertIntoTalkCollection(objects: [{title: \"a } b\"}]) { records { abstract } } }")
    expect(data).toEqual({ insertIntoTalkCollection: { records: [{ abstract: ABSTRACT }] } })
  })

  it("reads past comments, block strings, arguments and directives", async () => {
    serve()
    answer = { talkCollection: { edges: [{ node: { abstract: encoded(ABSTRACT) } }] } }
    const query = `# a comment { with a brace
      query ($skip: Boolean = false) {
        talkCollection(filter: { title: { eq: """a } "quoted" { b""" } }) @cached {
          edges { node { abstract @skip(if: $skip) } }
        }
      }`
    const { data } = await client().graphql(query)
    expect(data).toEqual({ talkCollection: { edges: [{ node: { abstract: ABSTRACT } }] } })
  })
})

describe("graphql: a field the client cannot place stays as returned", () => {
  it("leaves the answer alone when the schema cannot be read", async () => {
    serve()
    introspect = () => jsonResponse({ message: "introspection is off" }, 403)
    answer = { talkCollection: { edges: [{ node: { abstract: encoded(ABSTRACT) } }] } }
    const { data, error } = await client().graphql("{ talkCollection { edges { node { abstract } } } }")
    expect(error).toBeNull()
    expect(data).toEqual(answer)
  })

  it("leaves a field the schema does not have, and reads the schema again on the next call", async () => {
    const fetch = serve()
    answer = { talkCollection: { edges: [{ node: { addedSincePush: encoded({ a: 1 }) } }] } }
    const c = client()
    const { data } = await c.graphql("{ talkCollection { edges { node { addedSincePush } } } }")
    expect(data).toEqual(answer)
    await c.graphql("{ talkCollection { edges { node { addedSincePush } } } }")
    expect(introspections(fetch)).toBe(2)
  })

  it("leaves a document with more than one operation, since the server picks which runs", async () => {
    serve()
    answer = { talkCollection: { edges: [{ node: { abstract: encoded(ABSTRACT) } }] } }
    const { data } = await client().graphql("query A { talkCollection { edges { node { abstract } } } } query B { __typename }")
    expect(data).toEqual(answer)
  })

  it("leaves a string that is not JSON", () => {
    const schema = readGraphqlSchema(INTROSPECTION.data)
    if (schema === null) throw new Error("the fixture schema did not read")
    const raw = { talkCollection: { edges: [{ node: { abstract: "not json" } }] } }
    const decoded = decodeGraphqlJsonFields("{ talkCollection { edges { node { abstract } } } }", raw, schema)
    expect(decoded).toEqual({ data: raw, schemaIsStale: false })
  })
})

describe("graphql: the schema is read once, after the query", () => {
  it("sends the query first and introspects once across calls", async () => {
    const fetch = serve()
    answer = { talkCollection: { edges: [{ node: { abstract: encoded(ABSTRACT) } }] } }
    const c = client()
    await c.graphql("{ talkCollection { edges { node { abstract } } } }")
    await c.graphql("{ talkCollection { edges { node { abstract } } } }")
    expect(introspections(fetch)).toBe(1)
    expect(queryOf(fetch, 0)).not.toContain("__schema")
  })

  it("does not introspect for an answer with no strings in it", async () => {
    const fetch = serve()
    answer = { talkCollection: { edges: [] } }
    await client().graphql("{ talkCollection { edges { node { abstract } } } }")
    expect(introspections(fetch)).toBe(0)
  })
})

function queryOf(fetch: FetchMock, n: number): string {
  const call = fetchCalls(fetch)[n]
  const query = call === undefined ? undefined : jsonBody(call.init)["query"]
  return typeof query === "string" ? query : ""
}

function introspections(fetch: FetchMock): number {
  return fetchCalls(fetch).filter((_, n) => queryOf(fetch, n).includes("__schema")).length
}
