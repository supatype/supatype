import { writable, type Readable } from "svelte/store"
import type { AugmentedDatabase, AnyClient, AnyDatabase, SupatypeError } from "@supatype/client"
import { getSupatypeClient } from "./context.js"
import { runMutation, type MutationOperation } from "./mutation-request.js"

export type { MutationOperation }

export interface MutationOptions {
  filter?: Record<string, unknown> | undefined
}

export interface MutationStore<TRow> {
  mutate: (
    data?: Record<string, unknown> | Record<string, unknown>[] | undefined,
    options?: MutationOptions | undefined,
  ) => Promise<{ data: TRow[] | null; error: SupatypeError | null }>
  loading: Readable<boolean>
  error: Readable<SupatypeError | null>
}

export function createMutation<
  TDatabase extends AnyDatabase = AugmentedDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  operation: MutationOperation,
): MutationStore<TRow> {
  const client = getSupatypeClient<TDatabase>()
  const loading = writable(false)
  const error = writable<SupatypeError | null>(null)

  const mutate = async (
    data?: Record<string, unknown> | Record<string, unknown>[] | undefined,
    options?: MutationOptions | undefined,
  ) => {
    loading.set(true)
    error.set(null)

    try {
      const outcome = await runMutation<TRow>(client as AnyClient, table, operation, data, options?.filter)
      const result = { data: outcome.data, error: outcome.error }

      if (result.error) error.set(result.error)
      return result
    } catch (e) {
      const err = { message: e instanceof Error ? e.message : "Unknown error" }
      error.set(err)
      return { data: null, error: err }
    } finally {
      loading.set(false)
    }
  }

  return {
    mutate,
    loading: { subscribe: loading.subscribe },
    error: { subscribe: error.subscribe },
  }
}
