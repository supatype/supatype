import { writable, type Readable } from "svelte/store"
import type { AnyDatabase, SupatypeError } from "@supatype/client"
import { getSupatypeClient } from "./context.js"

export interface FunctionStore<TResponse> {
  invoke: (body?: unknown) => Promise<{ data: TResponse | null; error: SupatypeError | null }>
  data: Readable<TResponse | null>
  error: Readable<SupatypeError | null>
  loading: Readable<boolean>
}

export function createFunction<
  TResponse = unknown,
  TDatabase extends AnyDatabase = AnyDatabase,
>(
  functionName: string,
): FunctionStore<TResponse> {
  const client = getSupatypeClient<TDatabase>()
  const data = writable<TResponse | null>(null)
  const error = writable<SupatypeError | null>(null)
  const loading = writable(false)

  const invoke = async (body?: unknown) => {
    loading.set(true)
    error.set(null)

    const result = await client.functions.invoke<TResponse>(functionName, {
      ...(body !== undefined ? { body } : {}),
    })

    loading.set(false)
    data.set(result.data)
    if (result.error) error.set(result.error)
    return result
  }

  return {
    invoke,
    data: { subscribe: data.subscribe },
    error: { subscribe: error.subscribe },
    loading: { subscribe: loading.subscribe },
  }
}
