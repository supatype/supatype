import { describe, expect, it } from "vitest"
import { parseSseEvents, readSse, sseJson, type SseEvent } from "../src/lib/sse-reader.js"

// The Server-Sent Events reader Studio's live streams share. Events are named (the Realtime
// Inspector sends `ready`, `change`, `broadcast`, `presence` and `sampled`), and a network chunk can
// cut one anywhere.

describe("parseSseEvents", () => {
  it("reads named events and their data", () => {
    const { events, rest } = parseSseEvents('event: change\ndata: {"seq":1}\n\nevent: sampled\ndata: {"skipped":3}\n\n')
    expect(events).toEqual([
      { event: "change", data: '{"seq":1}' },
      { event: "sampled", data: '{"skipped":3}' },
    ])
    expect(rest).toBe("")
  })

  it("names an event with no event line `message`", () => {
    expect(parseSseEvents("data: hi\n\n").events).toEqual([{ event: "message", data: "hi" }])
  })

  it("holds an event split across chunks until the rest arrives", () => {
    const whole = 'event: broadcast\ndata: {"channel":"room:1"}\n\n'
    const cut = whole.indexOf("room")
    const first = parseSseEvents(whole.slice(0, cut))
    expect(first.events).toEqual([])
    const second = parseSseEvents(first.rest + whole.slice(cut))
    expect(second.events).toEqual([{ event: "broadcast", data: '{"channel":"room:1"}' }])
  })

  it("ignores comments and retry lines", () => {
    expect(parseSseEvents(": ping\n\nretry: 2000\n\nevent: ready\ndata: {}\n\n").events).toEqual([{ event: "ready", data: "{}" }])
  })

  it("reads a stream written with CRLF line ends", () => {
    expect(parseSseEvents("event: ready\r\ndata: {}\r\n\r\n").events).toEqual([{ event: "ready", data: "{}" }])
  })
})

describe("sseJson", () => {
  it("skips data that is not JSON rather than throwing", () => {
    expect(sseJson({ event: "change", data: "{not json" })).toBeNull()
    expect(sseJson<{ a: number }>({ event: "change", data: '{"a":1}' })).toEqual({ a: 1 })
  })
})

describe("readSse", () => {
  it("delivers every event of a body that arrives in pieces", async () => {
    const pieces = ["event: re", "ady\ndata: {}\n", "\nevent: change\ndata: {\"seq\":1}\n\n"]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(new TextEncoder().encode(piece))
        controller.close()
      },
    })
    const seen: SseEvent[] = []
    await readSse(body, (event) => seen.push(event))
    expect(seen.map((e) => e.event)).toEqual(["ready", "change"])
  })
})
