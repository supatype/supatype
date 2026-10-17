import { useCallback, useMemo } from "react"
import { DatabaseError, sqlstateInMessage, sqlstateOf } from "../lib/database-error.js"
import { isJsonObject, isString } from "../lib/json.js"
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
  | "schema_push_status"
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
  /** Enable or disable one extension through the allow-listed admin route (SQ2). */
  studioExtension: (name: string, enable: boolean) => Promise<void>
  /** Switch row level security on one auth or storage table (SQ2). */
  studioRls: (schema: StudioAdminSchema, table: string, enable: boolean) => Promise<void>
  /** Create or drop one policy on an auth or storage table (SQ2). */
  studioPolicy: (body: StudioPolicyWrite) => Promise<void>
}

/** The schemas whose RLS and policies Studio writes through `/studio-admin`, not the SQL editor. */
export type StudioAdminSchema = "auth" | "storage"

export function isStudioAdminSchema(schema: string): schema is StudioAdminSchema {
  return schema === "auth" || schema === "storage"
}

export type PolicyCommand = "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE"

/** One policy write: `create` carries the policy's shape, `drop` only names it. */
export interface StudioPolicyWrite {
  schema: StudioAdminSchema
  table: string
  op: "create" | "drop"
  name: string
  command?: PolicyCommand
  roles?: string[]
  using?: string | null
  check?: string | null
}

/** `value` when it is a string, else null. */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

/**
 * The rows of a SQL proxy answer, or the failure it reports as a `DatabaseError` carrying the
 * SQLSTATE, so Studio can tell failures apart by code rather than by message. Cloud's proxy puts
 * the message in `message` with a category in `error`; the server and engine put it in `error`,
 * and the server ends it with `(SQLSTATE xxxxx)`, read when no `code` field says otherwise.
 */
export async function readSqlResponse(res: Response): Promise<SqlResult> {
  const body = await res.json()
  const json = isJsonObject(body) ? body : {}
  if (!res.ok) {
    const message = text(json["message"]) ?? text(json["error"]) ?? "SQL execution failed"
    throw new DatabaseError(message, sqlstateOf(json) ?? sqlstateInMessage(message))
  }
  const rows = Array.isArray(json["rows"]) ? json["rows"].filter(isJsonObject) : []
  const rowCount = json["rowCount"]
  const schema = json["schema"]
  return {
    rows,
    rowCount: typeof rowCount === "number" ? rowCount : rows.length,
    ...(typeof schema === "string" && { schema }),
  }
}

/** POST a JSON body to `route` on the project proxy, as Studio's session. */
function postProxy(client: SupatypeClient, route: string, body: object): Promise<Response> {
  return fetch(`${client.url}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...studioGatewayHeaders(), ...studioAuthHeaders(client) },
    credentials: "include",
    body: JSON.stringify(body),
  })
}

/** POST one catalogue query to `route` on the project proxy; the server binds its parameters. */
async function postCatalogue(client: SupatypeClient, route: string, name: string, params: MetadataParams): Promise<SqlResult> {
  return readSqlResponse(await postProxy(client, route, { name, params }))
}

/** POST one write to an allow-listed `/studio-admin` route; a refusal throws as the SQL route's do. */
async function postStudioAdmin(client: SupatypeClient, path: string, body: object): Promise<void> {
  await readSqlResponse(await postProxy(client, `/studio-admin/${path}`, body))
}

/** The SQ2 writes: extensions, RLS and auth/storage policies, each on its own audited route. */
function studioAdminWrites(client: SupatypeClient): Pick<ProjectProxy, "studioExtension" | "studioRls" | "studioPolicy"> {
  return {
    studioExtension: (name, enable) => postStudioAdmin(client, "extensions", { name, enable }),
    studioRls: (schema, table, enable) => postStudioAdmin(client, "rls", { schema, table, enable }),
    studioPolicy: (body) => postStudioAdmin(client, "policies", body),
  }
}

/** A boolean column as either host's driver hands it back. */
function truthy(value: unknown): boolean {
  return value === true || value === "t"
}

/** One row of the introspect query as a column. */
function columnFromRow(row: Record<string, unknown>): SchemaColumn {
  return {
    name: text(row["column_name"]) ?? "",
    type: text(row["udt_name"]) ?? "",
    nullable: row["is_nullable"] === "YES",
    is_primary: truthy(row["is_primary"]),
    is_foreign_key: truthy(row["is_foreign_key"]),
    references: text(row["references_col"]),
    default_value: text(row["column_default"]),
    enum_values: null,
    is_unique: truthy(row["is_unique"]),
    is_indexed: truthy(row["is_primary"]),
  }
}

/** The introspect query's rows, one per column, folded into one entry per table in order. */
export function tablesFromColumns(rows: Array<Record<string, unknown>>): SchemaTable[] {
  const tables = new Map<string, SchemaTable>()
  for (const row of rows) {
    const name = text(row["table_name"]) ?? ""
    let table = tables.get(name)
    if (!table) {
      table = { name, schema: text(row["table_schema"]) ?? "", row_count: Number(row["row_count"] ?? 0), columns: [] }
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
      return readSqlResponse(await postProxy(client, "/sql", { query, ...(schema !== undefined && { schema }) }))
    },
    [client, sessionProxy],
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
    return result.rows.map((r) => r["schema_name"]).filter(isString)
  }, [metadata])

  const admin = useMemo(() => studioAdminWrites(client), [client])

  return useMemo(() => ({ sql, metadata, introspect, schemas, ...admin }), [sql, metadata, introspect, schemas, admin])
}
