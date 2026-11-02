import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Local test round 4: native dev's Ctrl+C printed `replication poll error: Error: Connection
 * terminated` with a stack, from a poll that was waiting on its query when the service's own stop
 * ended the connection. A stop is expected; the poll it cuts short says nothing.
 */
const ended = vi.hoisted(() => ({ release: [] as Array<(err: Error) => void> }))

vi.mock("pg", () => {
  class Client {
    on(): void {}
    async connect(): Promise<void> {}
    async query(text: string): Promise<{ rows: unknown[] }> {
      if (text.includes("pg_replication_slots")) return { rows: [{}] }
      // The poll's first query: held until the connection ends, as pg rejects it then.
      return new Promise((_resolve, reject) => void ended.release.push(reject))
    }
    async end(): Promise<void> {
      for (const reject of ended.release.splice(0)) reject(new Error("Connection terminated"))
    }
  }
  return { default: { Client } }
})

const { ReplicationListener } = await import("../src/replication.js")

afterEach(() => vi.restoreAllMocks())

describe("the replication listener's stop", () => {
  it("ends a poll waiting on its query without reporting an error", async () => {
    const errors: unknown[][] = []
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args))
    const listener = new ReplicationListener({
      databaseUrl: "postgres://nobody@127.0.0.1:1/none",
      slotName: "s",
      publicationName: "p",
      pollInterval: 60_000,
    })
    listener.onChange(() => undefined)
    await listener.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await listener.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(errors).toEqual([])
  })
})
