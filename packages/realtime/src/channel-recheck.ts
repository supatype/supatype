import type { RecheckScope } from "./channel-guard.js"

/** When held channels are judged again, apart from a new token (which the server handles itself). */
export interface RecheckSchedule {
  /** The backstop: every held channel, this often. */
  intervalMs: number
  /** How long changes to a table a rule reads are gathered into one re-check. */
  debounceMs: number
  /** Judge the channels in `scope` of every socket that holds any. */
  run: (scope: RecheckScope) => Promise<void>
  /** Told when a run fails, so it is logged and the next one still happens. */
  onError: (err: unknown) => void
}

/**
 * Two reasons to re-check held channels (P5, P15).
 *
 * A change to a table a channel's rules read: collected for `debounceMs` and judged once, so a busy
 * table costs one re-check a second at most, however many rows change in it. And a backstop timer
 * for everything else, since a rule can depend on more than a table change reveals (the time, say)
 * and must not be trusted to stay true for the life of a socket.
 */
export class ChannelRechecker {
  private interval: ReturnType<typeof setInterval> | null = null
  private pending: ReturnType<typeof setTimeout> | null = null
  private readonly dirty = new Set<string>()
  private stopped = false
  /** Counts runs that have begun, so a join can tell whether one started while it was being decided. */
  private runs = 0

  constructor(private readonly schedule: RecheckSchedule) {}

  start(): void {
    this.stopped = false
    this.interval = setInterval(() => void this.execute({ kind: "all" }), this.schedule.intervalMs)
    this.interval.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.interval !== null) clearInterval(this.interval)
    if (this.pending !== null) clearTimeout(this.pending)
    this.interval = null
    this.pending = null
    this.dirty.clear()
  }

  /** How many runs have begun. */
  get epoch(): number {
    return this.runs
  }

  /** Note that the rules of `declarations` may now answer differently; they are re-checked shortly. */
  markDirty(declarations: Iterable<string>): void {
    if (this.stopped) return
    for (const name of declarations) this.dirty.add(name)
    if (this.pending !== null) return
    this.pending = setTimeout(() => {
      this.pending = null
      const names = new Set(this.dirty)
      this.dirty.clear()
      void this.execute({ kind: "declarations", names })
    }, this.schedule.debounceMs)
    this.pending.unref()
  }

  /** Re-check now, for a schema push: the rules themselves may have changed. */
  runNow(scope: RecheckScope): Promise<void> {
    return this.execute(scope)
  }

  private async execute(scope: RecheckScope): Promise<void> {
    if (this.stopped) return
    this.runs++
    try {
      await this.schedule.run(scope)
    } catch (err) {
      this.schedule.onError(err)
    }
  }
}
