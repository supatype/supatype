import { createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import type { AugmentedDatabase, AnyClient, AnyDatabase, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"
import { runMutation, type MutationOperation } from "./mutation-request.js"

export type { MutationOperation }

export interface MutationOptions {
  filter?: Record<string, unknown> | undefined
}

export interface MutationResult<TRow> {
  mutate: (
    data?: Record<string, unknown> | Record<string, unknown>[] | undefined,
    options?: MutationOptions | undefined,
  ) => Promise<{ data: TRow[] | null; error: SupatypeError | null }>
  loading: Accessor<boolean>
  error: Accessor<SupatypeError | null>
}

export function createMutation<
  TDatabase extends AnyDatabase = AugmentedDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  operation: MutationOperation,
): MutationResult<TRow> {
  const client = useSupatype<TDatabase>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<SupatypeError | null>(null)

  const mutate = async (
    data?: Record<string, unknown> | Record<string, unknown>[] | undefined,
    options?: MutationOptions | undefined,
  ) => {
    setLoading(true)
    setError(null)

    try {
      const outcome = await runMutation<TRow>(client as AnyClient, table, operation, data, options?.filter)
      const result = { data: outcome.data, error: outcome.error }

      if (result.error) setError(result.error)
      return result
    } catch (e) {
      const err = { message: e instanceof Error ? e.message : "Unknown error" }
      setError(err)
      return { data: null, error: err }
    } finally {
      setLoading(false)
    }
  }

  return { mutate, loading, error }
}
