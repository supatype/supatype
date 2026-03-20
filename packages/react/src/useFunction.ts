import { useState, useCallback } from "react"
import type { AnyDatabase, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"

export interface FunctionCallOptions {
  /** HTTP method. Default: POST */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | undefined
  /** Extra request headers */
  headers?: Record<string, string> | undefined
}

export interface UseFunctionResult<TResponse> {
  /** Invoke the function with optional options */
  invoke(body?: unknown, options?: FunctionCallOptions | undefined): Promise<{ data: TResponse | null; error: SupatypeError | null }>
  /** Most recent response data */
  data: TResponse | null
  /** Most recent error */
  error: SupatypeError | null
  /** True while the function is executing */
  loading: boolean
}

/**
 * Invoke a Supatype Edge Function.
 *
 * @example
 * ```tsx
 * const { invoke, data, loading, error } = useFunction<OrderResult>('process-order')
 *
 * const handleSubmit = async () => {
 *   const { data, error } = await invoke({ items: cart, address })
 *   if (data) router.push(`/orders/${data.orderId}`)
 * }
 * ```
 */
export function useFunction<
  TResponse = unknown,
  TDatabase extends AnyDatabase = AnyDatabase,
>(
  functionName: string,
): UseFunctionResult<TResponse> {
  const client = useSupatype<TDatabase>()
  const [data, setData] = useState<TResponse | null>(null)
  const [error, setError] = useState<SupatypeError | null>(null)
  const [loading, setLoading] = useState(false)

  const invoke = useCallback(
    async (
      body?: unknown,
      options?: FunctionCallOptions | undefined,
    ) => {
      setLoading(true)
      setError(null)

      const result = await client.functions.invoke<TResponse>(functionName, {
        ...options,
        ...(body !== undefined ? { body } : {}),
      })

      setLoading(false)
      setData(result.data)
      if (result.error !== null) setError(result.error)
      return result
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, functionName],
  )

  return { invoke, data, error, loading }
}
