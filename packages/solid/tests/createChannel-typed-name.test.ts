/** The channel binding's name takes a ChannelName, so a declared topic autocompletes and any other string still works. */

import { describe, expect, it } from "vitest"
import type { ChannelName } from "@supatype/client"
import type { Accessor } from "solid-js"
import type { createChannel } from "../src/createChannel.js"

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

describe("createChannel name type", () => {
  it("is a ChannelName", () => {
    const same: Same<Parameters<typeof createChannel>[0], ChannelName | Accessor<ChannelName>> = true
    expect(same).toBe(true)
  })
})
