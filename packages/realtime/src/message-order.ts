/**
 * The order one client's frames are handled in: one after another per channel, and channels
 * independently of each other.
 *
 * A join waits on the database (N-FF5, N-S5), and a leave or a broadcast sent right behind it must
 * still find the join where it was, so a channel's frames cannot overtake each other. They used to
 * be one chain per client, which held a broadcast on one channel behind an unrelated join's
 * database checks on another.
 *
 * A frame that names no channel (`auth`) changes what every later frame is judged by, so it is a
 * barrier: it waits for every channel's frames before it, and every frame after it waits for it,
 * which is the order a single chain gave it.
 */
export class MessageOrder {
  private readonly channels = new Map<string, Promise<void>>()
  private barrier: Promise<void> = Promise.resolve()

  constructor(private readonly onError: (err: unknown) => void) {}

  /** Run `task` after every earlier frame on `channel`, or after every earlier frame at all for null. */
  run(channel: string | null, task: () => Promise<void>): void {
    if (channel === null) {
      const earlier = Promise.all([this.barrier, ...this.channels.values()])
      this.channels.clear()
      this.barrier = this.settle(earlier.then(task))
      return
    }
    const next = this.settle((this.channels.get(channel) ?? this.barrier).then(task))
    this.channels.set(channel, next)
    // Forget a channel once its last frame is handled, so a client that touches many channels does
    // not keep one entry for each. A later frame on it starts from the barrier, which is behind it.
    void next.then(() => {
      if (this.channels.get(channel) === next) this.channels.delete(channel)
    })
  }

  private settle(work: Promise<void>): Promise<void> {
    return work.catch(this.onError)
  }
}
