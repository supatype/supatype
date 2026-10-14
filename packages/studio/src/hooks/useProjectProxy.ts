import { useCallback, useMemo } from "react"
import { DatabaseError, sqlstateInMessage, sqlstateOf } from "../lib/database-error.js"
import { studioAuthHeaders, usesSessionProxy } from "../lib/studio-auth-headers.js"
import { studioGatewayHeaders } from "../lib/studio-gateway-headers.js"
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
  /** Introspect tables in the given schema (server validates JWT role). */
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

  // The introspection SQL uses current_schema(), the server resolves the
  // actual schema via SET LOCAL before executing, so current_schema() reflects
  // whatever the server allowed based on the JWT role.
  const introspect = useCallback(async (schema?: string): Promise<SchemaTable[]> => {
    // Use the schema name directly in the query rather than current_schema() to
    // avoid any dependency on the connection-level search_path setting.
    const s = (schema ?? "public").replace(/[^a-zA-Z0-9_]/g, "")
    const introspectionQuery = `
      WITH pk AS (
        SELECT kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = '${s}'
      ),
      fk AS (
        SELECT DISTINCT
          kcu.table_name, kcu.column_name,
          ccu.table_schema || '.' || ccu.table_name || '.' || ccu.column_name AS references_col
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '${s}'
      ),
      uq AS (
        SELECT kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = '${s}'
      ),
      idx AS (
        SELECT tablename AS table_name, unnest(string_to_array(indexdef, ',')) AS col_expr,
               indexname
        FROM pg_indexes WHERE schemaname = '${s}'
      ),
      row_counts AS (
        SELECT relname AS table_name, GREATEST(reltuples::bigint, 0) AS row_count
        FROM pg_class
        JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
        WHERE pg_namespace.nspname = '${s}' AND relkind = 'r'
      )
      SELECT
        c.table_name,
        c.table_schema,
        c.column_name,
        c.data_type,
        c.udt_name,
        c.is_nullable,
        c.column_default,
        COALESCE(pk.column_name IS NOT NULL, false) AS is_primary,
        COALESCE(fk.column_name IS NOT NULL, false) AS is_foreign_key,
        fk.references_col,
        COALESCE(uq.column_name IS NOT NULL, false) AS is_unique,
        COALESCE(rc.row_count, 0) AS row_count
      FROM information_schema.columns c
      LEFT JOIN pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
      LEFT JOIN fk ON fk.table_name = c.table_name AND fk.column_name = c.column_name
      LEFT JOIN uq ON uq.table_name = c.table_name AND uq.column_name = c.column_name
      LEFT JOIN row_counts rc ON rc.table_name = c.table_name
      WHERE c.table_schema = '${s}'
        AND left(c.table_name, 1) <> '_'
      ORDER BY c.table_name, c.ordinal_position
    `

    const result = await sql(introspectionQuery, schema)

    const tableMap = new Map<string, SchemaTable>()
    for (const row of result.rows) {
      const tableName = row["table_name"] as string
      if (!tableMap.has(tableName)) {
        tableMap.set(tableName, {
          name: tableName,
          schema: row["table_schema"] as string,
          row_count: Number(row["row_count"] ?? 0),
          columns: [],
        })
      }
      const table = tableMap.get(tableName)!
      table.columns.push({
        name: row["column_name"] as string,
        type: row["udt_name"] as string,
        nullable: row["is_nullable"] === "YES",
        is_primary: row["is_primary"] === true || row["is_primary"] === "t",
        is_foreign_key: row["is_foreign_key"] === true || row["is_foreign_key"] === "t",
        references: (row["references_col"] as string | null) ?? null,
        default_value: (row["column_default"] as string | null) ?? null,
        enum_values: null,
        is_unique: row["is_unique"] === true || row["is_unique"] === "t",
        is_indexed: row["is_primary"] === true || row["is_primary"] === "t",
      })
    }

    return Array.from(tableMap.values())
  }, [sql])

  // RQ3: one named, read-only query from the server's metadata catalogue, its parameters bound
  // server-side. Open to every role with schema view, where `sql` is for the SQL editor's roles.
  const metadata = useCallback(
    async (name: MetadataName, params: MetadataParams = {}): Promise<SqlResult> => {
      const res = await fetch(`${client.url}/metadata`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...studioGatewayHeaders(), ...studioAuthHeaders(client) },
        credentials: "include",
        body: JSON.stringify({ name, params }),
      })
      return readSqlResponse(res)
    },
    [client],
  )

  // Schemas that contain at least one base table (hides empty public/extensions/auth shells).
  const schemas = useCallback(async (): Promise<string[]> => {
    const result = await metadata("schemas")
    return result.rows.map((r) => r["schema_name"] as string)
  }, [metadata])

  return useMemo(() => ({ sql, metadata, introspect, schemas }), [sql, metadata, introspect, schemas])
}
