import { onDestroy } from "svelte"
import { writable, type Readable } from "svelte/store"
import type { AugmentedDatabase, AnyClient, AnyDatabase, SupatypeError } from "@supatype/client"
import { onIdentityChange } from "@supatype/client"
import { getSupatypeClient } from "./context.js"
import { latestRowsReader } from "@supatype/client/bindings"

export interface QueryOptions {
  columns?: string | undefined
  filter?: Record<string, unknown> | undefined
  order?: { column: string; ascending?: boolean } | undefined
  limit?: number | undefined
  offset?: number | undefined
  enabled?: boolean | undefined
}

export interface QueryStore<TRow> {
  data: Readable<TRow[] | null>
  error: Readable<SupatypeError | null>
  loading: Readable<boolean>
  refetch: () => Promise<void>
}

export function createQuery<
  TDatabase extends AnyDatabase = AugmentedDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: QueryOptions | undefined,
): QueryStore<TRow> {
  const client = getSupatypeClient<TDatabase>()
  const { data, error, loading, read } = latestRows<TRow>(client as AnyClient, table)
  const fetchData = async () => {
    if (options?.enabled !== false) await read(options)
  }

  // Auto-fetch on creation
  void fetchData()

  // Re-run when the signed-in identity changes. See `onIdentityChange` for which changes count,
  // and why the fetch above is not enough on its own.
  //
  // `onDestroy` is safe here for the same reason `getSupatypeClient()` above is: both need a
  // component's init, and this store is read out of context, so it already had one.
  onDestroy(onIdentityChange(client.auth, () => void fetchData()))

  return {
    data: { subscribe: data.subscribe },
    error: { subscribe: error.subscribe },
    loading: { subscribe: loading.subscribe },
    refetch: fetchData,
  }
}

/** The stores a query shows, fed by reads of which only the newest may change them. */
function latestRows<TRow>(client: AnyClient, table: string) {
  const data = writable<TRow[] | null>(null)
  const error = writable<SupatypeError | null>(null)
  const loading = writable(false)
  const read = latestRowsReader<TRow>(client, table, `createQuery("${table}")`, {
    started: () => {
      loading.set(true)
      error.set(null)
    },
    settled: (rows, refusal) => {
      data.set(rows)
      error.set(refusal)
      loading.set(false)
    },
  })
  return { data, error, loading, read }
}
