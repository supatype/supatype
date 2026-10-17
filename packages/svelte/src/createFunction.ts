import { writable, type Readable } from "svelte/store"
import type { AugmentedDatabase, AnyDatabase, SupatypeError } from "@supatype/client"
import { getSupatypeClient } from "./context.js"
import { isCallerValue } from "./caller-types.js"

export interface FunctionStore<TResponse> {
  invoke: (body?: unknown) => Promise<{ data: TResponse | null; error: SupatypeError | null }>
  data: Readable<TResponse | null>
  error: Readable<SupatypeError | null>
  loading: Readable<boolean>
}

export function createFunction<
  TResponse = unknown,
  TDatabase extends AnyDatabase = AugmentedDatabase,
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

    try {
      const result = await client.functions.invoke(functionName, {
        ...(body !== undefined ? { body } : {}),
      })
      const answer = { data: isCallerValue<TResponse>(result.data) ? result.data : null, error: result.error }
      data.set(answer.data)
      if (answer.error) error.set(answer.error)
      return answer
    } finally {
      loading.set(false)
    }
  }

  return {
    invoke,
    data: { subscribe: data.subscribe },
    error: { subscribe: error.subscribe },
    loading: { subscribe: loading.subscribe },
  }
}
