import { ref, type Ref } from "vue"
import type { AugmentedDatabase, AnyClient, AnyDatabase, MutationBuilder, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"

export type MutationOperation = "insert" | "update" | "delete" | "upsert"

type MutationRows = Record<string, unknown> | Record<string, unknown>[]

export interface MutationOptions {
  filter?: Record<string, unknown> | undefined
}

export interface UseMutationReturn<TRow> {
  mutate: (
    data?: Record<string, unknown> | Record<string, unknown>[] | undefined,
    options?: MutationOptions | undefined,
  ) => Promise<{ data: TRow[] | null; error: SupatypeError | null }>
  loading: Ref<boolean>
  error: Ref<SupatypeError | null>
}

/**
 * Mutation composable for insert, update, delete, and upsert operations.
 *
 * @example
 * ```vue
 * <script setup>
 * import { useMutation } from '@supatype/vue'
 *
 * const { mutate: createPost, loading } = useMutation('posts', 'insert')
 *
 * async function handleSubmit() {
 *   const { data, error } = await createPost({ title: 'Hello', status: 'draft' })
 * }
 * </script>
 * ```
 */
export function useMutation<
  TDatabase extends AnyDatabase = AugmentedDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  operation: MutationOperation,
): UseMutationReturn<TRow> {
  const client = useSupatype<TDatabase>()
  const loading = ref(false)
  const error = ref<SupatypeError | null>(null)

  const mutate = async (
    data?: Record<string, unknown> | Record<string, unknown>[] | undefined,
    options?: MutationOptions | undefined,
  ) => {
    loading.value = true
    error.value = null

    try {
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
      const result = (await pending) as { data: TRow[] | null; error: SupatypeError | null }

      if (result.error) error.value = result.error
      return result
    } catch (e) {
      const err = { message: e instanceof Error ? e.message : "Unknown error" }
      error.value = err
      return { data: null, error: err }
    } finally {
      loading.value = false
    }
  }

  return { mutate, loading, error }
}
