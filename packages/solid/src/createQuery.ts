import { createSignal, onCleanup, onMount } from "solid-js"
import type { Accessor } from "solid-js"
import type { AugmentedDatabase, AnyClient, AnyDatabase, SupatypeError } from "@supatype/client"
import { onIdentityChange } from "@supatype/client"
import { useSupatype } from "./context.js"
import { latestRowsReader } from "@supatype/client/bindings"

export interface QueryOptions {
  columns?: string | undefined
  filter?: Record<string, unknown> | undefined
  order?: { column: string; ascending?: boolean } | undefined
  limit?: number | undefined
  offset?: number | undefined
  enabled?: boolean | undefined
}

export interface QueryResult<TRow> {
  data: Accessor<TRow[] | null>
  error: Accessor<SupatypeError | null>
  loading: Accessor<boolean>
  refetch: () => Promise<void>
}

export function createQuery<
  TDatabase extends AnyDatabase = AugmentedDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: QueryOptions | undefined,
): QueryResult<TRow> {
  const client = useSupatype<TDatabase>()
  const { data, error, loading, read } = latestRows<TRow>(client as AnyClient, table)
  const fetchData = async () => {
    if (options?.enabled !== false) await read(options)
  }

  onMount(() => {
    void fetchData()
  })

  // Re-run when the signed-in identity changes. See `onIdentityChange` for which changes count,
  // and why the fetch above is not enough on its own.
  onCleanup(onIdentityChange(client.auth, () => void fetchData()))

  return { data, error, loading, refetch: fetchData }
}

/** The signals a query shows, fed by reads of which only the newest may change them. */
function latestRows<TRow>(client: AnyClient, table: string) {
  const [data, setData] = createSignal<TRow[] | null>(null)
  const [error, setError] = createSignal<SupatypeError | null>(null)
  const [loading, setLoading] = createSignal(false)
  const read = latestRowsReader<TRow>(client, table, `createQuery("${table}")`, {
    started: () => {
      setLoading(true)
      setError(null)
    },
    settled: (rows, refusal) => {
      setData(() => rows)
      setError(() => refusal)
      setLoading(false)
    },
  })
  return { data, error, loading, read }
}
