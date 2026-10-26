import { GraphqlSchemaCache, createGraphqlRunner, type RequestTransport } from "@supatype/client"

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

/** Schemas by endpoint and send-as identity: pg_graphql shows each role only what it may use. */
const schemas = new GraphqlSchemaCache()

/** Studio's requests carry its session cookie, which the proxy reads. */
const withCookies: RequestTransport = (url, init) => fetch(url, { ...init, credentials: "include" })

/**
 * Sends `query` to `endpoint` carrying `headers` (who it is sent as, `send-as.ts`), and formats the
 * answer as the GraphQL panels show it. It goes through the client's GraphQL runner, so rich text,
 * blocks and json fields show as the values they hold, as `graphql()` returns them.
 */
export async function runGraphql(
  endpoint: string,
  query: string,
  headers: Record<string, string>,
): Promise<{ result: string; error: string }> {
  const run = createGraphqlRunner(
    {
      endpoint,
      send: withCookies,
      headers: () => Promise.resolve({ "Content-Type": "application/json", ...headers }),
      // The pasted-token and acting-mode choices change what the same bearer may see.
      schemaKey: () => `${endpoint} ${JSON.stringify(headers)}`,
    },
    schemas,
  )
  return formatGraphqlClientResult(await run(query, {}))
}
