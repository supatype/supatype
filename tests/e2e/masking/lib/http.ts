import { isRecord, isRecordArray } from "../../lib/json.js"
import { stack } from "./stack.js"

export interface Reply {
  status: number
  body: unknown
  text: string
  headers: Headers
}

/** JSON when the body parses as JSON, the text otherwise. */
function parse(text: string): unknown {
  if (text === "") return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function call(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const res = await fetch(`${stack().baseUrl}${path}`, {
    method,
    headers: {
      apikey: stack().anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: parse(text), text, headers: res.headers }
}

/** A PostgREST request; writes ask for the affected rows back, as the client does. */
export function rest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return call(method, `/rest/v1/${path}`, token, body, { Prefer: "return=representation", ...headers })
}

export interface GraphqlReply {
  status: number
  data: Record<string, unknown> | null
  errors: string[]
}

export async function gql(token: string, query: string): Promise<GraphqlReply> {
  const reply = await call("POST", "/graphql/v1", token, { query })
  const body = reply.body
  if (!isRecord(body)) return { status: reply.status, data: null, errors: [reply.text] }
  const errors = Array.isArray(body["errors"])
    ? body["errors"].map((e) => (isRecord(e) && "message" in e ? String(e["message"]) : String(e)))
    : []
  const data = isRecord(body["data"]) ? body["data"] : null
  return { status: reply.status, data, errors }
}

/** The rows of a reply that should be an array of objects; anything else is an empty list. */
export function rows(reply: Reply): Record<string, unknown>[] {
  return isRecordArray(reply.body) ? reply.body : []
}

/** The `node` objects of a `<x>Collection { edges { node } }` result. */
export function nodes(reply: GraphqlReply, collection: string): Record<string, unknown>[] {
  const conn = reply.data?.[collection]
  if (!isRecord(conn)) return []
  const edges = conn["edges"]
  if (!Array.isArray(edges)) return []
  return edges.map((e) => (isRecord(e) && isRecord(e["node"]) ? e["node"] : {}))
}
