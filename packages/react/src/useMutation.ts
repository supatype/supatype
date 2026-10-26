"use client"

import { useState, useCallback } from "react"
import type { AnyClient, AnyDatabase, AugmentedDatabase, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"
import { runMutation, type MutationOperation, type MutationOutcome } from "./mutation-request.js"

export type { MutationOperation }

export interface MutationOptions {
  /** Simple equality filters for update/delete operations */
  filter?: Record<string, unknown> | undefined
}

export interface UseMutationResult<TRow> {
  mutate(
    data?: Record<string, unknown> | Record<string, unknown>[] | undefined,
    options?: MutationOptions | undefined,
  ): Promise<MutationOutcome<TRow>>
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
      try {
        const result = await runMutation<TRow>(client as AnyClient, table, operation, data, options?.filter)
        if (result.error !== null) setError(result.error)
        return result
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, table, operation],
  )

  return { mutate, loading, error }
}
