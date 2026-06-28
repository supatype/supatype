import type { QueryResult } from "./types.js"
import { sha256Hex } from "./sha256-hex.js"

export interface QueryCacheOptions {
  /** Client-side TTL in milliseconds. */
  ttl: number
  /** When true, send `X-Supatype-Cache: max-age=N` for server-side Valkey caching. */
  server?: boolean | undefined
  /** When true (with server), request shared public cache scope when allowed for the table. */
  public?: boolean | undefined
  /** Optional manual cache partition key. */
  key?: string | undefined
}

export type CacheStatus = "HIT" | "MISS" | "BYPASS" | undefined

interface CacheEntry<T> {
  result: QueryResult<T>
  expiresAt: number
}

const DEFAULT_MAX_ENTRIES = 256

interface JwtPayload {
  sub?: string
  role?: string
}

function bearerOrApikey(headers: Record<string, string>): string {
  const auth = headers["Authorization"] ?? headers["authorization"] ?? ""
  if (auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length)
  }
  return headers["apikey"] ?? headers["Apikey"] ?? ""
}

function parseJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const payloadJson = atob(parts[1] ?? "")
    return JSON.parse(payloadJson) as JwtPayload
  } catch {
    return null
  }
}

/** Auth component for cache keys — mirrors server IdentityForCache. */
export function identityFingerprint(
  headers: Record<string, string>,
  scope: "public" | "user",
): string {
  if (scope === "public") return "global"
  const token = bearerOrApikey(headers)
  if (!token) return "anon"
  const claims = parseJwtPayload(token)
  const role = claims?.role?.trim() || "authenticated"
  const sub = claims?.sub?.trim()
  if (sub) return `${role}:${sub}`
  return sha256Hex(token).slice(0, 16)
}

export function buildCacheKey(
  method: string,
  url: string,
  headers: Record<string, string>,
  options?: { partition?: string | undefined; public?: boolean | undefined },
): string {
  const scope = options?.public === true ? "public" : "user"
  const parts = [method, url, identityFingerprint(headers, scope)]
  if (options?.partition) parts.push(options.partition)
  return sha256Hex(parts.join("\0"))
}

export class QueryCache {
  private readonly maxEntries: number
  private readonly store = new Map<string, CacheEntry<unknown>>()

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries
  }

  get<T>(key: string): QueryResult<T> | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }
    return entry.result as QueryResult<T>
  }

  set<T>(key: string, result: QueryResult<T>, ttlMs: number): void {
    if (ttlMs <= 0 || result.error !== null) return
    if (this.store.size >= this.maxEntries) {
      const first = this.store.keys().next().value
      if (first !== undefined) this.store.delete(first)
    }
    this.store.set(key, {
      result: result as QueryResult<unknown>,
      expiresAt: Date.now() + ttlMs,
    })
  }

  clear(): void {
    this.store.clear()
  }
}

/** Shared in-memory cache for table GET queries. */
export const defaultQueryCache = new QueryCache()
