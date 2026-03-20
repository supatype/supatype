import { createSignal, onMount, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { AnyDatabase, SupatypeError, RealtimePayload, RealtimeEvent, ChannelStatus } from "@supatype/client"
import { useSupatype } from "./context.js"

export interface SubscriptionOptions {
  event?: RealtimeEvent | undefined
  filter?: string | undefined
}

export interface SubscriptionResult<TRow> {
  data: Accessor<TRow[] | null>
  error: Accessor<SupatypeError | null>
  status: Accessor<"connecting" | "connected" | "disconnected" | "error">
}

export function createSubscription<
  TDatabase extends AnyDatabase = AnyDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: SubscriptionOptions | undefined,
): SubscriptionResult<TRow> {
  const client = useSupatype<TDatabase>()
  const [data, setData] = createSignal<TRow[] | null>(null)
  const [error, setError] = createSignal<SupatypeError | null>(null)
  const [status, setStatus] = createSignal<"connecting" | "connected" | "disconnected" | "error">("connecting")

  let channel: ReturnType<typeof client.realtime.channel<TRow>> | null = null

  onMount(() => {
    const event: RealtimeEvent = (options?.event as RealtimeEvent) ?? "*"
    const channelOpts: {
      event: RealtimeEvent
      schema: string
      table: string
      filter?: string | undefined
    } = {
      event,
      schema: "public",
      table,
    }
    if (options?.filter) {
      channelOpts.filter = options.filter
    }

    channel = client.realtime.channel<TRow>(`public:${table}`)

    channel.on("postgres_changes", channelOpts, (payload: RealtimePayload<TRow>) => {
      setData((current) => {
        const rows = current ?? []

        if (payload.eventType === "INSERT") {
          return [...rows, payload.new as TRow]
        } else if (payload.eventType === "UPDATE") {
          return rows.map((row) => {
            const r = row as Record<string, unknown>
            const n = payload.new as Record<string, unknown>
            return r["id"] === n["id"] ? (payload.new as TRow) : row
          })
        } else if (payload.eventType === "DELETE") {
          const old = payload.old as Record<string, unknown>
          return rows.filter((row) => (row as Record<string, unknown>)["id"] !== old["id"])
        }
        return rows
      })
    })

    channel.subscribe((newStatus: ChannelStatus) => {
      if (newStatus === "SUBSCRIBED") {
        setStatus("connected")
      } else if (newStatus === "CHANNEL_ERROR") {
        setStatus("error")
        setError({ message: "Subscription error" })
      } else if (newStatus === "CLOSED") {
        setStatus("disconnected")
      }
    })
  })

  onCleanup(() => {
    channel?.unsubscribe()
  })

  return { data, error, status }
}
