import { useAdminClient } from "./useAdminClient.js"
import { useApiQuery, type ApiQueryResult } from "./useApiQuery.js"
import { studioAuthHeaders } from "../lib/studio-auth-headers.js"
import { type Guard, isNumber, isShape, isString, nullable, optional, readJson, readJsonObject } from "../lib/json.js"

/** One Postgres address as the operator's own machine reaches it. Never carries a password. */
export interface DbEndpoint {
  host: string
  port: number
  database: string
  user: string
  /** The query string without its "?", such as "sslmode=require". */
  params?: string
}

/**
 * GET /admin/v1/database/connection: what the deployment declared about reaching its database.
 *
 * `direct` is null when the database is not published to the host, and `unavailable` says why.
 * `pooler` is null unless the deployment runs one; self-host ships none.
 */
export interface DatabaseConnection {
  direct: DbEndpoint | null
  pooler: DbEndpoint | null
  unavailable?: string
}

const isDbEndpoint: Guard<DbEndpoint> = isShape({
  host: isString,
  port: isNumber,
  database: isString,
  user: isString,
  params: optional(isString),
})

const isDatabaseConnection: Guard<DatabaseConnection> = isShape({
  direct: nullable(isDbEndpoint),
  pooler: nullable(isDbEndpoint),
  unavailable: optional(isString),
})

/** Shown in a connection string where the password goes, until the person supplies their own. */
export const PASSWORD_PLACEHOLDER = "[YOUR-PASSWORD]"

/**
 * Percent-encodes one part of a connection URL. A generated password can hold `@`, `/` or `:`,
 * any of which unescaped moves the host part of the URL. `encodeURIComponent` leaves `'` alone,
 * and the psql command wraps the URL in single quotes, so a `'` would end the shell argument.
 */
function encodeUrlPart(part: string): string {
  return encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** A libpq connection URL for `endpoint`, with the placeholder where the password goes until one is given. */
export function connectionString(endpoint: DbEndpoint, password?: string): string {
  const secret = password === undefined ? PASSWORD_PLACEHOLDER : encodeUrlPart(password)
  const query = endpoint.params ? `?${endpoint.params}` : ""
  // The server sends a bare IPv6 address, which needs its brackets back to sit before a port.
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host
  const user = encodeUrlPart(endpoint.user)
  return `postgresql://${user}:${secret}@${host}:${endpoint.port}/${encodeUrlPart(endpoint.database)}${query}`
}

async function fetchConnection(url: string, headers: Record<string, string>): Promise<DatabaseConnection> {
  const res = await fetch(`${url}/admin/v1/database/connection`, { headers, credentials: "include" })
  if (!res.ok) {
    const error = (await readJsonObject(res))["error"]
    throw new Error(typeof error === "string" ? error : `connection details request failed (${res.status})`)
  }
  return readJson(res, isDatabaseConnection)
}

/**
 * This project's database connection details, from the server. The one source for every
 * connection string Studio shows: they used to be built from the API URL, which named the gateway's
 * port and a login and database the project does not have.
 */
export function useDatabaseConnection(): ApiQueryResult<DatabaseConnection> {
  const client = useAdminClient()
  return useApiQuery(() => fetchConnection(client.url, studioAuthHeaders(client)), [client])
}
