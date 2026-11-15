import { describe, expect, it } from "vitest"
import { formatChannelChanges } from "../src/diff-channels.js"
import type { ChannelChange } from "../src/engine-client.js"

/**
 * What `supatype diff` and `push` say about realtime channels (plan section 8): which were added,
 * removed or changed and on which operation, and what removing one or tightening the mode does.
 */

const added: ChannelChange = { name: "LotChannel", pattern: "lot:{id}", change: "added" }
const removed: ChannelChange = { name: "OldChannel", pattern: "old:{id}", change: "removed" }
const changed: ChannelChange = {
  name: "Lobby",
  pattern: "lobby",
  change: "changed",
  operations: ["send", "track"],
}

describe("formatChannelChanges()", () => {
  it("says nothing for an engine that sends no channel information", () => {
    expect(formatChannelChanges({})).toEqual([])
    expect(formatChannelChanges({ channels: [] })).toEqual([])
  })

  it("lists added, removed and changed channels with the operations whose rule changed", () => {
    expect(formatChannelChanges({ channels: [added, removed, changed] })).toEqual([
      "Realtime channels:",
      "  + LotChannel  lot:{id}",
      "  - OldChannel  old:{id}",
      "  ~ Lobby       lobby  (send, track rule changed)",
    ])
  })

  it("warns that a removed channel's topics lose broadcast and presence under declared", () => {
    const lines = formatChannelChanges({ channels: [removed], realtimeMode: { before: "declared", after: "declared" } })
    expect(lines.join("\n")).toContain(
      'Removing OldChannel: topics matching old:{id} lose broadcast and presence, because realtime.channels is "declared".',
    )
  })

  it("does not warn about a removal while the mode is open", () => {
    const lines = formatChannelChanges({ channels: [removed], realtimeMode: { before: "open", after: "open" } })
    expect(lines.join("\n")).not.toContain("Removing")
  })

  it("warns when the mode goes from open to declared", () => {
    const lines = formatChannelChanges({ realtimeMode: { before: "open", after: "declared" } })
    expect(lines.join("\n")).toContain(
      'realtime.channels goes from "open" to "declared": broadcast and presence on a topic no channel declares will be refused.',
    )
  })

  it("is quiet about a mode that does not change", () => {
    expect(formatChannelChanges({ realtimeMode: { before: "declared", after: "declared" } })).toEqual([])
  })
})
