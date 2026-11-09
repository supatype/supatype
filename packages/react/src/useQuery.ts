"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import type { AnyClient, AnyDatabase, AugmentedDatabase, SupatypeError, QueryCacheOptions } from "@supatype/client"
import { onIdentityChange } from "@supatype/client"
import { useSupatype } from "./context.js"
import { isRowsOf, reportThrown, withPage } from "@supatype/client/bindings"

export interface UseQueryOptions {
  /** PostgREST select expression (default: '*') */
  select?: string | undefined
  /** Simple equality filters keyed by column name */
  filter?: Record<string, unknown> | undefined
  /** Column to order by */
  order?: { column: string; ascending?: boolean | undefined } | undefined
  /** Maximum number of rows to return */
  limit?: number | undefined
  /** Row offset (for pagination). With no `limit`, a page of 100 rows is read from it. */
  offset?: number | undefined
  /** Set to false to skip the query (useful for conditional fetching) */
  enabled?: boolean | undefined
  /** Re-fetch interval in milliseconds */
  refetchInterval?: number | undefined
  /** In-memory GET cache; pass `{ server: true }` for Valkey-backed server cache */
  cache?: QueryCacheOptions | undefined
  /**
   * Read the pending draft instead of what is published.
   *
   * For a model that declares `versions`. The rows come back with the same shape, so a preview
   * screen is the published screen with this flag set, rather than a second component.
   *
   * **Not the read rule.** A draft is visible to the record's creator, to the project's elevated
   * Studio roles, or to a caller holding a signed preview link; a caller entitled to published
   * content is not thereby entitled to unpublished edits. A model with no draft view answers
   * `PGRST106`, which arrives here as `error`.
   *
   * This is the *saved* draft. For unsaved keystrokes streamed out of an open Studio tab, see
   * `useLivePreview`, which is a different mechanism answering a different question.
   */
  draft?: boolean | undefined
}

export interface UseQueryResult<TRow> {
  data: TRow[] | null
  error: SupatypeError | null
  count: number | null
  loading: boolean
  refetch(): void
}

/**
 * Fetch rows from a table with automatic re-execution when options change.
 *
 * @example
 * ```tsx
 * const { data: posts, loading } = useQuery('posts', {
 *   filter: { status: 'published' },
 *   order: { column: 'created_at', ascending: false },
 *   limit: 10,
 * })
 * ```
 */
export function useQuery<
  TDatabase extends AnyDatabase = AugmentedDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: UseQueryOptions | undefined,
): UseQueryResult<TRow> {
  const client = useSupatype<TDatabase>()
  const [state, setState] = useState<RowsState<TRow>>({ data: null, error: null, count: null, loading: true })
  const latest = useRef(0)

  // Stable reference to options for the effect dep
  const optionsJson = JSON.stringify(options)

  const execute = useCallback(async () => {
    const request = ++latest.current
    // Only the latest request is shown: an older one that lands after it is dropped, whatever it
    // brought, so it cannot replace newer rows or an error the newer request did not have.
    const show = (next: Partial<RowsState<TRow>>): void => {
      if (request === latest.current) setState((current) => ({ ...current, ...next }))
    }
    if (options?.enabled === false) {
      show({ loading: false })
      return
    }
    show({ loading: true })
    show(await settledRows<TRow>(client as AnyClient, table, options))
    // `optionsJson` stands in for `options`: a caller's inline object is new on every render, and
    // depending on it would read again on every render.
  }, [client, table, optionsJson])

  useRunAndRefetch(execute, options?.refetchInterval)
  useRerunOnIdentityChange(client.auth, execute)

  // Changes only when the query does, so an app can list it as an effect dependency. 0.9.1 release
  // test (RB10): a new function each render made `useEffect(() => refetch(), [refetch])` loop.
  const refetch = useCallback(() => void execute(), [execute])

  return { ...state, refetch }
}

/** What the hook shows: the latest request's answer, and whether one is in flight. */
interface RowsState<TRow> {
  data: TRow[] | null
  error: SupatypeError | null
  count: number | null
  loading: boolean
}

/**
 * The read's answer as the hook shows it. A request that throws (a client with no API address, say)
 * ends like one that was refused, and is reported even when a newer request has replaced it.
 */
async function settledRows<TRow>(
  client: AnyClient,
  table: string,
  options: UseQueryOptions | undefined,
): Promise<RowsState<TRow>> {
  try {
    const result = await readRows(client, table, options)
    return { data: isRowsOf<TRow>(result.data) ? result.data : null, error: result.error, count: result.count, loading: false }
  } catch (e) {
    return { data: null, error: reportThrown(`useQuery("${table}")`, e), count: null, loading: false }
  }
}

/** Run `execute` now and whenever it changes, and every `interval` milliseconds when one is set. */
function useRunAndRefetch(execute: () => Promise<void>, interval: number | undefined): void {
  useEffect(() => {
    void execute()
    if (interval === undefined) return undefined
    const timer = setInterval(() => void execute(), interval)
    return () => clearInterval(timer)
  }, [execute, interval])
}

/**
 * Re-run when the signed-in identity changes. See `onIdentityChange` for which changes count.
 *
 * Through a ref, and keyed on the auth client alone: keying on `execute` would re-subscribe every
 * time the options changed, and each re-subscribe takes a fresh baseline from the emission
 * `onAuthStateChange` makes at registration. A sign-in landing in that window would be read as the
 * baseline rather than as a change, and the query would never re-run.
 */
function useRerunOnIdentityChange(auth: AnyClient["auth"], execute: () => Promise<void>): void {
  const executeRef = useRef(execute)
  executeRef.current = execute
  useEffect(() => onIdentityChange(auth, () => void executeRef.current()), [auth])
}

/**
 * The read `options` describe. Through the untyped client: the generated row types do not survive
 * a table name known only at run time, so the hook types the rows as `TRow` once they arrive.
 */
function readRows(client: AnyClient, table: string, options: UseQueryOptions | undefined) {
  const source = client.from(table)
  // A draft read is the same request against a different schema, so it branches here rather than
  // duplicating every filter below.
  let query = (options?.draft === true ? source.draft() : source).select(options?.select ?? "*")
  for (const [col, val] of Object.entries(options?.filter ?? {})) {
    query = query.eq(col, val)
  }
  if (options?.order !== undefined) {
    query = query.order(options.order.column, { ascending: options.order.ascending ?? true })
  }
  query = withPage(query, options)
  return options?.cache !== undefined ? query.cache(options.cache) : query
}
