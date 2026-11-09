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
  options?: QueryOptions | Readable<QueryOptions | undefined> | undefined,
): QueryStore<TRow> {
  const client = getSupatypeClient<TDatabase>()
  const { data, error, loading, read } = latestRows<TRow>(client as AnyClient, table)
  // The options as last read, and the store they come from when they are one.
  let current: QueryOptions | undefined
  let optionsStore: Readable<QueryOptions | undefined> | undefined
  if (isReadable(options)) optionsStore = options
  else current = options
  const fetchData = async () => {
    if (current?.enabled !== false) await read(current)
  }

  // `onDestroy` is safe here for the same reason `getSupatypeClient()` above is: both need a
  // component's init, and this store is read out of context, so it already had one.
  if (optionsStore !== undefined) {
    // 0.9.1 release test (FF25): the options were read once, so a sort, page or filter held in
    // component state changed nothing. A store calls a new subscriber at once with its value,
    // which is the first read, then again on every change. With runes, `toStore(() => ({ ... }))`
    // from `svelte/store` turns `$state` into one.
    onDestroy(optionsStore.subscribe((next) => {
      current = next
      void fetchData()
    }))
  } else {
    void fetchData()
  }

  // Re-run when the signed-in identity changes. See `onIdentityChange` for which changes count,
  // and why the fetch above is not enough on its own.
  onDestroy(onIdentityChange(client.auth, () => void fetchData()))

  return {
    data: { subscribe: data.subscribe },
    error: { subscribe: error.subscribe },
    loading: { subscribe: loading.subscribe },
    refetch: fetchData,
  }
}

/** Options given as a store, told apart from a plain options object by its `subscribe`. */
function isReadable(
  options: QueryOptions | Readable<QueryOptions | undefined> | undefined,
): options is Readable<QueryOptions | undefined> {
  return options !== undefined && "subscribe" in options && typeof options.subscribe === "function"
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
