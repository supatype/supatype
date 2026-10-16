import { writable, type Readable } from "svelte/store"
import type { AugmentedDatabase, AnyClient, AnyDatabase, MutationBuilder, SupatypeError } from "@supatype/client"
import { getSupatypeClient } from "./context.js"

export type MutationOperation = "insert" | "update" | "delete" | "upsert"

type MutationRows = Record<string, unknown> | Record<string, unknown>[]

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
