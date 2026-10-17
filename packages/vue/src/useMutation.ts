import { ref, type Ref } from "vue"
import type { AugmentedDatabase, AnyClient, AnyDatabase, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"
import { runMutation, type MutationOperation } from "./mutation-request.js"

export type { MutationOperation }

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
      const outcome = await runMutation<TRow>(client as AnyClient, table, operation, data, options?.filter)
      const result = { data: outcome.data, error: outcome.error }

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
