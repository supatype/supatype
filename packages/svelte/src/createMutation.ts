import { writable, type Readable } from "svelte/store"
import type { AnyDatabase, SupatypeError } from "@supatype/client"
import { getSupatypeClient } from "./context.js"

export type MutationOperation = "insert" | "update" | "delete" | "upsert"

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
  TDatabase extends AnyDatabase = AnyDatabase,
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
