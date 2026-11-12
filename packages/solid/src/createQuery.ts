import { createEffect, createSignal, on, onCleanup, onMount, untrack } from "solid-js"
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
  options?: QueryOptions | Accessor<QueryOptions | undefined> | undefined,
): QueryResult<TRow> {
  const client = useSupatype<TDatabase>()
  const current = (): QueryOptions | undefined => (typeof options === "function" ? options() : options)
  const enabledAtSetup = untrack(current)?.enabled !== false
  const { data, error, loading, read } = latestRows<TRow>(client as AnyClient, table, enabledAtSetup)
  const fetchData = async () => {
    const now = current()
    if (now?.enabled !== false) await read(now)
  }

  onMount(() => {
    void fetchData()
  })

  // 0.9.1 release test (FF25): the options were read once, so a sort, page or filter held in a
  // signal changed nothing. Given as an accessor, the signals it reads are tracked and a change
  // reads again. Deferred, because `onMount` above makes the first read; `on` runs the read
  // untracked, so the signals the read itself touches are not dependencies.
  createEffect(on(current, () => void fetchData(), { defer: true }))

  // Re-run when the signed-in identity changes. See `onIdentityChange` for which changes count,
  // and why the fetch above is not enough on its own.
  onCleanup(onIdentityChange(client.auth, () => void fetchData()))

  return { data, error, loading, refetch: fetchData }
}

/**
 * The signals a query shows, fed by reads of which only the newest may change them.
 *
 * `loading` starts as `firstReadComing`. 0.9.2 release test (N-FF9): it started false, so the
 * render before `onMount` began the read showed `loading: false, data: null`, which an app reads
 * as "done, nothing found".
 */
function latestRows<TRow>(client: AnyClient, table: string, firstReadComing: boolean) {
  const [data, setData] = createSignal<TRow[] | null>(null)
  const [error, setError] = createSignal<SupatypeError | null>(null)
  const [loading, setLoading] = createSignal(firstReadComing)
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
