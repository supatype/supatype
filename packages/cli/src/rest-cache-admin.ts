/**
 * Admin REST cache API client for CLI commands.
 */

import { configuredServiceRoleKey } from "./dev-api-keys.js"
import { resolveProjectApiUrl } from "./resolve-api-url.js"
import { isArrayOf, isNumber, isShape, isString, isUnknown, nullable, optional, readJson, type Guard } from "@supatype/shared"

/** One cached response. The server may send `null` for a field it has no value for. */
export interface RestCacheEntrySummary {
  key: string
  table?: string | null
  scope?: string | null
  method?: string | null
  path?: string | null
  raw_query?: string | null
  ttl_seconds: number
  size_bytes: number
  cached_at?: string | null
}

export interface RestCacheListResponse {
  entries: RestCacheEntrySummary[]
  cursor: string
}

export interface RestCacheDetail extends RestCacheEntrySummary {
  status_code: number
  content_type?: string | null
  body_preview?: string | null
  body_json?: unknown
}

const optionalText = optional(nullable(isString))

const summaryShape = {
  key: isString,
  table: optionalText,
  scope: optionalText,
  method: optionalText,
  path: optionalText,
  raw_query: optionalText,
  ttl_seconds: isNumber,
  size_bytes: isNumber,
  cached_at: optionalText,
}

/** `GET /admin/v1/cache`: a page of entries, and where the next one starts. */
const isListAnswer = isShape({
  entries: optional(nullable(isArrayOf(isShape(summaryShape)))),
  cursor: optional(nullable(isString)),
})

const isRestCacheDetail: Guard<RestCacheDetail> = isShape({
  ...summaryShape,
  status_code: isNumber,
  content_type: optionalText,
  body_preview: optionalText,
  body_json: optional(isUnknown),
})

function serviceRoleKey(cwd: string): string {
  const key = configuredServiceRoleKey(cwd)
  if (key === undefined) {
    throw new Error("SERVICE_ROLE_KEY not found in .env, run supatype dev or supatype keys")
  }
  return key
}

function adminHeaders(cwd: string): Record<string, string> {
  const key = serviceRoleKey(cwd)
  return {
    Authorization: `Bearer ${key}`,
    apikey: key,
    "Content-Type": "application/json",
  }
}

function formatCacheApiError(
  operation: string,
  status: number,
  body: string,
  baseUrl: string,
): string {
  const trimmed = body.trim()
  if (status === 404) {
    return (
      `${operation} failed (404): ${trimmed || "not found"}\n` +
      `  API: ${baseUrl}/admin/v1/cache\n` +
      "  Start the stack with `supatype dev`, or check SUPATYPE_URL / PUBLIC_SUPATYPE_URL in .env."
    )
  }
  if (status === 403 && trimmed.includes("rest_cache_not_available")) {
    return "REST server cache is not available on this plan or deployment."
  }
  // Both spellings: the server answers "keyspace not configured" now and
  // "valkey not configured" before the rename, and a CLI is routinely newer
  // than the deployment it is pointed at.
  if (status === 503 && (trimmed.includes("keyspace") || trimmed.includes("valkey"))) {
    return (
      "No cache server is configured, and server-side REST caching needs one. " +
      "`supatype dev` starts it for you; on a self-hosted stack, check the `db` or `valkey` service."
    )
  }
  return `${operation} failed (${status}): ${trimmed || "(empty body)"}`
}

function normalizeListResponse(data: {
  entries?: RestCacheEntrySummary[] | null
  cursor?: string | null
}): RestCacheListResponse {
  return {
    entries: data.entries ?? [],
    cursor: data.cursor ?? "0",
  }
}

export async function listRestCacheEntries(
  cwd: string,
  opts?: { table?: string | undefined; cursor?: string | undefined; limit?: number | undefined },
): Promise<RestCacheListResponse> {
  const baseUrl = resolveProjectApiUrl(cwd)
  const params = new URLSearchParams()
  if (opts?.table) params.set("table", opts.table)
  if (opts?.cursor) params.set("cursor", opts.cursor)
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit))
  const qs = params.toString()
  const url = `${baseUrl}/admin/v1/cache${qs ? `?${qs}` : ""}`
  const res = await fetch(url, { headers: adminHeaders(cwd) })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(formatCacheApiError("list cache", res.status, body, baseUrl))
  }
  return normalizeListResponse(await readJson(res, isListAnswer))
}

export async function getRestCacheEntry(cwd: string, key: string): Promise<RestCacheDetail> {
  const baseUrl = resolveProjectApiUrl(cwd)
  const enc = Buffer.from(key, "utf8").toString("base64url")
  const url = `${baseUrl}/admin/v1/cache/entries/${encodeURIComponent(enc)}`
  const res = await fetch(url, { headers: adminHeaders(cwd) })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(formatCacheApiError("get cache entry", res.status, body, baseUrl))
  }
  return readJson(res, isRestCacheDetail)
}

export async function deleteRestCacheEntry(cwd: string, key: string): Promise<void> {
  const baseUrl = resolveProjectApiUrl(cwd)
  const enc = Buffer.from(key, "utf8").toString("base64url")
  const url = `${baseUrl}/admin/v1/cache/entries/${encodeURIComponent(enc)}`
  const res = await fetch(url, { method: "DELETE", headers: adminHeaders(cwd) })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(formatCacheApiError("delete cache entry", res.status, body, baseUrl))
  }
}

export async function flushRestCache(cwd: string, table?: string): Promise<void> {
  const baseUrl = resolveProjectApiUrl(cwd)
  const params = new URLSearchParams()
  if (table) params.set("table", table)
  const qs = params.toString()
  const url = `${baseUrl}/admin/v1/cache${qs ? `?${qs}` : ""}`
  const res = await fetch(url, { method: "DELETE", headers: adminHeaders(cwd) })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(formatCacheApiError("flush cache", res.status, body, baseUrl))
  }
}
