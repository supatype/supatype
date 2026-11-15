/** The channel binding's name takes a ChannelName, so a declared topic autocompletes and any other string still works. */

import { describe, expect, it } from "vitest"
import type { ChannelName } from "@supatype/client"
import type { MaybeRefOrGetter } from "vue"
import type { useChannel } from "../src/useChannel.js"

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

describe("useChannel name type", () => {
  it("is a ChannelName", () => {
    const same: Same<Parameters<typeof useChannel>[0], MaybeRefOrGetter<ChannelName>> = true
    expect(same).toBe(true)
  })
})
