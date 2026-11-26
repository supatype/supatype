import { describe, expect, it } from "vitest"
import { generateClientAugmentation } from "../src/augmentation-generator.js"
import { generateProjectClient } from "../src/client-generator.js"

const open = { join: { kind: "authenticated" }, send: null, track: null }

const channels = [
  { name: "LotChannel", pattern: "lot:{id}", params: [{ name: "id", type: "uuid" }], access: open },
  { name: "Lobby", pattern: "lobby:*", params: [], access: open },
  {
    name: "Room",
    pattern: "org:{org}:room:{n}",
    params: [
      { name: "org", type: "string" },
      { name: "n", type: "integer" },
    ],
    access: open,
  },
]

describe("channel declarations in the generated client", () => {
  it("emits SupatypeChannels keyed by pattern, params typed by their kind", () => {
    const out = generateClientAugmentation({ models: [], channels })
    expect(out).toContain("interface SupatypeChannels {")
    expect(out).toContain('"lot:{id}": { params: { id: string } }')
    expect(out).toContain('"lobby:*": { params: {} }')
    expect(out).toContain('"org:{org}:room:{n}": { params: { org: string; n: number } }')
  })

  it("leaves SupatypeChannels out when the schema declares no channel", () => {
    expect(generateClientAugmentation({ models: [] })).not.toContain("SupatypeChannels")
    expect(generateClientAugmentation({ models: [], channels: [] })).not.toContain("SupatypeChannels")
  })

  it("reaches the project client file", () => {
    expect(generateProjectClient({ models: [], channels })).toContain('"lot:{id}": { params: { id: string } }')
  })
})
