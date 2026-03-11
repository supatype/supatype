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

export type ChannelStatus = "SUBSCRIBED" | "SUBSCRIBING" | "CLOSED" | "CHANNEL_ERROR" | "TIMED_OUT"

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
  /** Listen for presence changes. */
  onPresence(
    callback: (event: { joins: PresenceEntry[]; leaves: PresenceEntry[] }) => void,
  ): ChannelSubscription<TRow>
  /** Listen for broadcast events. */
  onBroadcast(
    event: string,
    callback: (payload: Record<string, unknown>) => void,
  ): ChannelSubscription<TRow>
  /** Subscribe to the channel, opening the WebSocket if needed. */
  subscribe(callback?: ((status: ChannelStatus) => void) | undefined): ChannelSubscription<TRow>
  /** Unsubscribe and clean up. */
  unsubscribe(): void
  /** Send a broadcast event to the channel. */
  broadcast(event: string, payload: Record<string, unknown>): void
  /** Track presence in this channel. */
  track(payload: Record<string, unknown>): void
  /** Stop tracking presence. */
  untrack(): void
}

export interface PresenceEntry {
  user_id: string
  [key: string]: unknown
}

// ─── Server message types (subset matching @supatype/realtime) ───────────────

interface ServerChangeMessage {
  type: "change"
  channel: string
  event: "INSERT" | "UPDATE" | "DELETE"
  payload: { old: Record<string, unknown> | null; new: Record<string, unknown> | null }
  timestamp: string
}

interface ServerPresenceMessage {
  type: "presence"
  channel: string
  joins: PresenceEntry[]
  leaves: PresenceEntry[]
}

interface ServerBroadcastMessage {
  type: "broadcast"
  channel: string
  event: string
  payload: Record<string, unknown>
}

interface ServerSystemMessage {
  type: "system"
  status: "ok" | "error"
  message: string
}

type ServerMessage = ServerChangeMessage | ServerPresenceMessage | ServerBroadcastMessage | ServerSystemMessage

// ─── Realtime client ─────────────────────────────────────────────────────────

export class RealtimeClient {
  private readonly url: string
  private readonly headers: Record<string, string>
  private ws: WebSocket | null = null
  private channels = new Map<string, ChannelState>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private baseReconnectDelay = 1000

  constructor(url: string, headers: Record<string, string>) {
    // Convert http(s) URL to ws(s) URL
    this.url = url.replace(/^http/, "ws")
    this.headers = headers
  }

  channel<TRow = Record<string, unknown>>(name: string): ChannelSubscription<TRow> {
    const state = this.getOrCreateChannel(name)

    const sub: ChannelSubscription<TRow> = {
      on(_event, opts, callback) {
        state.pgListeners.push({
          event: opts.event,
          schema: opts.schema ?? "public",
          table: opts.table ?? name.split(":").pop() ?? name,
          filter: opts.filter,
          callback: callback as RealtimeCallback<Record<string, unknown>>,
        })
        return sub
      },

      onPresence(callback) {
        state.presenceListeners.push(callback)
        return sub
      },

      onBroadcast(event, callback) {
        if (!state.broadcastListeners.has(event)) {
          state.broadcastListeners.set(event, [])
        }
        state.broadcastListeners.get(event)!.push(callback)
        return sub
      },

      subscribe: (callback) => {
        state.statusCallback = callback ?? null
        this.ensureConnection()
        this.sendSubscribe(state)
        return sub
      },

      unsubscribe: () => {
        this.sendUnsubscribe(state)
        this.channels.delete(name)
        // Close WebSocket if no channels left
        if (this.channels.size === 0) {
          this.disconnect()
        }
      },

      broadcast: (event, payload) => {
        this.sendMessage({
          type: "broadcast",
          channel: name,
          event,
          payload,
        })
      },

      track: (payload) => {
        this.sendMessage({
          type: "presence_track",
          channel: name,
          payload,
        })
      },

      untrack: () => {
        this.sendMessage({
          type: "presence_untrack",
          channel: name,
        })
      },
    }

    return sub
  }

  /** Remove a channel by name. */
  removeChannel(name: string): void {
    const state = this.channels.get(name)
    if (state) {
      this.sendUnsubscribe(state)
      this.channels.delete(name)
    }
    if (this.channels.size === 0) {
      this.disconnect()
    }
  }

  /** Disconnect the WebSocket entirely. */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close(1000, "client disconnect")
      this.ws = null
    }
    this.reconnectAttempts = 0
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private getOrCreateChannel(name: string): ChannelState {
    let state = this.channels.get(name)
    if (!state) {
      state = {
        name,
        pgListeners: [],
        presenceListeners: [],
        broadcastListeners: new Map(),
        statusCallback: null,
        subscribed: false,
      }
      this.channels.set(name, state)
    }
    return state
  }

  private ensureConnection(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    // Build URL with token from apikey header
    const token = this.headers["apikey"] ?? this.headers["Authorization"]?.replace("Bearer ", "")
    const wsUrl = token ? `${this.url}?token=${encodeURIComponent(token)}` : this.url

    this.ws = new WebSocket(wsUrl)

    this.ws.onopen = () => {
      this.reconnectAttempts = 0
      // Re-subscribe all channels
      for (const state of this.channels.values()) {
        if (!state.subscribed) {
          this.sendSubscribe(state)
        }
      }
    }

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as ServerMessage
        this.handleServerMessage(msg)
      } catch {
        // Ignore unparseable messages
      }
    }

    this.ws.onclose = () => {
      this.ws = null
      // Mark all channels as unsubscribed
      for (const state of this.channels.values()) {
        state.subscribed = false
      }
      // Attempt reconnection with exponential backoff
      if (this.channels.size > 0) {
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = () => {
      // onclose will fire after onerror
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      for (const state of this.channels.values()) {
        state.statusCallback?.("TIMED_OUT")
      }
      return
    }

    const delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++

    for (const state of this.channels.values()) {
      state.statusCallback?.("SUBSCRIBING")
    }

    this.reconnectTimer = setTimeout(() => {
      this.ensureConnection()
    }, delay)
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "system":
        this.handleSystem(msg)
        break
      case "change":
        this.handleChange(msg)
        break
      case "presence":
        this.handlePresence(msg)
        break
      case "broadcast":
        this.handleBroadcastMsg(msg)
        break
    }
  }

  private handleSystem(msg: ServerSystemMessage): void {
    // When server confirms subscription
    if (msg.status === "ok" && msg.message.startsWith("subscribed to ")) {
      const channel = msg.message.replace("subscribed to ", "")
      const state = this.channels.get(channel)
      if (state) {
        state.subscribed = true
        state.statusCallback?.("SUBSCRIBED")
      }
    }

    if (msg.status === "error") {
      // Find which channel this error relates to — broadcast to all as fallback
      for (const state of this.channels.values()) {
        state.statusCallback?.("CHANNEL_ERROR")
      }
    }
  }

  private handleChange(msg: ServerChangeMessage): void {
    const state = this.channels.get(msg.channel)
    if (!state) return

    // Parse channel to get schema/table
    const parts = msg.channel.split(":")
    const schema = parts.length >= 2 ? parts[0]! : "public"
    const table = parts.length >= 2 ? parts[1]! : parts[0]!

    const payload: RealtimePayload<Record<string, unknown>> = {
      eventType: msg.event,
      new: msg.payload.new,
      old: msg.payload.old,
      schema,
      table,
      commitTimestamp: msg.timestamp,
    }

    for (const listener of state.pgListeners) {
      if (listener.event !== "*" && listener.event !== msg.event) continue
      listener.callback(payload)
    }
  }

  private handlePresence(msg: ServerPresenceMessage): void {
    const state = this.channels.get(msg.channel)
    if (!state) return

    for (const listener of state.presenceListeners) {
      listener({ joins: msg.joins, leaves: msg.leaves })
    }
  }

  private handleBroadcastMsg(msg: ServerBroadcastMessage): void {
    const state = this.channels.get(msg.channel)
    if (!state) return

    const listeners = state.broadcastListeners.get(msg.event)
    if (listeners) {
      for (const listener of listeners) {
        listener(msg.payload)
      }
    }
  }

  private sendSubscribe(state: ChannelState): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    // Build filter from the first pg listener (if any)
    const firstListener = state.pgListeners[0]
    const filter: Record<string, string> = {}
    if (firstListener?.filter) {
      // Parse PostgREST filter format "column=eq.value" into { column: "eq.value" }
      for (const part of firstListener.filter.split(",")) {
        const eqIdx = part.indexOf("=")
        if (eqIdx > 0) {
          filter[part.slice(0, eqIdx)] = part.slice(eqIdx + 1)
        }
      }
    }

    this.sendMessage({
      type: "subscribe",
      channel: state.name,
      event: firstListener?.event ?? "*",
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    })
  }

  private sendUnsubscribe(state: ChannelState): void {
    this.sendMessage({ type: "unsubscribe", channel: state.name })
  }

  private sendMessage(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface PgListener {
  event: RealtimeEvent
  schema: string
  table: string
  filter: string | undefined
  callback: RealtimeCallback<Record<string, unknown>>
}

interface ChannelState {
  name: string
  pgListeners: PgListener[]
  presenceListeners: Array<(event: { joins: PresenceEntry[]; leaves: PresenceEntry[] }) => void>
  broadcastListeners: Map<string, Array<(payload: Record<string, unknown>) => void>>
  statusCallback: ((status: ChannelStatus) => void) | null
  subscribed: boolean
}
