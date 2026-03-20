import { ref, type Ref } from "vue"
import type { AnyDatabase, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"

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
  TDatabase extends AnyDatabase = AnyDatabase,
>(
  functionName: string,
): UseFunctionReturn<TResponse> {
  const client = useSupatype<TDatabase>()
  const data = ref<TResponse | null>(null) as Ref<TResponse | null>
  const error = ref<SupatypeError | null>(null)
  const loading = ref(false)

  const invoke = async (body?: unknown) => {
    loading.value = true
    error.value = null

    const result = await client.functions.invoke<TResponse>(functionName, {
      ...(body !== undefined ? { body } : {}),
    })

    loading.value = false
    data.value = result.data
    if (result.error) error.value = result.error
    return result
  }

  return { invoke, data, error, loading }
}
