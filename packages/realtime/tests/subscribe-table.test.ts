import { describe, expect, it } from "vitest"
import { ChannelManager } from "../src/channels.js"
import type { Subscription } from "../src/types.js"

/**
 * Which table a subscription is for.
 *
 * The channel is a name for a subscription. It was also being read as a statement about which
 * table that subscription concerns, and those are not the same thing: `parseChannel` splits the
 * name on `:` and takes the second half as the table.
 *
 * That guess is right for `from(table).subscribe()`, which names the channel after its table, and
 * wrong for everything else. `useSubscription("lobby-chat", { table: "chat_message" })` exists
 * precisely so a channel can be named for what it is, and it registered against a table called
 * `lobby-chat` that no change can ever match. The socket reported SUBSCRIBED and delivered
 * nothing, which is indistinguishable from a quiet table, and the client had resolved the right
 * table before dropping it on the way to the wire.
 *
 * These pin the resolution rule rather than the transport: what the subscriber said wins, and the
 * channel name is the fallback for clients that predate sending it.
 */

/**
 * The server's own rule, not a copy of it.
 *
 * This file first restated the resolution locally, and that version passed with the server's fix
 * reverted: it was asserting the test's logic rather than the server's. `resolveTarget` exists so
 * there is one implementation for both to use.
 */
const resolve = ChannelManager.resolveTarget

describe("the table a subscription watches", () => {
  it("is the one the subscriber named, whatever the channel is called", () => {
    expect(resolve({ channel: "lobby-chat", table: "chat_message" })).toEqual({
      schema: "public",
      table: "chat_message",
    })
  })

  it("falls back to the channel name when none was sent", () => {
    // An older client sends no table at all. It must behave exactly as it did before.
    expect(resolve({ channel: "chat_message" })).toEqual({
      schema: "public",
      table: "chat_message",
    })
  })

  it("still reads schema:table out of a channel that carries one", () => {
    expect(resolve({ channel: "app:orders" })).toEqual({ schema: "app", table: "orders" })
  })

  it("lets a stated schema override the channel's", () => {
    expect(resolve({ channel: "app:orders", schema: "public", table: "orders" })).toEqual({
      schema: "public",
      table: "orders",
    })
  })

  it("does not invent a table from a channel named for its purpose", () => {
    // The failing case, stated as itself: without a table this resolves to something no WAL
    // change can match, which is the silence this fix removes.
    expect(resolve({ channel: "lobby-chat" }).table).toBe("lobby-chat")
    expect(resolve({ channel: "lobby-chat", table: "chat_message" }).table).toBe("chat_message")
  })
})

describe("a subscriber registered under a name unlike its table", () => {
  it("receives changes for the table it named", () => {
    const channels = new ChannelManager()
    const ws = { readyState: 1, send: () => {} } as unknown as WebSocket
    const clientId = channels.addClient(ws, null)

    const subscription: Subscription = {
      channel: "lobby-chat",
      ...resolve({ channel: "lobby-chat", table: "chat_message" }),
      event: "INSERT",
      filter: {},
    }
    channels.subscribe(clientId, subscription)

    // Looked up by table, which is what a WAL change carries. Before the fix this list was empty
    // for every change on `chat_message`, because the subscription sat under `lobby-chat`.
    expect(channels.getSubscribers("public", "chat_message")).toHaveLength(1)
    expect(channels.getSubscribers("public", "lobby-chat")).toHaveLength(0)
  })
})
