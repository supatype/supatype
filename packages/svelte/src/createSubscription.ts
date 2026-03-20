import { writable, type Readable } from "svelte/store"
import { onDestroy } from "svelte"
import type { AnyDatabase, SupatypeError, RealtimePayload, RealtimeEvent, ChannelStatus } from "@supatype/client"
import { getSupatypeClient } from "./context.js"

export interface SubscriptionOptions {
  event?: RealtimeEvent | undefined
  filter?: string | undefined
}

export interface SubscriptionStore<TRow> {
  data: Readable<TRow[] | null>
  error: Readable<SupatypeError | null>
  status: Readable<"connecting" | "connected" | "disconnected" | "error">
}

export function createSubscription<
  TDatabase extends AnyDatabase = AnyDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: SubscriptionOptions | undefined,
): SubscriptionStore<TRow> {
  const client = getSupatypeClient<TDatabase>()
  const data = writable<TRow[] | null>(null)
  const error = writable<SupatypeError | null>(null)
  const status = writable<"connecting" | "connected" | "disconnected" | "error">("connecting")

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

  const channel = client.realtime.channel<TRow>(`public:${table}`)

  channel.on("postgres_changes", channelOpts, (payload: RealtimePayload<TRow>) => {
    data.update((current) => {
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
      status.set("connected")
    } else if (newStatus === "CHANNEL_ERROR") {
      status.set("error")
      error.set({ message: "Subscription error" })
    } else if (newStatus === "CLOSED") {
      status.set("disconnected")
    }
  })

  onDestroy(() => {
    channel.unsubscribe()
  })

  return {
    data: { subscribe: data.subscribe },
    error: { subscribe: error.subscribe },
    status: { subscribe: status.subscribe },
  }
}
