/**
 * The table `useSubscription` joins when the docs' example names a table and no schema.
 *
 * 0.9.1 release test (RB4): `useSubscription("comments:7", { table: "comment" })` joined
 * `comments.comment`, because the client read the schema off the channel name even though the
 * table was given. The hook reported SUBSCRIBED and delivered nothing. The docs say the schema
 * defaults to `public`.
 */

import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { createSocketSwapHarness, type SocketSwapHarness } from "../../client/tests/helpers/socket-swap.js"
import { sentFrames } from "../../client/tests/helpers/mock-websocket.js"

const shared = vi.hoisted(() => ({ harness: null as SocketSwapHarness | null }))

vi.mock("../src/context.js", () => ({
  useSupatype: () => ({ realtime: shared.harness?.realtime }),
}))

import { useSubscription } from "../src/useSubscription.js"

let renderer: ReactTestRenderer | null = null

function Comments({ postId }: { postId: string }): null {
  useSubscription(`comments:${postId}`, {
    table: "comment",
    event: "INSERT",
    filter: `post_id=eq.${postId}`,
    callback: () => undefined,
  })
  return null
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  shared.harness?.restore()
  shared.harness = null
})

describe("useSubscription with a table and no schema", () => {
  it("joins the table in public, as the docs' example is written", async () => {
    const harness = createSocketSwapHarness()
    shared.harness = harness
    act(() => {
      renderer = create(<Comments postId="7" />)
    })
    await harness.settle()

    const joins = sentFrames(harness.socket()).filter((frame) => frame["type"] === "subscribe")
    expect(joins).toHaveLength(1)
    expect(joins[0]).toMatchObject({ channel: "comments:7", schema: "public", table: "comment" })
  })
})
