import { createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import type { AnyDatabase, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"

export interface FunctionResult<TResponse> {
  invoke: (body?: unknown) => Promise<{ data: TResponse | null; error: SupatypeError | null }>
  data: Accessor<TResponse | null>
  error: Accessor<SupatypeError | null>
  loading: Accessor<boolean>
}

export function createFunction<
  TResponse = unknown,
  TDatabase extends AnyDatabase = AnyDatabase,
>(
  functionName: string,
): FunctionResult<TResponse> {
  const client = useSupatype<TDatabase>()
  const [data, setData] = createSignal<TResponse | null>(null)
  const [error, setError] = createSignal<SupatypeError | null>(null)
  const [loading, setLoading] = createSignal(false)

  const invoke = async (body?: unknown) => {
    setLoading(true)
    setError(null)

    const result = await client.functions.invoke(functionName, {
      ...(body !== undefined ? { body } : {}),
    })

    setLoading(false)
    setData(() => result.data as TResponse | null)
    if (result.error) setError(result.error)
    return result as { data: TResponse | null; error: SupatypeError | null }
  }

  return { invoke, data, error, loading }
}
