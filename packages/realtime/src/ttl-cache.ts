/**
 * A keyed cache whose entries expire, filled on a miss by an async loader.
 *
 * Shared by the catalogs realtime reads (field rules, table shapes) so each has the same
 * invalidation story: cleared when a schema push completes, with the TTL as a backstop for a
 * push that happened while this process was not watching.
 */
export class TtlCache<T> {
  private entries = new Map<string, { value: T; readAt: number }>()

  constructor(private ttlMs: number) {}

  clear(): void {
    this.entries.clear()
  }

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key)
    if (cached && Date.now() - cached.readAt < this.ttlMs) return cached.value
    const value = await load()
    this.entries.set(key, { value, readAt: Date.now() })
    return value
  }
}
