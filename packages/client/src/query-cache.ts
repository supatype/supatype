import type { QueryResult } from "./types.js"
import { sha256Hex } from "./sha256-hex.js"
import { bearerToken } from "./query.js"
import { decodeJwtPayload } from "./jwt.js"

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

/** A string claim off the token, or undefined when the token or the claim is not readable. */
function stringClaim(token: string, claim: "sub" | "role"): string | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  const value = decodeJwtPayload(parts[1] ?? "")?.[claim]
  return typeof value === "string" ? value : undefined
}

/**
 * The boundary between the cache's stored results and the type a reader asks for.
 *
 * Nothing about a stored result can be checked against `T`: the cache holds whatever `set` was
 * given. A key names one request (method, URL, select, identity), so the reader of a key is the
 * request that stored it, and `T` is that request's own claim about its rows.
 */
function isResultFor<T>(result: QueryResult<unknown>): result is QueryResult<T> {
  return result.error === null
}

/** Auth component for cache keys, mirrors server IdentityForCache. */
export function identityFingerprint(
  headers: Record<string, string>,
  scope: "public" | "user",
): string {
  if (scope === "public") return "global"
  const token = bearerToken(headers)
  if (!token) return "anon"
  const role = stringClaim(token, "role")?.trim() || "authenticated"
  const sub = stringClaim(token, "sub")?.trim()
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
    return isResultFor<T>(entry.result) ? entry.result : null
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
