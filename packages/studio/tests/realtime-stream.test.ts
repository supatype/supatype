import { describe, expect, it } from "vitest"
import {
  INITIAL_STREAM,
  STREAM_ROWS_MAX,
  consumeStream,
  streamQuery,
  streamReducer,
  type StreamAction,
  type StreamState,
} from "../src/hooks/useRealtimeStream.js"

// ST-2: the Inspector's stream, from the bytes the control plane sends to the rows the Stream tab
// shows. The control plane chooses the payload view; Studio only reports it.

function sse(events: Array<[string, unknown]>): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(": ping\n\n")
}

function body(text: string): Response {
  const bytes = new TextEncoder().encode(text)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Cut mid-event, as a network does.
      controller.enqueue(bytes.slice(0, 37))
      controller.enqueue(bytes.slice(37))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

async function run(response: Response): Promise<StreamState> {
  let state = INITIAL_STREAM
  await consumeStream(async () => response, (action: StreamAction) => {
    state = streamReducer(state, action)
  }, new AbortController().signal)
  return state
}

const change = { seq: 1, at: "t", commitTimestamp: "t", schema: "public", table: "posts", event: "INSERT", deliveries: [], withheld: [], notMatched: 0 }
const broadcast = { seq: 2, at: "t", channel: "room:1", event: "ping", origin: "studio", senderConnectionId: null, recipients: 1, bytes: 10 }

describe("consumeStream", () => {
  it("brings ready, change, broadcast and sampled events into state, newest first", async () => {
    const state = await run(body(sse([
      ["ready", { view: "viewer", rate: 20, filters: {} }],
      ["change", change],
      ["broadcast", broadcast],
      ["sampled", { skipped: 40, since: "t" }],
    ])))
    expect(state.ready?.view).toBe("viewer")
    expect(state.rows.map((r) => r.kind)).toEqual(["sampled", "broadcast", "change"])
    expect(state.status).toBe("closed")
  })

  it("reports a refusal with the control plane's code", async () => {
    const state = await run(Response.json({ error: "too_many_sessions", message: "Too many inspector streams" }, { status: 429 }))
    expect(state).toMatchObject({ status: "error", errorCode: "too_many_sessions", error: "Too many inspector streams" })
  })
})

describe("streamReducer", () => {
  it(`keeps the newest ${STREAM_ROWS_MAX} rows`, () => {
    let state = INITIAL_STREAM
    for (let seq = 0; seq < STREAM_ROWS_MAX + 5; seq++) {
      state = streamReducer(state, { type: "row", row: { kind: "change", change: { ...change, seq } as never } })
    }
    expect(state.rows).toHaveLength(STREAM_ROWS_MAX)
    expect(state.rows[0]).toMatchObject({ change: { seq: STREAM_ROWS_MAX + 4 } })
  })

  it("clears rows and keeps the stream", () => {
    const state = streamReducer({ ...INITIAL_STREAM, status: "streaming", rows: [{ kind: "sampled", skipped: 1, since: "t", key: "k" }] }, { type: "clear" })
    expect(state).toMatchObject({ status: "streaming", rows: [] })
  })
})

describe("streamQuery", () => {
  it("sends only the filters that are set, and never a view", () => {
    expect(streamQuery({ kind: "all", event: "", channel: "", table: "" })).toBe("")
    expect(streamQuery({ kind: "change", event: "UPDATE", channel: " room:1 ", table: "posts" })).toBe("?kinds=change&event=UPDATE&channel=room%3A1&table=posts")
  })
})
