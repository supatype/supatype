/**
 * Admin REST cache API client for CLI commands.
 */

import { readEnvValue } from "./env-file.js"
import { resolveProjectApiUrl } from "./resolve-api-url.js"

export interface RestCacheEntrySummary {
  key: string
  table?: string
  scope?: string
  method?: string
  path?: string
  raw_query?: string
  ttl_seconds: number
  size_bytes: number
  cached_at?: string
}

export interface RestCacheListResponse {
  entries: RestCacheEntrySummary[]
  cursor: string
}

export interface RestCacheDetail extends RestCacheEntrySummary {
  status_code: number
  content_type?: string
  body_preview?: string
  body_json?: unknown
}

function serviceRoleKey(cwd: string): string {
  const key =
    readEnvValue(cwd, "SUPATYPE_SERVICE_ROLE_KEY", "").trim() ||
    readEnvValue(cwd, "SERVICE_ROLE_KEY", "").trim()
  if (!key) {
    throw new Error("SERVICE_ROLE_KEY not found in .env — run supatype dev or supatype keys")
  }
  return key.trim()
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
  if (status === 503 && trimmed.includes("valkey")) {
    return "Valkey is not configured — server-side REST cache requires Valkey (supatype dev with docker)."
  }
  return `${operation} failed (${status}): ${trimmed || "(empty body)"}`
}

function normalizeListResponse(data: RestCacheListResponse): RestCacheListResponse {
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
  const data = (await res.json()) as RestCacheListResponse
  return normalizeListResponse(data)
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
  return res.json() as Promise<RestCacheDetail>
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
