import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * 0.9.1 release test RB8: every read of the slot makes Postgres log `starting logical decoding for
 * slot` and `logical decoding found consistent point`, each with a DETAIL and a STATEMENT line. At
 * one read every 100 ms that was six lines a tenth of a second, about 0.8 GB of log a day from an
 * idle stack. The slot is now read only when the WAL has moved past what it last confirmed.
 *
 * `log_min_messages` cannot do this: Postgres ranks LOG above ERROR for the server log, so the
 * only level that drops these lines is `fatal`, which would drop this connection's errors too.
 */
type SlotState = { behind: boolean | null } | "no slot"

const db = vi.hoisted(() => ({ queries: [] as string[], slot: { behind: false } as SlotState }))

vi.mock("pg", () => {
  class Client {
    on(): void {}
    async connect(): Promise<void> {}
    async query(text: string): Promise<{ rows: unknown[] }> {
      db.queries.push(text)
      if (text.includes("confirmed_flush_lsn")) return { rows: db.slot === "no slot" ? [] : [db.slot] }
      if (text.includes("pg_replication_slots")) return { rows: [{}] }
      return { rows: [] }
    }
    async end(): Promise<void> {}
  }
  return { default: { Client } }
})

const { ReplicationListener } = await import("../src/replication.js")

afterEach(() => {
  db.queries.length = 0
  db.slot = { behind: false }
})

/** Start a listener, let its first poll run, stop it, and count the reads of the slot. */
async function slotReadsInOnePoll(slot: SlotState): Promise<number> {
  db.slot = slot
  db.queries.length = 0
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
  return db.queries.filter((q) => q.includes("pg_logical_slot_get_changes")).length
}

describe("reading the replication slot", () => {
  it("is skipped while the slot has confirmed everything the WAL holds", async () => {
    expect(await slotReadsInOnePoll({ behind: false })).toBe(0)
  })

  it("happens once the WAL has moved past the slot", async () => {
    expect(await slotReadsInOnePoll({ behind: true })).toBe(1)
  })

  it("happens when the position cannot be compared, so the read reports what is wrong", async () => {
    expect(await slotReadsInOnePoll({ behind: null })).toBe(1)
    expect(await slotReadsInOnePoll("no slot")).toBe(1)
  })
})
