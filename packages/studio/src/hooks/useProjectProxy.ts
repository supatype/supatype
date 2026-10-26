import { useCallback, useMemo } from "react"
import { DatabaseError, sqlstateInMessage, sqlstateOf } from "../lib/database-error.js"
import { studioAuthHeaders, usesSessionProxy } from "../lib/studio-auth-headers.js"
import { studioGatewayHeaders } from "../lib/studio-gateway-headers.js"
import type { SupatypeClient } from "@supatype/client"
import { useAdminClient } from "./useAdminClient.js"

export interface SqlResult {
  rows: Record<string, unknown>[]
  rowCount: number | null
  /** The schema the server actually used, returned in the response. */
  schema?: string
}

export interface SchemaColumn {
  name: string
  type: string
  nullable: boolean
  is_primary: boolean
  is_foreign_key: boolean
  references: string | null
  default_value: string | null
  enum_values: string[] | null
  is_unique: boolean
  is_indexed: boolean
}

export interface SchemaTable {
  name: string
  schema: string
  row_count: number
  columns: SchemaColumn[]
}

/** The queries in the server's metadata catalogue (`studio-metadata.json` on both hosts). */
export type MetadataName =
  | "schemas"
  | "tables"
  | "columns"
  | "constraints"
  | "indexes"
  | "functions"
  | "triggers"
  | "types"
  | "views"
  | "extensions_installed"
  | "extensions_available"
  | "roles"
  | "owned_objects"
  | "ledger_kinds"
  | "ledger_objects"
  | "ledger_count"
  | "policies"
  | "rls_status"
  | "migrations_audited"
  | "migrations"
  | "migrations_legacy"
  | "migration_sql"
  | "seeds"
  | "database_settings"

/** A metadata query's parameters, by name: plain values only, bound by the server. */
export type MetadataParams = Record<string, string | number | boolean | null>

export interface ProjectProxy {
  /** Execute a SQL query. Optionally hint a schema, server enforces access. */
  sql: (query: string, schema?: string) => Promise<SqlResult>
  /** One named, read-only metadata query (RQ3): the Database views read through this. */
  metadata: (name: MetadataName, params?: MetadataParams) => Promise<SqlResult>
  /** A schema's tables and columns, for every role that may read rows. */
  introspect: (schema?: string) => Promise<SchemaTable[]>
  /** List schemas accessible to the current JWT role. */
  schemas: () => Promise<string[]>
}

/** What the SQL proxy answers: rows on success; on failure a message, and the SQLSTATE if passed on. */
type SqlResponseBody = Partial<SqlResult> & { error?: string; message?: string; code?: unknown }

/**
 * The rows of a SQL proxy answer, or the failure it reports as a `DatabaseError` carrying the
 * SQLSTATE, so Studio can tell failures apart by code rather than by message. Cloud's proxy puts
 * the message in `message` with a category in `error`; the server and engine put it in `error`,
 * and the server ends it with `(SQLSTATE xxxxx)`, read when no `code` field says otherwise.
 */
export async function readSqlResponse(res: Response): Promise<SqlResult> {
  const json = (await res.json()) as SqlResponseBody
  if (!res.ok) {
    const message = json.message ?? json.error ?? "SQL execution failed"
    throw new DatabaseError(message, sqlstateOf(json) ?? sqlstateInMessage(message))
  }
  const rows = Array.isArray(json.rows) ? json.rows : []
  return {
    rows,
    rowCount: json.rowCount ?? rows.length,
    ...(json.schema !== undefined && { schema: json.schema }),
  }
}

/** POST one catalogue query to `route` on the project proxy; the server binds its parameters. */
async function postCatalogue(client: SupatypeClient, route: string, name: string, params: MetadataParams): Promise<SqlResult> {
  const res = await fetch(`${client.url}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...studioGatewayHeaders(), ...studioAuthHeaders(client) },
    credentials: "include",
    body: JSON.stringify({ name, params }),
  })
  return readSqlResponse(res)
}

/** A boolean column as either host's driver hands it back. */
function truthy(value: unknown): boolean {
  return value === true || value === "t"
}

/** One row of the introspect query as a column. */
function columnFromRow(row: Record<string, unknown>): SchemaColumn {
  return {
    name: row["column_name"] as string,
    type: row["udt_name"] as string,
    nullable: row["is_nullable"] === "YES",
    is_primary: truthy(row["is_primary"]),
    is_foreign_key: truthy(row["is_foreign_key"]),
    references: (row["references_col"] as string | null) ?? null,
    default_value: (row["column_default"] as string | null) ?? null,
    enum_values: null,
    is_unique: truthy(row["is_unique"]),
    is_indexed: truthy(row["is_primary"]),
  }
}

/** The introspect query's rows, one per column, folded into one entry per table in order. */
export function tablesFromColumns(rows: Array<Record<string, unknown>>): SchemaTable[] {
  const tables = new Map<string, SchemaTable>()
  for (const row of rows) {
    const name = row["table_name"] as string
    let table = tables.get(name)
    if (!table) {
      table = { name, schema: row["table_schema"] as string, row_count: Number(row["row_count"] ?? 0), columns: [] }
      tables.set(name, table)
    }
    table.columns.push(columnFromRow(row))
  }
  return Array.from(tables.values())
}


/**
 * Wraps raw fetch calls to the project proxy for SQL execution and schema
 * introspection. Schema routing is enforced server-side from the JWT role
 * claim: the client may send a hint but cannot exceed its permissions.
 */
export function useProjectProxy(): ProjectProxy {
  const client = useAdminClient()
  const sessionProxy = usesSessionProxy(client)

  const sql = useCallback(
    async (query: string, schema?: string): Promise<SqlResult> => {
      if (!client.url) {
        throw new Error("SQL proxy URL is not configured, client URL is missing")
      }
      if (!sessionProxy) {
        throw new Error(
          "SQL proxy requires the session proxy, Studio no longer accepts a service role key in the browser",
        )
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...studioGatewayHeaders(),
        ...studioAuthHeaders(client),
      }
      const res = await fetch(`${client.url}/sql`, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ query, ...(schema !== undefined && { schema }) }),
      })
      return readSqlResponse(res)
    },
    [client.url, sessionProxy],
  )

  // RQ3: one named, read-only query from the server's metadata catalogue, its parameters bound
  // server-side. Open to every role with schema view, where `sql` is for the SQL editor's roles.
  const metadata = useCallback(
    (name: MetadataName, params: MetadataParams = {}): Promise<SqlResult> => postCatalogue(client, "/metadata", name, params),
    [client],
  )

  // A schema's tables and columns, through the catalogue's introspect query on its own route, which
  // every role that may read rows reaches: editors use Data Explorer without holding schema view.
  const introspect = useCallback(async (schema?: string): Promise<SchemaTable[]> => {
    const result = await postCatalogue(client, "/metadata/introspect", "introspect", { schema: schema ?? "public" })
    return tablesFromColumns(result.rows)
  }, [client])

  // Schemas that contain at least one base table (hides empty public/extensions/auth shells).
  const schemas = useCallback(async (): Promise<string[]> => {
    const result = await metadata("schemas")
    return result.rows.map((r) => r["schema_name"] as string)
  }, [metadata])

  return useMemo(() => ({ sql, metadata, introspect, schemas }), [sql, metadata, introspect, schemas])
}
