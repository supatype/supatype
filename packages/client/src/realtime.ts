// Realtime support arrives in Phase 8.
// This stub keeps the client API surface stable.

export type RealtimeEvent = "INSERT" | "UPDATE" | "DELETE" | "*"

export interface RealtimePayload<TRow> {
  eventType: RealtimeEvent
  new: TRow | null
  old: TRow | null
  schema: string
  table: string
  commitTimestamp: string
}

type RealtimeCallback<TRow> = (payload: RealtimePayload<TRow>) => void

interface ChannelSubscription<TRow> {
  on(
    event: "postgres_changes",
    opts: {
      event: RealtimeEvent
      schema?: string | undefined
      table?: string | undefined
      filter?: string | undefined
    },
    callback: RealtimeCallback<TRow>,
  ): ChannelSubscription<TRow>
  subscribe(callback?: ((status: string) => void) | undefined): ChannelSubscription<TRow>
  unsubscribe(): void
}

export class RealtimeClient {
  private readonly url: string
  private readonly headers: Record<string, string>

  constructor(url: string, headers: Record<string, string>) {
    this.url = url
    this.headers = headers
  }

  channel<TRow = Record<string, unknown>>(name: string): ChannelSubscription<TRow> {
    // Stub — will be replaced with a real WebSocket-based implementation in Phase 8
    const _name = name
    const _headers = this.headers
    const _url = this.url
    void _name; void _headers; void _url

    const stub: ChannelSubscription<TRow> = {
      on(_event, _opts, _callback) {
        return stub
      },
      subscribe(_callback) {
        return stub
      },
      unsubscribe() {
        // noop
      },
    }
    return stub
  }
}
