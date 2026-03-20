import { createSignal } from "solid-js"
import type { Accessor } from "solid-js"
import type { AnyDatabase, SupatypeError } from "@supatype/client"
import { useSupatype } from "./context.js"

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
  TDatabase extends AnyDatabase = AnyDatabase,
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tableClient = client.from(table) as any
      let result: { data: TRow[] | null; error: SupatypeError | null }

      if (operation === "insert") {
        result = await tableClient.insert(data)
      } else if (operation === "upsert") {
        result = await tableClient.upsert(data)
      } else if (operation === "update") {
        let q = tableClient.update(data)
        if (options?.filter) {
          for (const [col, val] of Object.entries(options.filter)) {
            q = q.eq(col, val)
          }
        }
        result = await q
      } else {
        let q = tableClient.delete()
        if (options?.filter) {
          for (const [col, val] of Object.entries(options.filter)) {
            q = q.eq(col, val)
          }
        }
        result = await q
      }

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
