import { ref, onMounted, onUnmounted, type Ref } from "vue"
import type { AnyDatabase, SupatypeError, RealtimePayload, RealtimeEvent, ChannelStatus } from "@supatype/client"
import { useSupatype } from "./context.js"

export type SubscriptionEvent = RealtimeEvent

export interface UseSubscriptionOptions {
  event?: SubscriptionEvent | undefined
  filter?: string | undefined
}

export interface UseSubscriptionReturn<TRow> {
  data: Ref<TRow[] | null>
  error: Ref<SupatypeError | null>
  status: Ref<"connecting" | "connected" | "disconnected" | "error">
}

/**
 * Real-time subscription composable.
 *
 * @example
 * ```vue
 * <script setup>
 * import { useSubscription } from '@supatype/vue'
 *
 * const { data: messages, status } = useSubscription('messages', {
 *   event: '*',
 *   filter: 'room_id=eq.123',
 * })
 * </script>
 * ```
 */
export function useSubscription<
  TDatabase extends AnyDatabase = AnyDatabase,
  TTable extends keyof TDatabase["public"]["Tables"] & string = keyof TDatabase["public"]["Tables"] & string,
  TRow = TDatabase["public"]["Tables"][TTable]["Row"],
>(
  table: TTable,
  options?: UseSubscriptionOptions | undefined,
): UseSubscriptionReturn<TRow> {
  const client = useSupatype<TDatabase>()
  const data = ref<TRow[] | null>(null) as Ref<TRow[] | null>
  const error = ref<SupatypeError | null>(null)
  const status = ref<"connecting" | "connected" | "disconnected" | "error">("connecting")

  let unsubscribe: (() => void) | null = null

  onMounted(() => {
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
      if (!data.value) data.value = []

      if (payload.eventType === "INSERT") {
        data.value = [...data.value, payload.new as TRow]
      } else if (payload.eventType === "UPDATE") {
        data.value = data.value.map((row) => {
          const r = row as Record<string, unknown>
          const n = payload.new as Record<string, unknown>
          return r["id"] === n["id"] ? (payload.new as TRow) : row
        })
      } else if (payload.eventType === "DELETE") {
        const old = payload.old as Record<string, unknown>
        data.value = data.value.filter((row) => (row as Record<string, unknown>)["id"] !== old["id"])
      }
    })

    channel.subscribe((newStatus: ChannelStatus) => {
      if (newStatus === "SUBSCRIBED") {
        status.value = "connected"
      } else if (newStatus === "CHANNEL_ERROR") {
        status.value = "error"
        error.value = { message: "Subscription error" }
      } else if (newStatus === "CLOSED") {
        status.value = "disconnected"
      }
    })

    unsubscribe = () => {
      channel.unsubscribe()
    }
  })

  onUnmounted(() => {
    unsubscribe?.()
  })

  return { data, error, status }
}
