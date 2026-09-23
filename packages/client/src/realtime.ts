import { asHeadersProvider, bearerToken, type HeadersProvider } from "./query.js"

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
  private readonly getHeaders: HeadersProvider
  private ws: WebSocket | null = null
  private channels = new Map<string, ChannelState>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private baseReconnectDelay = 1000
  /** The token the live socket was opened with, so an auth change can tell whether it still holds. */
  private currentToken: string | undefined
  /**
   * The connect in flight, used as its own identity.
   *
   * A counter was tried first and produced a socket that never came back: abandoning an attempt
   * bumped the counter but left this field set, so the replacement connect returned at the
   * one-at-a-time guard, and the abandoned attempt then bailed on the counter. Nothing was
   * connected and nothing was scheduled. Clearing this field both abandons an attempt and unblocks
   * the next one, so the two cannot disagree.
   */
  private attempt: Promise<void> | null = null

  /**
   * `auth` is either a headers provider or a fixed set of headers: the same pair `QueryBuilder` and
   * `MutationBuilder` accept, normalised by the same helper.
   *
   * The provider is what `createClient` passes, and it is why this takes two shapes. A fixed set of
   * headers is read once at construction, so a socket opened before anybody signed in stayed anon
   * for the life of the page: on a table that is not anon-readable it reported SUBSCRIBED and then
   * delivered nothing, which is indistinguishable from a quiet table.
   */
  constructor(url: string, auth: Record<string, string> | HeadersProvider) {
    // Convert http(s) URL to ws(s) URL
    this.url = url.replace(/^http/, "ws")
    this.getHeaders = asHeadersProvider(auth)
  }

  /** The token this socket should authenticate with, or undefined when there is none. */
  private async resolveToken(): Promise<string | undefined> {
    const token = bearerToken(await this.getHeaders())
    return token === "" ? undefined : token
  }

  /**
   * Re-open the socket if the token it was opened with is no longer the current one.
   *
   * `createClient` calls this on every auth change. Without it the token preference above would
   * still not be enough: every binding subscribes on mount, which is before the user has signed in,
   * so the socket that matters is always one that was opened while signed out.
   */
  async reauthenticate(): Promise<void> {
    if (this.ws === null && this.attempt === null) return
    let token: string | undefined
    try {
      token = await this.resolveToken()
    } catch {
      return
    }
    if (token === this.currentToken) return
    // Passed on rather than resolved a second time, so the socket opens with the token that
    // justified opening it. Resolving twice left `currentToken` describing a token nobody checked.
    this.cycleConnection(token)
  }

  /** Abandon the current socket and immediately open a replacement, keeping every channel. */
  private cycleConnection(token: string | undefined): void {
    this.abandonSocket("reauthenticating")
    for (const state of this.channels.values()) {
      state.subscribed = false
    }
    this.ensureConnection(token)
  }

  /**
   * Drop the socket and any connect in flight, without deciding what happens next.
   *
   * Handlers are detached before closing, because `onclose` schedules a backoff reconnect that
   * would otherwise race whatever the caller does instead.
   */
  private abandonSocket(reason: string): void {
    this.attempt = null
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const old = this.ws
    this.ws = null
    this.currentToken = undefined
    if (old !== null) {
      old.onopen = null
      old.onmessage = null
      old.onclose = null
      old.onerror = null
      old.close(1000, reason)
    }
    this.reconnectAttempts = 0
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

  /**
   * Disconnect the WebSocket entirely.
   *
   * Shares `abandonSocket` with the re-authentication path, which is what stops an explicit
   * disconnect from scheduling its own reconnect: the close handler is detached first. It also
   * cancels a connect still waiting on its token, which would otherwise install a socket after the
   * caller asked for none.
   */
  disconnect(): void {
    this.abandonSocket("client disconnect")
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

  /** True while a socket exists and is usable. */
  private isLive(): boolean {
    if (this.ws === null) return false
    return this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING
  }

  private ensureConnection(token?: string | undefined): void {
    // One connect at a time: resolving the token is asynchronous, so two subscribes in the same
    // tick would otherwise each open a socket and the second would orphan the first.
    if (this.isLive() || this.attempt !== null) return

    let attempt: Promise<void>
    const isCurrent = (): boolean => this.attempt === attempt
    // Started on a microtask so `this.attempt` is assigned before `openSocket` can ask whether it
    // is still the current one. Called directly, the path that already has a token reaches that
    // question with no await in front of it, compares against a handle nobody had stored yet, and
    // abandons itself.
    attempt = Promise.resolve().then(() => this.openSocket(isCurrent, token))
    this.attempt = attempt
    void attempt.finally(() => {
      // Only if it is still ours. An attempt abandoned mid-flight must not clear the handle of the
      // replacement that took its place.
      if (this.attempt === attempt) this.attempt = null
    })
  }

  /**
   * Resolve a token, then open the socket with it.
   *
   * Split out of ensureConnection because the token is asynchronous: the session may have to be
   * refreshed before it is known. `epoch` is read before the await so a socket abandoned in the
   * meantime, by disconnect() or by reauthenticate(), does not install itself afterwards.
   */
  private async openSocket(
    isCurrent: () => boolean,
    known?: string | undefined,
  ): Promise<void> {
    let token = known
    if (token === undefined) {
      try {
        token = await this.resolveToken()
      } catch {
        // A token that cannot be resolved is not a reason to open an unauthenticated socket: the
        // server would accept it and deliver nothing, which reads as a broken table rather than a
        // failed sign-in. Let the backoff try again.
        if (isCurrent() && this.channels.size > 0) this.scheduleReconnect()
        return
      }
    }
    // Abandoned while the token was resolving, by disconnect() or by a re-authentication that has
    // already started its own attempt. Installing this socket now would orphan that one.
    if (!isCurrent()) return

    this.currentToken = token
    const wsUrl = token ? `${this.url}?token=${encodeURIComponent(token)}` : this.url
    const ws = new WebSocket(wsUrl)
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempts = 0
      // Re-subscribe all channels
      for (const state of this.channels.values()) {
        if (!state.subscribed) {
          this.sendSubscribe(state)
        }
      }
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as ServerMessage
        this.handleServerMessage(msg)
      } catch {
        // Ignore unparseable messages
      }
    }

    ws.onclose = () => {
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

    ws.onerror = () => {
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
      // Find which channel this error relates to, broadcast to all as fallback
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
