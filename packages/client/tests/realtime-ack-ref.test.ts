/**
 * A server reply is matched to the join that asked for it, not to whatever join on that channel
 * name happens to be pending when it arrives.
 *
 * Replies used to be read by channel name alone. Two joins on one name close together (a rejoin
 * after the joining handle leaves, or a leave followed at once by a new join) each got the other's
 * answer: the first join's acknowledgement reported SUBSCRIBED for a second join the server went on
 * to refuse, and the first join's refusal put a handle whose own join succeeded into CHANNEL_ERROR.
 *
 * The fake server here answers every frame in the order it was sent, as the real one does, and
 * echoes the frame's `ref` when it carried one.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import type { ChannelStatus } from "../src/realtime.js"
import { channelOf, sentFrames, simulateServerMessage } from "./helpers/mock-websocket.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "./helpers/socket-swap.js"

const CHANNEL = "x"
const BAD_FILTER = "status=like.open"

let harness: SocketSwapHarness
let answered = 0

/** The server's reply to one subscribe or unsubscribe frame, with a join's ref when it had one. */
function replyTo(frame: Record<string, unknown>, echoRef: boolean): Record<string, unknown> {
  const channel = channelOf(frame)
  if (frame["type"] === "unsubscribe") return { type: "system", status: "ok", message: `unsubscribed from ${channel}` }
  const ref = echoRef && typeof frame["ref"] === "string" ? { ref: frame["ref"] } : {}
  const filter = frame["filter"]
  const refused = typeof filter === "object" && filter !== null && "status" in filter
  if (refused) return { type: "system", status: "error", message: `invalid filter ${BAD_FILTER}`, channel, ...ref }
  return { type: "system", status: "ok", message: `subscribed to ${channel}`, ...ref }
}

/** Answer every join and leave sent since the last call, in the order they went out. */
function answerInOrder({ echoRef = true }: { echoRef?: boolean } = {}): void {
  const pending = sentFrames(harness.socket())
    .filter((frame) => frame["type"] === "subscribe" || frame["type"] === "unsubscribe")
    .slice(answered)
  answered += pending.length
  for (const frame of pending) simulateServerMessage(harness.socket(), replyTo(frame, echoRef))
}

beforeEach(() => {
  harness = createSocketSwapHarness()
  answered = 0
})

afterEach(() => harness.restore())

describe("a rejoin sent before the join it replaces is answered", () => {
  it("is not reported SUBSCRIBED by the earlier join's acknowledgement when it is itself refused", async () => {
    const statuses: ChannelStatus[] = []
    const a = harness.realtime.channel(CHANNEL).on("postgres_changes", { event: "*", table: "audit_log" }, () => {}).subscribe()
    harness.realtime
      .channel(CHANNEL)
      .on("postgres_changes", { event: "*", table: "messages", filter: BAD_FILTER }, () => {})
      .subscribe((s) => statuses.push(s))
    await harness.settle()

    // The first join is still unanswered when its handle leaves, so the channel joins again.
    a.unsubscribe()
    answerInOrder()

    expect(statuses).toEqual(["SUBSCRIBING", "CHANNEL_ERROR"])
    // Nothing on this channel is subscribed, so a handle arriving now is not told it is.
    const late: ChannelStatus[] = []
    harness.realtime.channel(CHANNEL).subscribe((s) => late.push(s))
    expect(late).toEqual([])
  })
})

describe("a join sent right after the channel was left", () => {
  function join(filter: string | undefined, onStatus?: (status: ChannelStatus) => void): { unsubscribe(): void } {
    return harness.realtime.channel(CHANNEL).on("postgres_changes", { event: "*", table: "t", filter }, () => {}).subscribe(onStatus)
  }

  async function leaveThenJoin(firstFilter: string | undefined, secondFilter: string | undefined): Promise<ChannelStatus[]> {
    // Another channel keeps the socket open across the leave.
    harness.realtime.channel("keep").subscribe()
    const first = join(firstFilter)
    await harness.settle()
    first.unsubscribe()
    const statuses: ChannelStatus[] = []
    join(secondFilter, (s) => statuses.push(s))
    answerInOrder()
    return statuses
  }

  it("is not put into CHANNEL_ERROR by the refusal of the join before it", async () => {
    expect(await leaveThenJoin(BAD_FILTER, undefined)).toEqual(["SUBSCRIBED"])
  })

  it("is not reported SUBSCRIBED by the acknowledgement of the join before it", async () => {
    expect(await leaveThenJoin(undefined, BAD_FILTER)).toEqual(["CHANNEL_ERROR"])
  })
})

describe("a server that echoes no ref", () => {
  it("still has its replies read by channel name, as before refs existed", async () => {
    const statuses: ChannelStatus[] = []
    harness.realtime.channel(CHANNEL).subscribe((s) => statuses.push(s))
    await harness.settle()

    const join = sentFrames(harness.socket()).find((frame) => frame["type"] === "subscribe")
    expect(typeof join?.["ref"]).toBe("string")
    answerInOrder({ echoRef: false })

    expect(statuses).toEqual(["SUBSCRIBED"])
  })
})
