import { ref, shallowRef, type Ref } from "vue"
import type { AugmentedDatabase, AnyDatabase, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"
import { isCallerValue } from "./caller-types.js"

export interface UseFunctionReturn<TResponse> {
  invoke: (body?: unknown) => Promise<{ data: TResponse | null; error: SupatypeError | null }>
  data: Ref<TResponse | null>
  error: Ref<SupatypeError | null>
  loading: Ref<boolean>
}

/**
 * Edge function invocation composable.
 *
 * @example
 * ```vue
 * <script setup>
 * import { useFunction } from '@supatype/vue'
 *
 * const { invoke, data, loading } = useFunction<{ orderId: string }>('process-order')
 *
 * async function handleSubmit() {
 *   await invoke({ items: cart.value, address: address.value })
 * }
 * </script>
 * ```
 */
export function useFunction<
  TResponse = unknown,
  TDatabase extends AnyDatabase = AugmentedDatabase,
>(
  functionName: string,
): UseFunctionReturn<TResponse> {
  const client = useSupatype<TDatabase>()
  // Shallow: an answer is replaced whole, and `ref` would type it as `UnwrapRef<TResponse>`.
  const data = shallowRef<TResponse | null>(null)
  const error = ref<SupatypeError | null>(null)
  const loading = ref(false)

  const invoke = async (body?: unknown) => {
    loading.value = true
    error.value = null

    try {
      const result = await client.functions.invoke(functionName, {
        ...(body !== undefined ? { body } : {}),
      })
      const answer = { data: isCallerValue<TResponse>(result.data) ? result.data : null, error: result.error }
      data.value = answer.data
      if (answer.error) error.value = answer.error
      return answer
    } finally {
      loading.value = false
    }
  }

  return { invoke, data, error, loading }
}
