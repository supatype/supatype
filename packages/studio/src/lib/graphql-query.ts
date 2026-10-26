import { isJsonObject } from "./json.js"

/** The GraphQL endpoint behind a Studio client's URL. */
export function graphqlEndpoint(clientUrl: string): string {
  return `${clientUrl.replace(/\/+$/, "")}/graphql/v1`
}

/** pg_graphql collection field for a Postgres table (no name inflection). */
export function graphqlCollectionField(tableName: string): string {
  return `${tableName}Collection`
}

/** PascalCase entity name for pg_graphql mutations (e.g. blog_post → BlogPost). */
export function graphqlEntityName(tableName: string): string {
  return tableName
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
}

export function buildGraphqlListQuery(tableName: string, fields: string[]): string {
  const collection = graphqlCollectionField(tableName)
  const fieldLines = fields.length > 0
    ? fields.map((f) => `        ${f}`).join("\n")
    : "        id"
  return `query {
  ${collection} {
    edges {
      node {
${fieldLines}
      }
    }
  }
}`
}

export function formatGraphqlClientResult(res: {
  data: unknown
  error: { message: string } | null
}): { result: string; error: string } {
  if (res.error) {
    return {
      error: res.error.message,
      result: res.data != null ? JSON.stringify(res.data, null, 2) : "",
    }
  }
  return {
    error: "",
    result: JSON.stringify(res.data, null, 2),
  }
}

/** The first error a GraphQL answer reports, or a plain line for a failed request that sent none. */
function graphqlErrorOf(body: unknown, res: Response): string | null {
  const errors = isJsonObject(body) && Array.isArray(body["errors"]) ? body["errors"] : []
  const first: unknown = errors.find(isJsonObject)
  const message = isJsonObject(first) ? first["message"] : undefined
  if (typeof message === "string") return message
  return res.ok ? null : `The request failed (HTTP ${res.status}).`
}

/**
 * Sends `query` to `endpoint` carrying `headers` (who it is sent as, `send-as.ts`), and formats the
 * answer as the GraphQL panels show it.
 */
export async function runGraphql(
  endpoint: string,
  query: string,
  headers: Record<string, string>,
): Promise<{ result: string; error: string }> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ query, variables: {} }),
    credentials: "include",
  })
  const body: unknown = await res.json().catch(() => null)
  const message = graphqlErrorOf(body, res)
  const data = isJsonObject(body) ? body["data"] ?? null : null
  return formatGraphqlClientResult({ data, error: message === null ? null : { message } })
}
