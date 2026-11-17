import { describe, expect, it } from "vitest"
import { ChannelCatalog } from "../src/channel-catalog.js"
import { ChannelGuard } from "../src/channel-guard.js"
import { RlsFilter } from "../src/rls.js"
import { FakeChannelDb, LOT_ID } from "./fixtures/fake-channel-db.js"

/**
 * On Cloud realtime logs in as a NOINHERIT role that holds no EXECUTE on the `_supatype.realtime_channel_*`
 * functions. They are granted to anon, authenticated and service_role, and the login is a member
 * of them. So the catalog must read as one of them (inside a transaction), never as the login.
 */
describe("channel catalog reads", () => {
  const errors: string[] = []
  const onError = (message: string): void => {
    errors.push(message)
  }

  it("run as authenticated, through the catalog session and not a join's caller session", async () => {
    const db = new FakeChannelDb()
    db.executeGrantedTo = new Set(["authenticated", "service_role"])
    const catalog = new ChannelCatalog(db, undefined, onError)

    const state = await catalog.current()

    expect(state.supported).toBe(true)
    expect(state.mode).toBe("declared")
    expect(state.sendChecks.has("LotChannel")).toBe(true)
    expect(state.readers.has("public.lots")).toBe(true)
    expect(db.callerSessions).toBe(0)
    expect(db.serviceSessions).toBe(1)
  })

  it("a reload is refused with SQLSTATE 42501 when the role it reads as has no EXECUTE", async () => {
    errors.length = 0
    const db = new FakeChannelDb()
    db.executeGrantedTo = new Set(["service_role"])
    const catalog = new ChannelCatalog(db, undefined, onError)
    await catalog.reload()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("SQLSTATE 42501")
    expect(catalog.peek()).toBeNull()
  })

  it("a reload keeps working when only the switched role may execute", async () => {
    errors.length = 0
    const db = new FakeChannelDb()
    db.executeGrantedTo = new Set(["authenticated"])
    const catalog = new ChannelCatalog(db, undefined, onError)
    await catalog.reload()
    expect(errors).toEqual([])
    expect(catalog.peek()?.supported).toBe(true)
  })
})

/** A pool of one scripted connection, to see what the real `RlsFilter.asCatalog` sends and gives back. */
function scriptedFilter(failOn: RegExp | null): { filter: RlsFilter; sent: string[]; released: () => number } {
  const sent: string[] = []
  let released = 0
  const client = {
    query: async (sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
      sent.push(params === undefined ? sql : `${sql} [${params.map(String).join(",")}]`)
      if (failOn !== null && failOn.test(sql)) throw Object.assign(new Error("permission denied"), { code: "42501" })
      return { rows: [] }
    },
    release: (): void => {
      released++
    },
  }
  const filter = new RlsFilter("postgres://unused/unused")
  Reflect.set(filter, "pool", { connect: async () => client })
  return { filter, sent, released: () => released }
}

describe("RlsFilter.asCatalog", () => {
  it("switches to authenticated inside a transaction and rolls back before releasing", async () => {
    const { filter, sent, released } = scriptedFilter(null)
    await filter.asCatalog((q) => q.query("SELECT _supatype.realtime_channel_mode() AS mode"))
    expect(sent[0]).toBe("BEGIN")
    expect(sent).toContain("SELECT set_config('role', $1, true) [authenticated]")
    expect(sent.indexOf("SELECT _supatype.realtime_channel_mode() AS mode")).toBeGreaterThan(sent.indexOf("SELECT set_config('role', $1, true) [authenticated]"))
    expect(sent.at(-1)).toBe("ROLLBACK")
    expect(released()).toBe(1)
  })

  it("still rolls back and releases when the read fails", async () => {
    const { filter, sent, released } = scriptedFilter(/realtime_channel_mode/)
    await expect(filter.asCatalog((q) => q.query("SELECT _supatype.realtime_channel_mode() AS mode"))).rejects.toMatchObject({ code: "42501" })
    expect(sent.at(-1)).toBe("ROLLBACK")
    expect(released()).toBe(1)
  })
})

describe("ChannelGuard.mayDeliverFromDatabase", () => {
  it("asks whether a topic is declared as authenticated, so a login with no EXECUTE of its own is not refused", async () => {
    const logs: string[] = []
    const db = new FakeChannelDb()
    db.executeGrantedTo = new Set(["anon", "authenticated", "service_role"])
    const catalog = new ChannelCatalog(db, undefined, (m) => logs.push(m))
    const guard = new ChannelGuard(db, catalog, false, (m) => logs.push(m))

    const delivered = await guard.mayDeliverFromDatabase(`lot:${LOT_ID}`, [])

    // fetchAccess reads a 42501 as "denied by the database", which still fans out, so the proof is
    // that the question reached the function as authenticated at all.
    expect(db.accessCalls).toEqual([{ topic: `lot:${LOT_ID}`, sub: undefined, role: "authenticated" }])
    expect(delivered).toBe(true)
    expect(logs).toEqual([])
  })
})
