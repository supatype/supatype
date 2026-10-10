/**
 * A keyed cache whose entries expire, filled on a miss by an async loader.
 *
 * Shared by the catalogs realtime reads (field rules, table shapes) so each has the same
 * invalidation story: cleared when a schema push completes, with the TTL as a backstop for a
 * push that happened while this process was not watching.
 *
 * The pending load is what is cached, so callers that miss the same key at once (every
 * subscriber judging one change) share a single load instead of each starting their own. A load
 * that fails is forgotten, so the next caller tries again.
 */
export class TtlCache<T> {
  private entries = new Map<string, { value: Promise<T>; readAt: number }>()

  constructor(private ttlMs: number) {}

  clear(): void {
    this.entries.clear()
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key)
    if (cached && Date.now() - cached.readAt < this.ttlMs) return cached.value
    const entry = { value: load(), readAt: Date.now() }
    this.entries.set(key, entry)
    entry.value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
    })
    return entry.value
  }
}
