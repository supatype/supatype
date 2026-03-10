import { useState, useCallback } from "react"
import type { AnyDatabase, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"

export type MutationOperation = "insert" | "update" | "delete" | "upsert"

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
  TDatabase extends AnyDatabase = AnyDatabase,
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

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tableClient = client.from(table) as any

      let result: { data: TRow[] | null; error: SupatypeError | null; count: number | null }

      if (operation === "insert") {
        result = await tableClient.insert(data)
      } else if (operation === "upsert") {
        result = await tableClient.upsert(data)
      } else if (operation === "update") {
        let q = tableClient.update(data)
        if (options?.filter !== undefined) {
          for (const [col, val] of Object.entries(options.filter)) {
            q = q.eq(col, val)
          }
        }
        result = await q
      } else {
        // delete
        let q = tableClient.delete()
        if (options?.filter !== undefined) {
          for (const [col, val] of Object.entries(options.filter)) {
            q = q.eq(col, val)
          }
        }
        result = await q
      }

      setLoading(false)
      if (result.error !== null) setError(result.error)
      return result
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, table, operation],
  )

  return { mutate, loading, error }
}
