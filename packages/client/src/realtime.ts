import { asHeadersProvider, bearerToken, type HeadersProvider } from "./query.js"
import { settle, type Deferred } from "./runtime-env.js"
import type { ChannelName } from "./types.js"
import { coerceRecordKinds, knownExactKinds, type ExactFields } from "./exact-values.js"
import {
  PRIVATE_CHANNELS_FEATURE,
  channelRefusal,
  classifyRefusal,
  isActionRefusal,
  unsupportedServer,
  type ChannelActionRefusal,
} from "./realtime-refusals.js"
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

/**
 * The socket itself, as opposed to any one channel's join on it.
 *
 * "connected": the socket is open. "connecting": it is opening for the first time, reopening after
 * a drop or a sign-in swap, or waiting out a backoff. "disconnected": nothing is open and nothing
 * is scheduled, because no channel has subscribed, disconnect() was called, or every retry failed.
 */
export type RealtimeConnectionState = "connected" | "connecting" | "disconnected"

/** Called each time the connection state changes, with the new state. */
export type RealtimeConnectionListener = (state: RealtimeConnectionState) => void

/**
 * Told each status a channel reaches. `err` carries the server's reason with a CHANNEL_ERROR it
 * refused, such as a join for a table that does not exist, and is undefined otherwise: the same
 * `(status, err)` shape Supabase's client uses, so a callback taking only the status is unaffected.
 */
export type ChannelStatusCallback = (status: ChannelStatus, err?: Error | undefined) => void

/** What a channel can be opened with. */
export interface ChannelOptions {
  /**
   * Assert that this channel is private: guarded by a `Channel` declaration in the schema.
   *
   * The server enforces every declared channel whether or not this is set, so it never loosens
   * anything. What it adds is two refusals instead of two silent open channels. A name no
   * declaration matches is refused (`RealtimeChannelError` reason `not_declared`), which catches a
   * typo at once. And a server that does not announce private channel support is not asked at all
   * (reason `unsupported_server`), since an older server would ignore the flag and admit an open
   * channel. Both arrive as `CHANNEL_ERROR` on the status callback.
   *
   * Handles on one channel name share one join: if any handle says `private: true`, the join does.
   */
  private?: boolean | undefined
}

export interface ChannelSubscription<TRow> {
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
  /**
   * Listen for a broadcast, presence track or payload the server refused on this channel (a
   * `ChannelActionRefusal`: `send_denied`, `track_denied` or `payload_refused`). The channel is
   * still joined, so its status does not change; this is where the app learns its send went nowhere.
   */
  onRefused(callback: (refusal: ChannelActionRefusal) => void): ChannelSubscription<TRow>
  /** Subscribe to the channel, opening the WebSocket if needed. */
  subscribe(callback?: ChannelStatusCallback | undefined): ChannelSubscription<TRow>
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

/**
 * The schema and table a listener on channel `name` is for.
 *
 * The name is read as `schema:table` only when it supplies the table as well. A listener that
 * names its table and no schema means `public`, as the docs say. 0.9.1 release test (RB4): the
 * schema was taken from the name whatever the listener said, so the documented
 * `channel("post:42").on(..., { table: "comment" })` joined `post.comment`, reported SUBSCRIBED
 * and delivered nothing. The server's `resolveTarget` reads a frame the same way.
 */
function listenerTarget(
  name: string,
  opts: { schema?: string | undefined; table?: string | undefined },
): { schema: string; table: string } {
  if (opts.table === undefined) {
    const named = parseChannelName(name)
    return { schema: opts.schema ?? named.schema, table: named.table }
  }
  return { schema: opts.schema ?? "public", table: opts.table }
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
   *
   * The kind is any string: one this client does not know is ignored, and that column passes through
   * as sent, so a kind added later never drops a change.
   */
  exactColumns?: Readonly<Record<string, string>>
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
  /** Why, as a fixed code (packages/realtime `refusal-codes.ts`). A server that predates codes sends none. */
  code?: string
  /** The `ref` of the join this answers. A server that predates refs sends none. */
  ref?: string
  /** What the server can do beyond the base protocol, on the first frame of a socket. */
  features?: string[]
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
  exactColumns: optional(isRecordOf(isString)),
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
  code: optional(isString),
  ref: optional(isString),
  features: optional(isArrayOf(isString)),
})

/** A frame from the realtime service (packages/realtime/src/types.ts) in one of the four shapes. */
function isServerMessage(value: unknown): value is ServerMessage {
  return isChangeMessage(value) || isPresenceMessage(value) || isBroadcastMessage(value) || isSystemMessage(value)
}

/** How the server's acknowledgement of a join begins; the channel name follows. */
const SUBSCRIBED_TO = "subscribed to "

/** The longest wait between reconnect attempts. Without it ten doublings from one second reach 512 s. */
const MAX_RECONNECT_DELAY_MS = 30_000

/**
 * How long a socket may stay CONNECTING. One opened while realtime restarts behind the gateway can
 * stay there with no error and no close, and the client would wait on it for good.
 */
const CONNECT_TIMEOUT_MS = 10_000

// ─── Realtime client ─────────────────────────────────────────────────────────

export class RealtimeClient {
  private readonly base: Deferred<string>
  private readonly getHeaders: HeadersProvider
  private ws: WebSocket | null = null
  private channels = new Map<string, ChannelState>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private baseReconnectDelay = 1000
  private connection: RealtimeConnectionState = "disconnected"
  private readonly connectionListeners = new Set<RealtimeConnectionListener>()
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
   * What the server on the live socket announced on its first frame: undefined until that frame
   * arrives, an empty set for a server that announces nothing (one that predates private channels).
   */
  private serverFeatures: ReadonlySet<string> | undefined

  /**
   * `auth` is either a headers provider or a fixed set of headers: the same pair `QueryBuilder` and
   * `MutationBuilder` accept, normalised by the same helper.
   *
   * The provider is what `createClient` passes, and it is why this takes two shapes. A fixed set of
   * headers is read once at construction, so a socket opened before anybody signed in stayed anon
   * for the life of the page: on a table that is not anon-readable it reported SUBSCRIBED and then
   * delivered nothing, which is indistinguishable from a quiet table.
   */
  constructor(url: Deferred<string>, auth: Record<string, string> | HeadersProvider) {
    this.base = url
    this.getHeaders = asHeadersProvider(auth)
  }

  /** The socket's own state. A channel's status cannot say this: it reads SUBSCRIBING for a drop and a first connect alike. */
  get connectionState(): RealtimeConnectionState {
    return this.connection
  }

  /** True while the socket is open. A channel may still be waiting on its join. */
  get isConnected(): boolean {
    return this.connection === "connected"
  }

  /**
   * Call `listener` each time the connection state changes. It is not called with the current state
   * on registering: read `connectionState` or `isConnected` for that. Returns a function that stops it.
   */
  onConnectionChange(listener: RealtimeConnectionListener): () => void {
    this.connectionListeners.add(listener)
    return () => {
      this.connectionListeners.delete(listener)
    }
  }

  private setConnection(next: RealtimeConnectionState): void {
    if (this.connection === next) return
    this.connection = next
    for (const listener of [...this.connectionListeners]) {
      try {
        listener(next)
      } catch {
        // One listener's bug must not stop the others hearing, or stop the socket doing its work.
      }
    }
  }

  /** The socket's address, as ws(s) for an http(s) one. Read when connecting, not before. */
  private get url(): string {
    return settle(this.base).replace(/^http/, "ws")
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
    this.serverFeatures = undefined
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
      state.joinedPrivate = false
      forgetMembers(state)
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
  channel<TRow = Record<string, unknown>>(name: ChannelName, opts: ChannelOptions = {}): ChannelSubscription<TRow> {
    const state = this.getOrCreateChannel(name)
    const handle: ChannelHandle = {
      pgListeners: [],
      presenceListeners: [],
      broadcastListeners: new Map(),
      refusalListeners: [],
      statusCallback: null,
      private: opts.private === true,
    }
    state.handles.add(handle)

    const sub: ChannelSubscription<TRow> = {
      on: (_event, opts, callback) => {
        // A channel named `app:orders` with no table on the listener is `app.orders`, the way the
        // server's fallback reads it; a listener naming its table defaults to `public`.
        handle.pgListeners.push({
          event: opts.event,
          ...listenerTarget(name, opts),
          filter: opts.filter,
          callback: forCallerRows(callback),
        })
        // A join already sent for broadcast or presence alone delivers no rows, and `subscribe()`
        // will not send another, so the first row listener on it joins again here.
        this.rejoinIfUnheard(state)
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

      onRefused(callback) {
        handle.refusalListeners.push(callback)
        return sub
      },

      subscribe: (callback) => {
        handle.statusCallback = callback ?? null
        // Joining twice is a no-op rather than a second frame, so `from(table).subscribe()` can
        // join on its own and a caller can still call this afterwards just to watch the status.
        // A join already acknowledged will not be acknowledged again, so say so here or the new
        // callback waits for a SUBSCRIBED that is never coming.
        if (state.subscribed && serves(state.joined, handle)) callback?.("SUBSCRIBED")
        // An app subscribing again after a withdrawal is asking to try the join again.
        if (state.withdrawn) {
          state.withdrawn = false
          state.joinSent = false
        }
        this.rejoinForPrivacy(state)
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
    this.setConnection("disconnected")
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
        joinedPrivate: false,
        withdrawn: false,
        unsupported: false,
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
    // Read here, synchronously, so a client with no address or anon key throws from the subscribe
    // that asked for the socket rather than from a background attempt nobody is waiting on.
    const url = this.url
    this.setConnection("connecting")

    let attempt: Promise<void>
    const isCurrent = (): boolean => this.attempt === attempt
    // Started on a microtask so `this.attempt` is assigned before `openSocket` can ask whether it
    // is still the current one. Called directly, the path that already has a token reaches that
    // question with no await in front of it, compares against a handle nobody had stored yet, and
    // abandons itself.
    attempt = Promise.resolve().then(() => this.openSocket(url, isCurrent, token))
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
    url: string,
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
    this.serverFeatures = undefined
    const wsUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url
    const ws = new WebSocket(wsUrl)
    this.ws = ws
    const handshake = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) this.socketLost(ws)
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      clearTimeout(handshake)
      this.reconnectAttempts = 0
      this.setConnection("connected")
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

    ws.onclose = () => this.socketLost(ws)

    ws.onerror = () => {
      // An open socket's error is followed by its close. One that never opened may not be: Node's
      // built-in WebSocket, refused by a gateway answering 502, fires error and then nothing, and
      // counted as live it was never replaced. So that one is dropped here.
      if (ws.readyState !== WebSocket.OPEN) this.socketLost(ws)
    }
  }

  /** `ws` closed or failed to open: forget it and reconnect with backoff, once per socket. */
  private socketLost(ws: WebSocket): void {
    if (this.ws !== ws) return
    ws.onclose = null
    ws.onerror = null
    if (ws.readyState !== WebSocket.CLOSED) ws.close()
    this.ws = null
    this.forgetJoins()
    if (this.channels.size > 0) {
      this.scheduleReconnect()
    } else {
      this.setConnection("disconnected")
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setConnection("disconnected")
      this.notifyChannels("TIMED_OUT")
      return
    }

    const delay = Math.min(MAX_RECONNECT_DELAY_MS, this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts))
    this.reconnectAttempts++
    this.setConnection("connecting")

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
    if (this.serverFeatures === undefined && msg.status === "ok" && !msg.message.startsWith(SUBSCRIBED_TO)) {
      this.serverFeatures = new Set(msg.features ?? [])
      this.joinWaitingChannels()
    }
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
    const kind = msg.channel === undefined ? undefined : classifyRefusal(msg.code, msg.message)
    // A refused send is not a failed channel: it goes to `onRefused` and the status stays as it was.
    if (msg.channel !== undefined && kind !== undefined && isActionRefusal(kind)) {
      refuseAction(this.channels.get(msg.channel), { channel: msg.channel, code: kind, message: msg.message })
      return
    }
    const affected = msg.channel === undefined ? [...this.channels.values()] : [this.answeredJoin(msg.channel, msg.ref)]
    for (const state of affected) {
      if (state === undefined) continue
      const refusal =
        msg.channel === undefined || kind === undefined
          ? new Error(msg.message)
          : channelRefusal(msg.channel, msg.message, kind)
      if (msg.channel !== undefined && state.subscribed) {
        if (kind === "withdrawn") withdrawJoin(state, refusal)
        else refuseRejoin(state, refusal)
        continue
      }
      // A refused join registered nothing on the server, so a channel not yet confirmed may
      // join again on this socket. Marked as sent, a retry after authenticating sent nothing.
      if (!state.subscribed) state.joinSent = false
      if (msg.ref !== undefined) state.joinRef = undefined
      // The server's reason goes to the callback (N-FF5): "table public.notes does not exist"
      // tells the developer what to fix, and a bare CHANNEL_ERROR did not.
      notifyHandles(state, "CHANNEL_ERROR", refusal)
    }
  }

  private handleChange(msg: ServerChangeMessage): void {
    const state = this.channels.get(msg.channel)
    if (!state) return

    // A bigint column arrives as a string and becomes a native bigint here, and a numeric stays
    // the exact string `@supatype/types` declares for Decimal and Money. The same coercion the
    // REST path uses, so a row read either way holds the same values.
    const exact = knownExactKinds(msg.exactColumns ?? {})
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
    const asPrivate = isPrivate(state)
    if (asPrivate && !this.mayJoinPrivately(state)) return
    state.joinSent = true
    state.joinedPrivate = asPrivate

    const target = joinTargetOf(state)
    state.joining = target
    // A first join's rows are its own from the start. A join sent again on this socket replaces one
    // the server delivers for until it acknowledges this one, so the old target stays until then.
    state.joined ??= target
    state.joinRef = String(++this.lastRef)
    this.sendMessage(subscribeFrame(state.name, target, state.joinRef, asPrivate))
  }

  /**
   * Whether a private join may be sent on this socket now.
   *
   * Not before the server's first frame says what it can do: the join waits for it. And not at all
   * to a server that does not announce `private_channels`: it would ignore the flag and admit an
   * open channel, so the join is failed here instead and never sent.
   */
  private mayJoinPrivately(state: ChannelState): boolean {
    if (this.serverFeatures === undefined) return false
    if (this.serverFeatures.has(PRIVATE_CHANNELS_FEATURE)) return true
    if (!state.unsupported) {
      state.unsupported = true
      notifyHandles(state, "CHANNEL_ERROR", unsupportedServer(state.name))
    }
    return false
  }

  /** The server's first frame has arrived: send the joins that were waiting for it. */
  private joinWaitingChannels(): void {
    for (const state of this.channels.values()) {
      state.unsupported = false
      if (!state.subscribed) this.sendSubscribe(state)
    }
  }

  /**
   * A handle asking for `private: true` on a name already joined as open joins again as private,
   * in place, as `rejoinIfUnheard` does: the open join stands until the server takes the new one.
   */
  private rejoinForPrivacy(state: ChannelState): void {
    if (state.joinSent && !state.joinedPrivate && isPrivate(state)) {
      state.joinSent = false
      if (state.subscribed) notifyUnserved(state, "SUBSCRIBING")
    }
  }

  /**
   * Join `state` again when the join it holds delivers rows to no listener left on it.
   *
   * Handles share one join, made for the oldest row listener. When that listener's handle left, the
   * join stayed registered for its table, and every other handle reported SUBSCRIBED and was sent
   * nothing. A join sent before any row listener asked for no rows, so a row listener added after it
   * was never sent any either (0.9.2 release test, FF-1). Joined again in place, without leaving
   * first: the server replaces a channel's subscription on a second join, where leaving would drop
   * the presence this socket tracks there.
   *
   * An acknowledged join stays registered and serving until the server takes this one, and for good
   * if it refuses it. So the handles it serves stay SUBSCRIBED and its members stay present, and
   * only a handle it does not serve is told SUBSCRIBING. Every handle used to be, and a refused
   * rejoin then left them all in CHANNEL_ERROR with broadcast still arriving (0.9.2 round 4, S-1).
   */
  private rejoinIfUnheard(state: ChannelState): void {
    const held = state.joining ?? state.joined
    if (!state.joinSent || held === undefined) return
    const listeners = pgListenersOf(state)
    if (listeners.length === 0) return
    if (held.rows && listeners.some((listener) => sameJoin(listener, held))) return
    state.joinSent = false
    if (state.subscribed) notifyUnserved(state, "SUBSCRIBING")
    else notifyHandles(state, "SUBSCRIBING")
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
  refusalListeners: Array<(refusal: ChannelActionRefusal) => void>
  statusCallback: ChannelStatusCallback | null
  /** Whether this handle asked for `private: true`. */
  private: boolean
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
  /** The join sent on the current socket asked for `private: true`. */
  joinedPrivate: boolean
  /** The server took this channel back, and the client does not join it again until the app asks. */
  withdrawn: boolean
  /** The channel's private join was failed on this socket for want of server support. */
  unsupported: boolean
  /** Who the current socket has said is tracked on this channel, one entry per tracking socket. */
  members: PresenceEntry[]
}

/** The table, event and filter a row listener is for. */
type RowTarget = Pick<PgListener, "schema" | "table" | "event" | "filter">

/**
 * What a join registers on the server: the table whose changes it delivers, and which of them.
 * `rows` is whether it asked for them at all: a join for broadcast and presence alone is sent none.
 */
interface JoinTarget extends RowTarget {
  rows: boolean
}

/**
 * What a join on `state` registers now: its oldest row listener's table, event and filter. With no
 * row listener, the table the channel name gives, read as the server's fallback reads it: the one
 * the server would register for a join that named none.
 */
function joinTargetOf(state: ChannelState): JoinTarget {
  const first = pgListenersOf(state)[0]
  if (first !== undefined) {
    return { schema: first.schema, table: first.table, event: first.event, filter: first.filter, rows: true }
  }
  return { ...parseChannelName(state.name), event: "*", filter: undefined, rows: false }
}

/** Whether a listener is for exactly what a join registered. */
function sameJoin(listener: RowTarget, join: RowTarget): boolean {
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
 *
 * `changes` says whether the join has a row listener. Only a row join has its table checked and is
 * sent row changes: broadcast and presence on `room:x` were refused as a join for room.x (R2-RB2).
 */
function subscribeFrame(channel: string, target: JoinTarget, ref: string, asPrivate: boolean): Record<string, unknown> {
  return {
    type: "subscribe",
    channel,
    event: target.event,
    table: target.table,
    schema: target.schema,
    changes: target.rows,
    filter: filterFrame(target.filter),
    ...(asPrivate && { private: true }),
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

/**
 * The server took the join `state` was waiting on: from now on its rows are that join's.
 *
 * Over a join it had acknowledged, the server tells the new join who is present all over again,
 * straight after this reply, so the members known now leave first. The handles the old join served
 * were never told otherwise than SUBSCRIBED, so only the others are told it now.
 */
function acknowledgeJoin(state: ChannelState): void {
  const replaced = state.subscribed
  if (replaced) {
    forgetMembers(state)
    notifyUnserved(state, "SUBSCRIBED")
  }
  state.subscribed = true
  if (state.joining !== undefined) state.joined = state.joining
  state.joining = undefined
  state.joinRef = undefined
  if (!replaced) notifyHandles(state, "SUBSCRIBED")
}

/**
 * The server refused a rejoin, so the acknowledged join it was to replace still stands, and stays
 * the one this socket holds. Only a handle with a row listener it does not serve gets the refusal.
 */
function refuseRejoin(state: ChannelState, refusal: Error): void {
  state.joinSent = true
  state.joining = undefined
  state.joinRef = undefined
  notifyUnserved(state, "CHANNEL_ERROR", refusal)
}

/**
 * Whether `join` delivers rows to every row listener of `handle`, as `handleChange` routes them: by
 * the join's table. Always, for a handle listening for none.
 */
function serves(join: JoinTarget | undefined, handle: ChannelHandle): boolean {
  return handle.pgListeners.every(
    (listener) => join?.rows === true && listener.schema === join.schema && listener.table === join.table,
  )
}

/** Whether any handle on the channel asked for `private: true`: the shared join then does. */
function isPrivate(state: ChannelState): boolean {
  for (const handle of state.handles) if (handle.private) return true
  return false
}

/**
 * The server removed this client from a channel it held: the token changed, a re-check ran, or the
 * declaration went. Every handle is told, and the client does not join again by itself, since the
 * server would refuse it again. The app joins again by subscribing again.
 */
function withdrawJoin(state: ChannelState, refusal: Error): void {
  state.subscribed = false
  state.joinSent = true
  state.withdrawn = true
  state.joined = undefined
  state.joining = undefined
  state.joinRef = undefined
  state.joinedPrivate = false
  forgetMembers(state)
  notifyHandles(state, "CHANNEL_ERROR", refusal)
}

/** Hand a refused send, track or payload to the `onRefused` listeners of every handle on the channel. */
function refuseAction(state: ChannelState | undefined, refusal: ChannelActionRefusal): void {
  if (state === undefined) return
  for (const handle of state.handles) {
    for (const listener of handle.refusalListeners) listener(refusal)
  }
}

/** Tell each handle on a channel its status. */
function notifyHandles(state: ChannelState, status: ChannelStatus, err?: Error | undefined): void {
  for (const handle of state.handles) handle.statusCallback?.(status, err)
}

/** Tell its status to each handle the join `state` holds does not serve. */
function notifyUnserved(state: ChannelState, status: ChannelStatus, err?: Error | undefined): void {
  for (const handle of state.handles) {
    if (!serves(state.joined, handle)) handle.statusCallback?.(status, err)
  }
}

/** Every member this socket was told of leaves, as the next join is told them all again. */
function forgetMembers(state: ChannelState): void {
  if (state.members.length === 0) return
  const leaves = state.members
  state.members = []
  for (const handle of state.handles) {
    for (const listener of handle.presenceListeners) listener({ joins: [], leaves })
  }
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
