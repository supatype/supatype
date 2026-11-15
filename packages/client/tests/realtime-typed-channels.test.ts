/**
 * Typed channel names: a declared pattern autocompletes as a template literal type, and every
 * other string is still a valid name, since an `open` server admits it.
 *
 * Most of this file is checked by `tsc` (the package's typecheck script), not by vitest: a
 * `@ts-expect-error` that stops being an error fails the typecheck.
 */
import { describe, it, expect } from "vitest"
import type { ChannelName, DeclaredTopic, DeclaredTopics } from "../src/index.js"

interface Declared {
  "lot:{id}": { params: { id: string } }
  "lobby:*": { params: Record<string, never> }
  "org:{org}:room:{n}": { params: { org: string; n: number } }
  plain: { params: Record<string, never> }
}

type Topic = DeclaredTopics<Declared>

const ok = (topic: Topic): Topic => topic

describe("DeclaredTopics", () => {
  it("accepts a topic built from each declared pattern", () => {
    const topics = [
      ok("lot:7f3c"),
      ok("lobby:anything"),
      ok("org:acme:room:12"),
      ok("plain"),
    ]
    expect(topics).toHaveLength(4)
  })

  it("rejects a topic no declaration can match", () => {
    // @ts-expect-error not a declared topic
    ok("auction:1")
    // @ts-expect-error an Integer parameter takes a number, not words
    ok("org:acme:room:twelve")
    // @ts-expect-error the literal prefix must be there
    ok("other:7f3c")
    expect(true).toBe(true)
  })

  it("is never for a project that declares nothing, so ChannelName stays an open string", () => {
    const none: DeclaredTopics<Record<never, never>> extends never ? true : false = true
    const open: ChannelName = "anything:at:all"
    const declared: DeclaredTopic extends string ? true : false = true
    expect([none, open, declared]).toEqual([true, "anything:at:all", true])
  })
})
