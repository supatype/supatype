/**
 * Private channels on the client (plan section 6, stage D).
 *
 * The wire is the one packages/realtime speaks: the join carries `private: true`, the first system
 * frame of a socket announces `features: ["private_channels"]`, and a refusal or a withdrawal is a
 * channel-scoped system error frame. The tests drive the client with those frames.
 */

import { describe, it, expect, afterEach } from "vitest"
import type { ChannelStatus } from "../src/realtime.js"
import { RealtimeChannelError, RealtimeError, SupatypeError, isRealtimeChannelError } from "../src/errors.js"
import { simulateServerMessage, sentFrames, subscribeFrames, ackNewestJoin } from "./helpers/mock-websocket.js"
import { createSocketSwapHarness, type SocketSwapHarness } from "./helpers/socket-swap.js"

let harness: SocketSwapHarness

afterEach(() => harness.restore())

interface Seen {
  status: ChannelStatus
  err: Error | undefined
}

function greet(features?: string[]): void {
  simulateServerMessage(harness.socket(), {
    type: "system",
    status: "ok",
    message: "authenticated",
    ...(features !== undefined && { features }),
  })
}

function refuse(channel: string, message: string): void {
  const ref = subscribeFrames(harness.socket(), channel).at(-1)?.["ref"]
  simulateServerMessage(harness.socket(), { type: "system", status: "error", message, channel, ref })
}

function watch(channel: string, opts?: { private?: boolean }): Seen[] {
  const seen: Seen[] = []
  harness.realtime.channel(channel, opts).onBroadcast("bid", () => {}).subscribe((status, err) => seen.push({ status, err }))
  return seen
}

function lastError(seen: Seen[]): RealtimeChannelError {
  const err = seen.at(-1)?.err
  if (!(err instanceof RealtimeChannelError)) throw new Error(`expected a RealtimeChannelError, got ${String(err)}`)
  return err
}

describe("the private option on a join", () => {
  it("sends private: true once the server has announced private_channels", async () => {
    harness = createSocketSwapHarness()
    watch("lot:42", { private: true })
    await harness.settle()
    greet(["private_channels"])
    expect(subscribeFrames(harness.socket(), "lot:42")).toHaveLength(1)
    expect(subscribeFrames(harness.socket(), "lot:42")[0]?.["private"]).toBe(true)
  })

  it("holds a private join until the first frame says what the server can do", async () => {
    harness = createSocketSwapHarness()
    watch("lot:42", { private: true })
    await harness.settle()
    expect(subscribeFrames(harness.socket(), "lot:42")).toHaveLength(0)
  })

  it("sends a join that did not ask for privacy at once, with no private key", async () => {
    harness = createSocketSwapHarness()
    watch("lobby")
    await harness.settle()
    const frames = subscribeFrames(harness.socket(), "lobby")
    expect(frames).toHaveLength(1)
    expect("private" in (frames[0] ?? {})).toBe(false)
  })

  it("joins again as private when a second handle on the name asks for it", async () => {
    harness = createSocketSwapHarness()
    watch("lot:42")
    await harness.settle()
    greet(["private_channels"])
    ackNewestJoin(harness.socket(), "lot:42")
    watch("lot:42", { private: true })
    const frames = subscribeFrames(harness.socket(), "lot:42")
    expect(frames).toHaveLength(2)
    expect(frames[1]?.["private"]).toBe(true)
  })
})

describe("a server that does not enforce private channels", () => {
  it("fails a private join with a clear error when the greeting names no features", async () => {
    harness = createSocketSwapHarness()
    const seen = watch("lot:42", { private: true })
    await harness.settle()
    greet()
    expect(seen.map((s) => s.status)).toEqual(["CHANNEL_ERROR"])
    const err = lastError(seen)
    expect(err.reason).toBe("unsupported_server")
    expect(err.channel).toBe("lot:42")
    expect(err.message).toBe("this realtime server does not enforce private channels; upgrade it")
  })

  it("never sends the join, so no open channel is created", async () => {
    harness = createSocketSwapHarness()
    watch("lot:42", { private: true })
    await harness.settle()
    greet(["something_else"])
    expect(subscribeFrames(harness.socket(), "lot:42")).toHaveLength(0)
  })

  it("decides again on each socket, since a reconnect may reach a different server", async () => {
    harness = createSocketSwapHarness()
    const seen = watch("lot:42", { private: true })
    await harness.settle()
    greet(["private_channels"])
    ackNewestJoin(harness.socket(), "lot:42")
    await harness.signIn()
    expect(subscribeFrames(harness.socket(), "lot:42")).toHaveLength(0)
    greet()
    expect(seen.at(-1)?.status).toBe("CHANNEL_ERROR")
    expect(lastError(seen).reason).toBe("unsupported_server")
  })
})

describe("a refused join", () => {
  const cases: Array<[string, string, RealtimeChannelError["reason"], boolean]> = [
    ["join_denied", "not allowed to join lot:42: the join rule of LotChannel denied it", "join_denied", false],
    ["not_declared", "lot:42 was opened as private, but no Channel declaration matches it", "not_declared", false],
    ["does_not_fit", "lot:abc does not fit lot:{id}: id must be a UUID", "does_not_fit", false],
    ["unavailable", "could not check access to lot:42 because the database did not answer; retry", "unavailable", true],
    ["shared_instance", "private channels are not available on a shared realtime instance", "shared_instance", false],
    ["other", "permission denied", "refused", false],
  ]
  for (const [name, message, reason, retryable] of cases) {
    it(`is a RealtimeChannelError with reason ${name}`, async () => {
      harness = createSocketSwapHarness()
      const seen = watch("lot:42", { private: true })
      await harness.settle()
      greet(["private_channels"])
      refuse("lot:42", message)
      const err = lastError(seen)
      expect(err.reason).toBe(reason)
      expect(err.retryable).toBe(retryable)
      expect(err.message).toBe(message)
      expect(err).toBeInstanceOf(RealtimeError)
      expect(err).toBeInstanceOf(SupatypeError)
    })
  }
})

describe("access withdrawn from a channel the socket holds", () => {
  const withdrawn = "access to lot:42 was withdrawn: the join rule of LotChannel no longer admits this user"

  async function joined(): Promise<Seen[]> {
    harness = createSocketSwapHarness()
    const seen = watch("lot:42", { private: true })
    await harness.settle()
    greet(["private_channels"])
    ackNewestJoin(harness.socket(), "lot:42")
    return seen
  }

  function withdraw(message = withdrawn): void {
    simulateServerMessage(harness.socket(), { type: "system", status: "error", message, channel: "lot:42" })
  }

  it("tells the channel CHANNEL_ERROR with reason withdrawn", async () => {
    const seen = await joined()
    withdraw()
    expect(seen.map((s) => s.status)).toEqual(["SUBSCRIBED", "CHANNEL_ERROR"])
    expect(lastError(seen).reason).toBe("withdrawn")
    expect(lastError(seen).retryable).toBe(false)
  })

  it("also reads a withdrawal because the declaration went away", async () => {
    const seen = await joined()
    withdraw("access to lot:42 was withdrawn: it was opened as private, and no Channel declaration matches it any more")
    expect(lastError(seen).reason).toBe("withdrawn")
  })

  it("does not rejoin on its own, which the server would only refuse again", async () => {
    await joined()
    withdraw()
    expect(subscribeFrames(harness.socket(), "lot:42")).toHaveLength(1)
  })

  it("joins again when the app subscribes again", async () => {
    const seen = await joined()
    withdraw()
    harness.realtime.channel("lot:42", { private: true }).subscribe((status, err) => seen.push({ status, err }))
    expect(subscribeFrames(harness.socket(), "lot:42")).toHaveLength(2)
  })

  it("says SUBSCRIBED only to a handle added after the withdrawal, once the server takes the new join", async () => {
    const seen = await joined()
    withdraw()
    harness.realtime.channel("lot:42", { private: true }).subscribe((status, err) => seen.push({ status, err }))
    ackNewestJoin(harness.socket(), "lot:42")
    expect(seen.at(-1)?.status).toBe("SUBSCRIBED")
  })
})

describe("a broadcast sent from the database", () => {
  it("reaches onBroadcast listeners like any other broadcast, with no sender", async () => {
    harness = createSocketSwapHarness()
    const received: Array<Record<string, unknown>> = []
    harness.realtime.channel("lot:42", { private: true }).onBroadcast("bid", (p) => received.push(p)).subscribe()
    await harness.settle()
    greet(["private_channels"])
    ackNewestJoin(harness.socket(), "lot:42")
    simulateServerMessage(harness.socket(), { type: "broadcast", channel: "lot:42", event: "bid", payload: { amount: 12 } })
    expect(received).toEqual([{ amount: 12 }])
    expect(sentFrames(harness.socket()).filter((f) => f["type"] === "broadcast")).toHaveLength(0)
  })
})

describe("isRealtimeChannelError", () => {
  it("recognises the error, and an error of the same shape from another copy of the package", () => {
    const own = new RealtimeChannelError("denied", "lot:42", "join_denied")
    const other = Object.assign(new Error("denied"), { name: "RealtimeChannelError", channel: "lot:42", reason: "join_denied" })
    expect(isRealtimeChannelError(own)).toBe(true)
    expect(isRealtimeChannelError(other)).toBe(true)
  })

  it("does not take any other error for one", () => {
    expect(isRealtimeChannelError(new Error("denied"))).toBe(false)
    expect(isRealtimeChannelError(new RealtimeError("denied"))).toBe(false)
    expect(isRealtimeChannelError("denied")).toBe(false)
    expect(isRealtimeChannelError(undefined)).toBe(false)
  })
})

describe("a refusal's code, not its sentence, says what it is", () => {
  const codes: Array<[string, RealtimeChannelError["reason"], boolean]> = [
    ["join_denied", "join_denied", false],
    ["not_declared", "not_declared", false],
    ["does_not_fit", "does_not_fit", false],
    ["unavailable", "unavailable", true],
    ["shared_instance", "shared_instance", false],
    ["refused", "refused", false],
  ]
  for (const [code, reason, retryable] of codes) {
    it(`reads code ${code} as reason ${reason} whatever the sentence says`, async () => {
      harness = createSocketSwapHarness()
      const seen = watch("lot:42", { private: true })
      await harness.settle()
      greet(["private_channels"])
      const ref = subscribeFrames(harness.socket(), "lot:42").at(-1)?.["ref"]
      simulateServerMessage(harness.socket(), { type: "system", status: "error", code, message: "worded some new way", channel: "lot:42", ref })
      expect(lastError(seen).reason).toBe(reason)
      expect(lastError(seen).retryable).toBe(retryable)
      expect(lastError(seen).message).toBe("worded some new way")
    })
  }

  it("reads a code over a sentence that says something else", async () => {
    harness = createSocketSwapHarness()
    const seen = watch("lot:42", { private: true })
    await harness.settle()
    greet(["private_channels"])
    const ref = subscribeFrames(harness.socket(), "lot:42").at(-1)?.["ref"]
    simulateServerMessage(harness.socket(), {
      type: "system",
      status: "error",
      code: "unavailable",
      message: "not allowed to join lot:42: the join rule of LotChannel denied it",
      channel: "lot:42",
      ref,
    })
    expect(lastError(seen).reason).toBe("unavailable")
  })

  it("reads a code this client does not know as refused, never by the sentence", async () => {
    harness = createSocketSwapHarness()
    const seen = watch("lot:42", { private: true })
    await harness.settle()
    greet(["private_channels"])
    const ref = subscribeFrames(harness.socket(), "lot:42").at(-1)?.["ref"]
    simulateServerMessage(harness.socket(), {
      type: "system",
      status: "error",
      code: "from_the_future",
      message: "not allowed to join lot:42: the join rule of LotChannel denied it",
      channel: "lot:42",
      ref,
    })
    expect(lastError(seen).reason).toBe("refused")
  })

  it("reads a withdrawal by its code", async () => {
    harness = createSocketSwapHarness()
    const seen = watch("lot:42", { private: true })
    await harness.settle()
    greet(["private_channels"])
    ackNewestJoin(harness.socket(), "lot:42")
    simulateServerMessage(harness.socket(), { type: "system", status: "error", code: "withdrawn", message: "gone", channel: "lot:42" })
    expect(seen.map((s) => s.status)).toEqual(["SUBSCRIBED", "CHANNEL_ERROR"])
    expect(lastError(seen).reason).toBe("withdrawn")
  })
})

describe("a send, track or payload refused on a healthy channel", () => {
  interface Refused {
    channel: string
    code: string
    message: string
  }

  async function healthy(): Promise<{ seen: Seen[]; refused: Refused[] }> {
    harness = createSocketSwapHarness()
    const seen: Seen[] = []
    const refused: Refused[] = []
    harness.realtime
      .channel("lot:42", { private: true })
      .onBroadcast("bid", () => {})
      .onRefused((event) => refused.push(event))
      .subscribe((status, err) => seen.push({ status, err }))
    await harness.settle()
    greet(["private_channels"])
    ackNewestJoin(harness.socket(), "lot:42")
    return { seen, refused }
  }

  const cases: Array<[string, string]> = [
    ["send_denied", "not allowed to broadcast on lot:42: the send rule of LotChannel denied it"],
    ["track_denied", "not allowed to track presence on lot:42: the track rule of LotChannel denied it"],
    ["payload_refused", "not allowed to broadcast bid on lot:42: the send rule of LotChannel refused the payload"],
  ]
  for (const [code, message] of cases) {
    it(`reports ${code} as an event and leaves the channel SUBSCRIBED`, async () => {
      const { seen, refused } = await healthy()
      simulateServerMessage(harness.socket(), { type: "system", status: "error", code, message, channel: "lot:42" })
      expect(refused).toEqual([{ channel: "lot:42", code, message }])
      expect(seen.map((s) => s.status)).toEqual(["SUBSCRIBED"])
    })
  }

  it("tells every handle on the channel that listens", async () => {
    const { refused } = await healthy()
    const second: Refused[] = []
    harness.realtime.channel("lot:42", { private: true }).onRefused((event) => second.push(event)).subscribe()
    harness.realtime.channel("lot:42", { private: true }).subscribe()
    simulateServerMessage(harness.socket(), { type: "system", status: "error", code: "send_denied", message: "no", channel: "lot:42" })
    expect(refused).toHaveLength(1)
    expect(second).toHaveLength(1)
  })

  it("keeps the join intact", async () => {
    const { seen } = await healthy()
    simulateServerMessage(harness.socket(), { type: "system", status: "error", code: "send_denied", message: "no", channel: "lot:42" })
    simulateServerMessage(harness.socket(), { type: "broadcast", channel: "lot:42", event: "bid", payload: { amount: 1 } })
    expect(seen.map((s) => s.status)).toEqual(["SUBSCRIBED"])
    expect(subscribeFrames(harness.socket(), "lot:42")).toHaveLength(1)
  })

  it("reads the sentence of an older server that sends no code", async () => {
    const { seen, refused } = await healthy()
    simulateServerMessage(harness.socket(), {
      type: "system",
      status: "error",
      message: "not allowed to broadcast on lot:42: the send rule of LotChannel denied it",
      channel: "lot:42",
    })
    expect(refused.map((r) => r.code)).toEqual(["send_denied"])
    expect(seen.map((s) => s.status)).toEqual(["SUBSCRIBED"])
  })
})

describe("an older server that sends no code", () => {
  it("still classifies a refused join by its sentence", async () => {
    harness = createSocketSwapHarness()
    const seen = watch("lot:42", { private: true })
    await harness.settle()
    greet(["private_channels"])
    refuse("lot:42", "not allowed to join lot:42: the join rule of LotChannel denied it")
    expect(lastError(seen).reason).toBe("join_denied")
  })
})
