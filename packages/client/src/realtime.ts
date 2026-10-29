import { asHeadersProvider, bearerToken, type HeadersProvider } from "./query.js"
import { coerceRecordKinds, type ExactFields } from "./exact-values.js"
import { isArrayOf, isJsonObject, isOneOf, isRecordOf, isShape, isString, nullable, optional, type Guard } from "./json.js"

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

/**
 * Turn the exact columns of one record into the types the generated schema declares.
 *
 * Shared with the REST path rather than reimplemented: `coerceExactKinds` is what turns a bigint
 * string into a native bigint and leaves a numeric as its exact string, so a row read over a
 * subscription and the same row read over REST hold equal values.
 */
function coerceRecord(
  record: Record<string, unknown> | null,
  exact: ExactFields,
): Record<string, unknown> | null {
  if (record === null) return null
  return coerceRecordKinds(record, exact)
}

/**
 * The boundary between a change's records and the row type the caller named for the channel.
 *
 * The frame guard below has already checked each record is a JSON object or null. That an object
 * holds `TRow`'s columns is the caller's claim about the table behind the channel (usually the
 * generated schema's), which nothing on the client can check.
 */
function isCallerRow<TRow>(record: unknown): record is TRow {
  return isJsonObject(record)
}

/** A listener for the channel's row type, registered as one for the plain records the frame holds. */
function forCallerRows<TRow>(callback: RealtimeCallback<TRow>): RealtimeCallback<Record<string, unknown>> {
  return (payload) =>
    callback({
      ...payload,
      new: isCallerRow<TRow>(payload.new) ? payload.new : null,
      old: isCallerRow<TRow>(payload.old) ? payload.old : null,
    })
}

/**
 * The schema and table a channel name implies, when a listener does not say.
 *
 * `schema:table`, or a bare `table` in `public`. The same reading as the server's `parseChannel`
 * fallback, so the two agree on any name; anything after a second colon is not part of either.
 */
function parseChannelName(name: string): { schema: string; table: string } {
  const parts = name.split(":")
  if (parts.length >= 2) return { schema: parts[0]!, table: parts[1]! }
  return { schema: "public", table: name }
}

// ─── Server message types (subset matching @supatype/realtime) ───────────────

interface ServerChangeMessage {
  type: "change"
  channel: string
  event: "INSERT" | "UPDATE" | "DELETE"
  payload: { old: Record<string, unknown> | null; new: Record<string, unknown> | null }
  /**
   * Columns the service carried as exact strings, and the kind each one is.
   *
   * The service reads them from the database's own declared types, so this is authoritative in a
   * way the local registry is not: a project that never generated still gets the right value.
   */
  exactColumns?: ExactFields
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
  /** The channel a refusal is about; an error without one is about the socket. */
  channel?: string
  /** The `ref` of the join this answers. A server that predates refs sends none. */
  ref?: string
}

type ServerMessage = ServerChangeMessage | ServerPresenceMessage | ServerBroadcastMessage | ServerSystemMessage

// Each guard is declared as the interface it checks, so the compiler holds the two to the same shape.
const isRecordOrNull = nullable(isJsonObject)
const isPresenceEntries: Guard<PresenceEntry[]> = isArrayOf(isShape({ user_id: isString }))

const isChangeMessage: Guard<ServerChangeMessage> = isShape({
  type: isOneOf(["change"]),
  channel: isString,
  event: isOneOf(["INSERT", "UPDATE", "DELETE"]),
  payload: isShape({ old: isRecordOrNull, new: isRecordOrNull }),
  exactColumns: optional(isRecordOf(isOneOf(["bigint", "numeric"]))),
  timestamp: isString,
})

const isPresenceMessage: Guard<ServerPresenceMessage> = isShape({
  type: isOneOf(["presence"]),
  channel: isString,
  joins: isPresenceEntries,
  leaves: isPresenceEntries,
})

const isBroadcastMessage: Guard<ServerBroadcastMessage> = isShape({
  type: isOneOf(["broadcast"]),
  channel: isString,
  event: isString,
  payload: isJsonObject,
})

const isSystemMessage: Guard<ServerSystemMessage> = isShape({
  type: isOneOf(["system"]),
  status: isOneOf(["ok", "error"]),
  message: isString,
  channel: optional(isString),
  ref: optional(isString),
})

/** A frame from the realtime service (packages/realtime/src/types.ts) in one of the four shapes. */
function isServerMessage(value: unknown): value is ServerMessage {
  return isChangeMessage(value) || isPresenceMessage(value) || isBroadcastMessage(value) || isSystemMessage(value)
}

/** How the server's acknowledgement of a join begins; the channel name follows. */
const SUBSCRIBED_TO = "subscribed to "

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
  /** The last `ref` a join was sent with. Unique for the life of the client, across sockets. */
  private lastRef = 0

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

  /**
   * Abandon the current socket and immediately open a replacement, keeping every channel.
   *
   * Every channel's join went with the old socket, so each one says it is subscribing again until
   * the replacement acknowledges it. Without this a channel kept reading SUBSCRIBED through the
   * swap, while it had no join anywhere and a change committed in the gap could not arrive.
   */
  private cycleConnection(token: string | undefined): void {
    this.abandonSocket("reauthenticating")
    this.notifyChannels("SUBSCRIBING")
    this.ensureConnection(token)
  }

  /** Tell every channel's status callbacks the same thing. */
  private notifyChannels(status: ChannelStatus): void {
    for (const state of this.channels.values()) notifyHandles(state, status)
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
    // Here rather than at each caller. `disconnect()` left every channel marked subscribed, so a
    // channel that subscribed again afterwards opened a fresh socket and was never re-joined on it.
    this.forgetJoins()
  }

  /**
   * Every join belonged to the socket that just went away; the next one has to make its own.
   *
   * So did everything that socket said about presence. The next join is told who is there all
   * over again, so the members known now leave first: a page counting joins minus leaves would
   * otherwise count each of them twice.
   */
  private forgetJoins(): void {
    for (const state of this.channels.values()) {
      state.subscribed = false
      state.joinSent = false
      state.joined = undefined
      state.joining = undefined
      state.joinRef = undefined
      this.forgetMembers(state)
    }
  }

  private forgetMembers(state: ChannelState): void {
    if (state.members.length === 0) return
    const leaves = state.members
    state.members = []
    for (const handle of state.handles) {
      for (const listener of handle.presenceListeners) listener({ joins: [], leaves })
    }
  }

  /**
   * A handle on the channel `name`, with listeners and a status callback of its own.
   *
   * Handles on one name share the join, since the server knows one subscription per channel per
   * socket, and nothing else. They used to share everything: a second `subscribe()` replaced the
   * first one's status callback, and the first `unsubscribe()` left the channel for both, so two
   * `useSubscription` hooks with one channel name broke each other when either unmounted. The join
   * is now left only when the last handle on the name unsubscribes.
   */
  channel<TRow = Record<string, unknown>>(name: string): ChannelSubscription<TRow> {
    const state = this.getOrCreateChannel(name)
    const handle: ChannelHandle = {
      pgListeners: [],
      presenceListeners: [],
      broadcastListeners: new Map(),
      statusCallback: null,
    }
    state.handles.add(handle)

    const sub: ChannelSubscription<TRow> = {
      on(_event, opts, callback) {
        // Defaults read the channel name the way the server's fallback does. The schema used to
        // default to "public" regardless, and since the frame always carries a schema, a channel
        // named `app:orders` was registered against `public.orders`.
        const named = parseChannelName(name)
        handle.pgListeners.push({
          event: opts.event,
          schema: opts.schema ?? named.schema,
          table: opts.table ?? named.table,
          filter: opts.filter,
          callback: forCallerRows(callback),
        })
        return sub
      },

      onPresence(callback) {
        handle.presenceListeners.push(callback)
        return sub
      },

      onBroadcast(event, callback) {
        const listeners = handle.broadcastListeners.get(event) ?? []
        listeners.push(callback)
        handle.broadcastListeners.set(event, listeners)
        return sub
      },

      subscribe: (callback) => {
        handle.statusCallback = callback ?? null
        // Joining twice is a no-op rather than a second frame, so `from(table).subscribe()` can
        // join on its own and a caller can still call this afterwards just to watch the status.
        // A join already acknowledged will not be acknowledged again, so say so here or the new
        // callback waits for a SUBSCRIBED that is never coming.
        if (state.subscribed) callback?.("SUBSCRIBED")
        this.ensureConnection()
        this.sendSubscribe(state)
        return sub
      },

      unsubscribe: () => {
        // Only the last handle on the name leaves the channel. A handle unsubscribing twice, or
        // after `removeChannel` already removed its channel, has nothing left to leave.
        if (!state.handles.delete(handle)) return
        if (state.handles.size > 0) this.rejoinIfUnheard(state)
        else if (this.channels.get(name) === state) this.removeChannel(name)
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
   *
   * A channel still registered is told CLOSED: its join went with the socket and nothing will
   * reconnect it, so the SUBSCRIBED it last reported is no longer true.
   */
  disconnect(): void {
    this.abandonSocket("client disconnect")
    this.notifyChannels("CLOSED")
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private getOrCreateChannel(name: string): ChannelState {
    let state = this.channels.get(name)
    if (!state) {
      state = {
        name,
        handles: new Set(),
        subscribed: false,
        joinSent: false,
        joined: undefined,
        joining: undefined,
        joinRef: undefined,
        members: [],
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
        const msg = JSON.parse(String(event.data))
        // A frame in no shape this client knows is ignored, as an unknown `type` always was.
        if (isServerMessage(msg)) this.handleServerMessage(msg)
      } catch {
        // Ignore unparseable messages
      }
    }

    ws.onclose = () => {
      this.ws = null
      this.forgetJoins()
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
      this.notifyChannels("TIMED_OUT")
      return
    }

    const delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++

    this.notifyChannels("SUBSCRIBING")

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
    if (msg.status === "ok" && msg.message.startsWith(SUBSCRIBED_TO)) {
      const state = this.answeredJoin(msg.message.slice(SUBSCRIBED_TO.length), msg.ref)
      if (state !== undefined) acknowledgeJoin(state)
    }
    if (msg.status === "error") this.handleRefusal(msg)
  }

  /**
   * The channel whose pending join a reply answers, or undefined when it answers none.
   *
   * A reply carrying a ref answers the join sent with that ref and no other. Read by channel name
   * alone, a join's reply settled whichever join on that name was pending when it arrived, so two
   * joins close together (a rejoin, or a leave and a new join) each took the other's answer. A
   * server that predates refs sends none, and its replies are still read by name.
   */
  private answeredJoin(channel: string, ref: string | undefined): ChannelState | undefined {
    const state = this.channels.get(channel)
    if (state === undefined || ref === undefined) return state
    return state.joinRef === ref ? state : undefined
  }

  /**
   * A refusal names its channel and fails that one alone: one bad filter used to put every healthy
   * channel on the socket into CHANNEL_ERROR. An error naming none, from an older server or about
   * the socket itself, still reaches them all. A named channel this client has since left, or one
   * whose refused join it has since replaced, is told nothing.
   */
  private handleRefusal(msg: ServerSystemMessage): void {
    const affected = msg.channel === undefined ? [...this.channels.values()] : [this.answeredJoin(msg.channel, msg.ref)]
    for (const state of affected) {
      if (state === undefined) continue
      // A refused join registered nothing on the server, so a channel not yet confirmed may
      // join again on this socket. Marked as sent, a retry after authenticating sent nothing.
      if (!state.subscribed) state.joinSent = false
      if (msg.ref !== undefined) state.joinRef = undefined
      notifyHandles(state, "CHANNEL_ERROR")
    }
  }

  private handleChange(msg: ServerChangeMessage): void {
    const state = this.channels.get(msg.channel)
    if (!state) return

    // A bigint column arrives as a string and becomes a native bigint here, and a numeric stays
    // the exact string `@supatype/types` declares for Decimal and Money. The same coercion the
    // REST path uses, so a row read either way holds the same values.
    const exact = msg.exactColumns ?? {}
    const newRecord = coerceRecord(msg.payload.new, exact)
    const oldRecord = coerceRecord(msg.payload.old, exact)

    // The channel is subscribed to the table `sendSubscribe` registered, so a change is that
    // table's and goes only to listeners for it. Schema and table come from there, not from
    // splitting the channel name: a channel named for its purpose told a `chat_message` listener
    // its rows came from a table called `lobby-chat`. A listener for a different table on the same
    // channel is never served by it, rather than handed these rows under its own table's name.
    const subscribed = state.joined
    if (!subscribed) return
    for (const listener of pgListenersOf(state)) {
      if (listener.schema !== subscribed.schema || listener.table !== subscribed.table) continue
      if (listener.event !== "*" && listener.event !== msg.event) continue
      listener.callback({
        eventType: msg.event,
        new: newRecord,
        old: oldRecord,
        schema: subscribed.schema,
        table: subscribed.table,
        commitTimestamp: msg.timestamp,
      })
    }
  }

  private handlePresence(msg: ServerPresenceMessage): void {
    const state = this.channels.get(msg.channel)
    if (!state) return

    state.members = withoutLeaves([...state.members, ...msg.joins], msg.leaves)
    for (const handle of state.handles) {
      for (const listener of handle.presenceListeners) {
        listener({ joins: msg.joins, leaves: msg.leaves })
      }
    }
  }

  private handleBroadcastMsg(msg: ServerBroadcastMessage): void {
    const state = this.channels.get(msg.channel)
    if (!state) return

    for (const handle of state.handles) {
      for (const listener of handle.broadcastListeners.get(msg.event) ?? []) {
        listener(msg.payload)
      }
    }
  }

  private sendSubscribe(state: ChannelState): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (state.joinSent) return
    state.joinSent = true

    const target = joinTargetOf(state)
    state.joining = target
    // A first join's rows are its own from the start. A join sent again on this socket replaces one
    // the server delivers for until it acknowledges this one, so the old target stays until then.
    state.joined ??= target
    state.joinRef = String(++this.lastRef)
    this.sendMessage(subscribeFrame(state.name, target, state.joinRef))
  }

  /**
   * Join `state` again when no listener left on it is for the join it holds.
   *
   * Handles share one join, made for the oldest row listener. When that listener's handle left, the
   * join stayed registered for its table, and every other handle reported SUBSCRIBED and was sent
   * nothing. Joined again in place, without leaving first: the server replaces a channel's
   * subscription on a second join, where leaving would drop the presence this socket tracks there.
   * The server tells the new join who is present all over again, so the members known now leave.
   */
  private rejoinIfUnheard(state: ChannelState): void {
    const held = state.joining ?? state.joined
    if (!state.joinSent || held === undefined) return
    const listeners = pgListenersOf(state)
    if (listeners.length === 0 || listeners.some((listener) => sameJoin(listener, held))) return
    state.subscribed = false
    state.joinSent = false
    this.forgetMembers(state)
    notifyHandles(state, "SUBSCRIBING")
    this.sendSubscribe(state)
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

/** What one `channel(name)` call registered: its own listeners and status callback. */
interface ChannelHandle {
  pgListeners: PgListener[]
  presenceListeners: Array<(event: { joins: PresenceEntry[]; leaves: PresenceEntry[] }) => void>
  broadcastListeners: Map<string, Array<(payload: Record<string, unknown>) => void>>
  statusCallback: ((status: ChannelStatus) => void) | null
}

/** One channel name's join on the socket, shared by every handle on that name. */
interface ChannelState {
  name: string
  /** The handles on this name, oldest first. The channel is left when the last one unsubscribes. */
  handles: Set<ChannelHandle>
  /** The server acknowledged the join on the current socket. */
  subscribed: boolean
  /**
   * A join frame went out on the current socket, acknowledged or not.
   *
   * Separate from `subscribed` because the gap between the two is where a second `subscribe()`
   * used to send a second frame.
   */
  joinSent: boolean
  /**
   * The table the join on the current socket registered, from the row listener first when it was
   * sent, else from the channel name. It, not whichever listener is first now, is what an incoming
   * row belongs to: it stays registered while any listener is for it, and a join sent again in its
   * place takes over only once the server acknowledges it. Undefined before any join on the socket.
   */
  joined: JoinTarget | undefined
  /** The join sent on the current socket and not yet acknowledged. */
  joining: JoinTarget | undefined
  /**
   * The `ref` the join awaiting its reply was sent with, and the only reply that may settle it. A
   * reply carrying any other ref answers a join since replaced or left, and is not this one's.
   */
  joinRef: string | undefined
  /** Who the current socket has said is tracked on this channel, one entry per tracking socket. */
  members: PresenceEntry[]
}

/** What a join registers on the server: the table whose changes it delivers, and which of them. */
type JoinTarget = Pick<PgListener, "schema" | "table" | "event" | "filter">

/**
 * What a join on `state` registers now: its oldest row listener's table, event and filter. With no
 * row listener, the table the channel name gives, read as the server's fallback reads it: the one
 * the server would register for a join that named none.
 */
function joinTargetOf(state: ChannelState): JoinTarget {
  const first = pgListenersOf(state)[0]
  if (first !== undefined) return { schema: first.schema, table: first.table, event: first.event, filter: first.filter }
  return { ...parseChannelName(state.name), event: "*", filter: undefined }
}

/** Whether a listener is for exactly what a join registered. */
function sameJoin(listener: JoinTarget, join: JoinTarget): boolean {
  return listener.schema === join.schema && listener.table === join.table &&
    listener.event === join.event && listener.filter === join.filter
}

/** Every handle's row listeners, oldest handle first: the first of them is what the join registers. */
function pgListenersOf(state: ChannelState): PgListener[] {
  return [...state.handles].flatMap((handle) => handle.pgListeners)
}

/**
 * The frame that joins `channel` for `target`, carrying `ref` for the server to echo on its reply.
 *
 * `table` and `schema` travel with the subscription, rather than being inferred from the channel
 * name at the other end.
 *
 * They were resolved here and then dropped, and the server falls back to reading the channel name
 * as `schema:table`. So a subscription worked only when the channel happened to be named after its
 * table, as `from(table).subscribe()` names its own. Anything else, such as a channel called
 * `lobby-chat` carrying `table: "chat_message"` (which is what `useSubscription` exists to let you
 * write), registered against a table no change can match. The socket reported SUBSCRIBED and
 * delivered nothing, which is indistinguishable from a quiet table.
 */
function subscribeFrame(channel: string, target: JoinTarget, ref: string): Record<string, unknown> {
  return {
    type: "subscribe",
    channel,
    event: target.event,
    table: target.table,
    schema: target.schema,
    filter: filterFrame(target.filter),
    ref,
  }
}

/** A PostgREST filter, `column=eq.value,...`, as the subscribe frame carries it, or undefined for none. */
function filterFrame(filter: string | undefined): Record<string, string> | undefined {
  if (!filter) return undefined
  const parsed: Record<string, string> = {}
  for (const part of filter.split(",")) {
    const eqIdx = part.indexOf("=")
    if (eqIdx > 0) parsed[part.slice(0, eqIdx)] = part.slice(eqIdx + 1)
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined
}

/** The server took the join `state` was waiting on: from now on its rows are that join's. */
function acknowledgeJoin(state: ChannelState): void {
  state.subscribed = true
  if (state.joining !== undefined) state.joined = state.joining
  state.joining = undefined
  state.joinRef = undefined
  notifyHandles(state, "SUBSCRIBED")
}

/** Tell each handle on a channel its status. */
function notifyHandles(state: ChannelState, status: ChannelStatus): void {
  for (const handle of state.handles) handle.statusCallback?.(status)
}

/** `members` with one entry removed per leave: a user on two tabs is two entries and leaves twice. */
function withoutLeaves(members: PresenceEntry[], leaves: PresenceEntry[]): PresenceEntry[] {
  const kept = [...members]
  for (const leave of leaves) {
    const at = kept.findIndex((member) => member.user_id === leave.user_id)
    if (at !== -1) kept.splice(at, 1)
  }
  return kept
}
