"use client"

import { useState, useCallback } from "react"
import type { AnyClient, AnyDatabase, AugmentedDatabase, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"
import { reportThrown, runMutation, type MutationOperation, type MutationOutcome, type MutationRequest } from "@supatype/client/bindings"

export type { MutationOperation }

/**
 * `filter`: equality filters for an update or delete. `publish`: for an update on a model that keeps
 * drafts, publish the drafts it saves in the same call. `select`: return the written rows, `true` for
 * every column or the columns as `.select()` takes them; without it `data` is null.
 */
export type MutationOptions = MutationRequest

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
 * const { data } = await createPost({ title: 'Hello', status: 'draft' }, { select: 'id' })
 *
 * const { mutate: editPost } = useMutation('posts', 'update')
 * await editPost({ title: 'Hello again' }, { filter: { id: postId }, publish: true })
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
        const result = await runMutation<TRow>(client as AnyClient, table, operation, data, options)
        if (result.error !== null) setError(result.error)
        return result
      } catch (e) {
        const thrown = reportThrown(`useMutation("${table}", "${operation}")`, e)
        setError(thrown)
        return { data: null, error: thrown, count: null }
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, table, operation],
  )

  return { mutate, loading, error }
}
