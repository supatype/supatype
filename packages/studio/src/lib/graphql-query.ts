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
