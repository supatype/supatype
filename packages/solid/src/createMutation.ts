import { createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import type { AugmentedDatabase, AnyClient, AnyDatabase, MutationBuilder, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"

type MutationRows = Record<string, unknown> | Record<string, unknown>[]

export type MutationOperation = "insert" | "update" | "delete" | "upsert"

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
