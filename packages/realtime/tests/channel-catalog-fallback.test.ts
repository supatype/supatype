import { describe, expect, it } from "vitest"
import { ChannelCatalog } from "../src/channel-catalog.js"
import { FakeChannelDb } from "./fixtures/fake-channel-db.js"

/**
 * Until a database's first push it has none of the `_supatype.realtime_channel_*` functions. A
 * brand-new database starts "declared": nothing may broadcast or track presence until a push
 * says what is allowed. A push rewrites the mode from the project's config, so a project that
 * says "open" (or says nothing) is open again from its first push on.
 */
describe("channel catalog before the first push", () => {
  const noError = (): void => {}

  it("is unsupported and declared when the database has none of the functions", async () => {
    const db = new FakeChannelDb()
    db.noFunctions = true
    const catalog = new ChannelCatalog(db, undefined, noError)

    const state = await catalog.current()

    expect(state.supported).toBe(false)
    expect(state.mode).toBe("declared")
    expect(catalog.effectiveMode(state)).toBe("declared")
  })

  it("stays declared even when REALTIME_CHANNELS says open, which can never loosen", async () => {
    const db = new FakeChannelDb()
    db.noFunctions = true
    const catalog = new ChannelCatalog(db, "open", noError)

    expect(catalog.effectiveMode(await catalog.current())).toBe("declared")
  })

  it("reads the database's own mode once the functions exist", async () => {
    const db = new FakeChannelDb()
    db.mode = "open"
    const catalog = new ChannelCatalog(db, undefined, noError)

    const state = await catalog.current()

    expect(state.supported).toBe(true)
    expect(catalog.effectiveMode(state)).toBe("open")
  })
})
