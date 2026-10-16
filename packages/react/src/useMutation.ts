"use client"

import { useState, useCallback } from "react"
import type { AnyClient, AnyDatabase, AugmentedDatabase, MutationBuilder, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"

export type MutationOperation = "insert" | "update" | "delete" | "upsert"

type MutationRows = Record<string, unknown> | Record<string, unknown>[]

export interface MutationOptions {
  /** Simple equality filters for update/delete operations */
  filter?: Record<string, unknown> | undefined
}

export interface UseMutationResult<TRow> {
  mutate(
    data?: Record<string, unknown> | Record<string, unknown>[] | undefined,
    options?: MutationOptions | undefined,
  ): Promise<{ data: TRow[] | null; error: SupatypeError | null; count: number | null }>
  loading: boolean
  error: SupatypeError | null
}

/**
 * Perform insert, update, delete, or upsert on a table.
 *
 * @example
 * ```tsx
 * const { mutate: createPost, loading } = useMutation('posts', 'insert')
 * await createPost({ title: 'Hello', status: 'draft' })
 *
 * const { mutate: deletePost } = useMutation('posts', 'delete')
 * await deletePost(undefined, { filter: { id: postId } })
 * ```
 */
export function useMutation<
  TDatabase extends AnyDatabase = AugmentedDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  operation: MutationOperation,
): UseMutationResult<TRow> {
  const client = useSupatype<TDatabase>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<SupatypeError | null>(null)

  const mutate = useCallback(
    async (
      data?: Record<string, unknown> | Record<string, unknown>[] | undefined,
      options?: MutationOptions | undefined,
    ) => {
      setLoading(true)
      setError(null)

      // Through the untyped client: the generated Insert and Update types do not survive a table
      // name known only at run time, so `data` goes out as the caller wrote it and PostgREST is
      // what checks it.
      const tableClient = (client as AnyClient).from(table)
      let pending: MutationBuilder<Record<string, unknown>>
      if (operation === "insert") {
        pending = tableClient.insert(data as MutationRows)
      } else if (operation === "upsert") {
        pending = tableClient.upsert(data as MutationRows)
      } else {
        pending =
          operation === "update" ? tableClient.update(data as Record<string, unknown>) : tableClient.delete()
        for (const [col, val] of Object.entries(options?.filter ?? {})) {
          pending = pending.eq(col, val)
        }
      }
      const result = (await pending) as { data: TRow[] | null; error: SupatypeError | null; count: number | null }

      setLoading(false)
      if (result.error !== null) setError(result.error)
      return result
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, table, operation],
  )

  return { mutate, loading, error }
}
