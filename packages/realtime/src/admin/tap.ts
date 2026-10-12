import type { WalChange } from "../types.js"
import type { RedactedColumns } from "../field-mask.js"
import type { Refusal } from "../rls.js"

/**
 * The message tap: what the inspector's live stream is fed from.
 *
 * Three rules, because delivery must not notice it:
 *
 * - **Off by default.** With no stream open, the delivery path's whole cost is one boolean check
 *   ({@link Tap.active}) per change, broadcast and presence event.
 * - **Bounded when on.** Each session samples at its own rate and queues at most
 *   {@link SESSION_QUEUE_MAX} items, dropping the oldest and counting what it skipped.
 * - **Never on the delivery path.** Delivery only pushes references. Building a view (masking,
 *   judging as the viewer, serialising) happens in the session's consumer on `setImmediate`, and
 *   nothing on the delivery path awaits it. A consumer that stalls stalls only itself.
 */

export type TapKind = "change" | "broadcast" | "presence"

export const TAP_KINDS: readonly TapKind[] = ["change", "broadcast", "presence"]

/** Most items a session holds before it drops its oldest. */
export const SESSION_QUEUE_MAX = 500

/** How often a session reports what it skipped, at most. */
export const SAMPLED_INTERVAL_MS = 1000

/** Exact-match filters a session was opened with. */
export interface TapFilters {
  channel?: string | undefined
  schema?: string | undefined
  table?: string | undefined
  event?: string | undefined
  kinds: ReadonlySet<TapKind>
}

/** Where a session writes: an SSE response, or a test's fake. */
export interface StreamSink {
  /** False when the sink is full; the session then waits for {@link onDrain}. */
  write(chunk: string): boolean
  onDrain(listener: () => void): void
}

/** One delivery of a change, recorded by reference: the frame and record already built to send. */
export interface DeliveryRef {
  connectionId: string
  channel: string
  frame: string
  visible: WalChange
  redacted: RedactedColumns
}

/** A change withheld from one subscriber, and the drop-log reason why. */
export interface WithheldRef {
  connectionId: string
  channel: string
  refusal: Refusal
}

/** What happened to one WAL change, filled in by the delivery loop. */
export class ChangeRecord {
  readonly deliveries: DeliveryRef[] = []
  readonly withheld: WithheldRef[] = []
  notMatched = 0

  constructor(
    readonly seq: number,
    /** The change as decoded: read only by the consumer, to judge it as a viewer. Never emitted. */
    readonly change: WalChange,
    readonly sessions: readonly TapSession[],
  ) {}

  delivered(ref: DeliveryRef): void {
    this.deliveries.push(ref)
  }

  refused(connectionId: string, channel: string, refusal: Refusal): void {
    this.withheld.push({ connectionId, channel, refusal })
  }

  unmatched(): void {
    this.notMatched++
  }
}

export interface BroadcastSeen {
  channel: string
  event: string
  origin: "client" | "studio"
  senderConnectionId: string | null
  recipients: number
  /** The frame each recipient was sent, or null when nobody was. */
  frame: string | null
  payload: Record<string, unknown>
}

export interface PresenceSeen {
  channel: string
  kind: "join" | "leave"
  userId: string
  recipients: number
}

export type TapItem =
  | { kind: "change"; seq: number; at: string; record: ChangeRecord }
  | { kind: "broadcast"; seq: number; at: string; broadcast: BroadcastSeen }
  | { kind: "presence"; seq: number; at: string; presence: PresenceSeen }

/** Builds the SSE event for one item, or null to send nothing. Runs in the consumer, never in delivery. */
export type TapRenderer = (item: TapItem) => Promise<{ event: string; data: unknown } | null>

export interface TapSessionOptions {
  /** The Studio user the session is for, as the control plane named them. */
  actor: string
  filters: TapFilters
  /** Items per second. */
  rate: number
  sink: StreamSink
  render: TapRenderer
}

/** One SSE frame. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** One open inspector stream. */
export class TapSession {
  readonly actor: string
  readonly filters: TapFilters
  private readonly rate: number
  private readonly sink: StreamSink
  private readonly render: TapRenderer
  private queue: TapItem[] = []
  private tokens: number
  private refilledAt = Date.now()
  private skipped = 0
  private skippedSince: number | null = null
  private scheduled = false
  private draining = false
  private paused = false
  private closed = false
  private readonly sampledTimer: ReturnType<typeof setInterval>
  /** Items dropped because the queue was full, since the session opened. */
  dropped = 0
  /** Set by the tap that holds this session, so closing removes it. */
  onClose: (() => void) | null = null

  constructor(opts: TapSessionOptions) {
    this.actor = opts.actor
    this.filters = opts.filters
    this.rate = opts.rate
    this.sink = opts.sink
    this.render = opts.render
    this.tokens = opts.rate
    this.sampledTimer = setInterval(() => this.reportSkipped(), SAMPLED_INTERVAL_MS)
    this.sampledTimer.unref()
  }

  /** Items waiting for the consumer. */
  get queued(): number {
    return this.queue.length
  }

  /** Whether this session's filters select a change on a table some of `channels` subscribe to. */
  wantsChange(change: WalChange, channels: readonly string[]): boolean {
    const f = this.filters
    if (!f.kinds.has("change")) return false
    if (f.schema !== undefined && f.schema !== change.schema) return false
    if (f.table !== undefined && f.table !== change.table) return false
    if (f.event !== undefined && f.event !== change.event) return false
    return f.channel === undefined || channels.includes(f.channel)
  }

  /** Whether this session's filters select a broadcast or presence event on `channel`. */
  wantsChannelEvent(kind: "broadcast" | "presence", channel: string): boolean {
    const f = this.filters
    if (!f.kinds.has(kind)) return false
    if (f.schema !== undefined || f.table !== undefined || f.event !== undefined) return false
    return f.channel === undefined || f.channel === channel
  }

  /** Take a token for one item, or count it as skipped when the session is at its rate. */
  admit(): boolean {
    const now = Date.now()
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.refilledAt) / 1000) * this.rate)
    this.refilledAt = now
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    this.skip(1)
    return false
  }

  /** Queue an item for the consumer, dropping the oldest when full. Never blocks, never awaits. */
  enqueue(item: TapItem): void {
    if (this.closed) return
    if (this.queue.length >= SESSION_QUEUE_MAX) {
      this.queue.shift()
      this.dropped++
      this.skip(1)
    }
    this.queue.push(item)
    this.schedule()
  }

  /** Write one event now, ahead of the queue: the stream's `ready` and its heartbeats use this. */
  writeEvent(event: string, data: unknown): void {
    this.write(sseFrame(event, data))
  }

  /** An SSE comment, which keeps idle proxies from closing the stream. */
  ping(): void {
    if (!this.paused) this.write(": ping\n\n")
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.queue = []
    clearInterval(this.sampledTimer)
    this.onClose?.()
  }

  private skip(count: number): void {
    this.skipped += count
    this.skippedSince ??= Date.now()
  }

  private reportSkipped(): void {
    if (this.skipped === 0 || this.paused || this.closed) return
    const since = new Date(this.skippedSince ?? Date.now()).toISOString()
    this.write(sseFrame("sampled", { skipped: this.skipped, since }))
    this.skipped = 0
    this.skippedSince = null
  }

  private schedule(): void {
    if (this.scheduled || this.draining || this.paused) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    this.draining = true
    try {
      while (!this.paused && !this.closed) {
        const item = this.queue.shift()
        if (!item) break
        const out = await this.render(item).catch((err: unknown) => {
          console.warn("[realtime] inspector could not render an event:", err instanceof Error ? err.message : err)
          return null
        })
        if (out && !this.closed) this.write(sseFrame(out.event, out.data))
      }
    } finally {
      this.draining = false
    }
  }

  private write(chunk: string): void {
    if (this.closed) return
    if (this.sink.write(chunk)) return
    this.paused = true
    this.sink.onDrain(() => {
      this.paused = false
      this.schedule()
    })
  }
}

/** Every open session, and the delivery path's only way in. */
export class Tap {
  private sessions = new Set<TapSession>()
  private seq = 0

  /** Whether any inspector stream is open. The delivery path checks this and nothing else when off. */
  get active(): boolean {
    return this.sessions.size > 0
  }

  get size(): number {
    return this.sessions.size
  }

  /** Open sessions for one Studio user. */
  sessionsFor(actor: string): number {
    let count = 0
    for (const session of this.sessions) if (session.actor === actor) count++
    return count
  }

  add(session: TapSession): void {
    this.sessions.add(session)
    session.onClose = () => {
      this.sessions.delete(session)
    }
  }

  /** Close every session, at shutdown. */
  closeAll(): void {
    for (const session of [...this.sessions]) session.close()
  }

  /**
   * A record for one change if any session wants it (its filters match and it has a token), or
   * null, in which case nothing more is recorded about this change.
   */
  begin(change: WalChange, channels: readonly string[]): ChangeRecord | null {
    let wanting: TapSession[] | null = null
    for (const session of this.sessions) {
      if (session.wantsChange(change, channels) && session.admit()) (wanting ??= []).push(session)
    }
    return wanting ? new ChangeRecord(++this.seq, change, wanting) : null
  }

  /** Hand a finished record to the sessions that wanted it. */
  end(record: ChangeRecord): void {
    const item: TapItem = { kind: "change", seq: record.seq, at: new Date().toISOString(), record }
    for (const session of record.sessions) session.enqueue(item)
  }

  broadcast(broadcast: BroadcastSeen): void {
    this.channelEvent("broadcast", broadcast.channel, (seq, at) => ({ kind: "broadcast", seq, at, broadcast }))
  }

  presence(presence: PresenceSeen): void {
    this.channelEvent("presence", presence.channel, (seq, at) => ({ kind: "presence", seq, at, presence }))
  }

  private channelEvent(kind: "broadcast" | "presence", channel: string, make: (seq: number, at: string) => TapItem): void {
    let item: TapItem | null = null
    for (const session of this.sessions) {
      if (!session.wantsChannelEvent(kind, channel) || !session.admit()) continue
      item ??= make(++this.seq, new Date().toISOString())
      session.enqueue(item)
    }
  }
}
