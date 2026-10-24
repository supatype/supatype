/**
 * `supatype.graphql()`: the request, what the answer means, and the decoding of its `JSON` fields.
 *
 * The schema the decoding needs is read through the same transport as the query, carrying the same
 * credential, because pg_graphql shows each role only what it may use. It is cached per role, so a
 * refreshed token for the same role reuses it.
 */
import { transportFailure } from "./errors.js"
import type { RequestTransport } from "./fetch-with-retry.js"
import { GRAPHQL_SCHEMA_QUERY, GraphqlSchemaCache, decodeGraphqlAnswer, readGraphqlSchema, type GraphqlSchema } from "./graphql-json.js"
import { isJsonObject, refusalText } from "./json.js"
import { bearerRole } from "./jwt.js"
import { fetchWithOptional401Retry, type HeadersProvider } from "./query.js"
import type { SupatypeError } from "./types.js"

/** Where GraphQL requests go and what they carry. Studio builds one per send-as choice. */
export type GraphqlTransport = {
  /** The `/graphql/v1` URL. */
  readonly endpoint: string
  readonly send: RequestTransport
  readonly headers: HeadersProvider
  readonly onUnauthorized?: (() => Promise<void>) | undefined
  /** Whose schema a request reads, from its headers. Defaults to the bearer token's role. */
  readonly schemaKey?: ((headers: Record<string, string>) => string) | undefined
}

type GraphqlAnswer = { data: unknown; error: SupatypeError | null }
type GraphqlRunner = (
  query: string,
  variables?: Record<string, unknown> | undefined,
  options?: { idempotent?: boolean | undefined } | undefined,
) => Promise<GraphqlAnswer>
type Reply = { readonly json: unknown; readonly res: Response } | { readonly failure: SupatypeError }

/**
 * Runs GraphQL requests over `transport`, decoding `JSON` scalar fields against a schema cached in
 * `schemas`. Pass a long-lived cache when the runner itself is short-lived.
 */
export function createGraphqlRunner(transport: GraphqlTransport, schemas = new GraphqlSchemaCache()): GraphqlRunner {
  const keyOf = transport.schemaKey ?? schemaKey
  const source = {
    key: async (): Promise<string> => keyOf(await transport.headers()),
    load: (): Promise<GraphqlSchema | null> => loadSchema(transport),
  }
  return async (query, variables, options) => {
    const body = { query, ...(variables !== undefined && { variables }) }
    const reply = await post(transport, body, options?.idempotent === true)
    if ("failure" in reply) return { data: null, error: reply.failure }
    const result = graphqlResult(reply.json, reply.res)
    return { data: await decodeGraphqlAnswer({ query, data: result.data }, schemas, source), error: result.error }
  }
}

async function post(transport: GraphqlTransport, body: Record<string, unknown>, idempotent: boolean): Promise<Reply> {
  const init = { method: "POST", body: JSON.stringify(body), ...(idempotent && { idempotent: true }) }
  let res: Response
  try {
    res = await fetchWithOptional401Retry(transport.send, transport.endpoint, init, transport.headers, transport.onUnauthorized)
  } catch (e) {
    return { failure: transportFailure(e) }
  }
  try {
    const json: unknown = await res.json()
    return { json, res }
  } catch {
    return { failure: { message: `GraphQL endpoint returned a non-JSON response (HTTP ${res.status} ${res.statusText})` } }
  }
}

async function loadSchema(transport: GraphqlTransport): Promise<GraphqlSchema | null> {
  const reply = await post(transport, { query: GRAPHQL_SCHEMA_QUERY }, true)
  if ("failure" in reply || !reply.res.ok || !isJsonObject(reply.json)) return null
  return readGraphqlSchema(reply.json["data"])
}

/** Who a schema is read as: the token's role when it names one, otherwise the credential itself. */
function schemaKey(headers: Record<string, string>): string {
  const role = bearerRole(headers)
  return role !== null ? `role:${role}` : `credential:${headers["Authorization"] ?? headers["apikey"] ?? ""}`
}

/** What a GraphQL endpoint's JSON answer means: its data, and the first error it reports. */
function graphqlResult(json: unknown, res: Response): GraphqlAnswer {
  if (!isJsonObject(json)) {
    return { data: null, error: { message: `GraphQL endpoint returned JSON that is not an object (HTTP ${res.status})`, status: res.status } }
  }
  const data = json["data"] ?? null
  if (!res.ok) {
    const message = refusalText(json) ?? `GraphQL request failed (HTTP ${res.status})`
    return { data, error: { message, status: res.status } }
  }
  const errors = json["errors"]
  if (errors === undefined) return { data, error: null }
  const first = Array.isArray(errors) ? errors[0] : undefined
  const message = isJsonObject(first) && typeof first["message"] === "string" ? first["message"] : "GraphQL error"
  return { data, error: { message } }
}
