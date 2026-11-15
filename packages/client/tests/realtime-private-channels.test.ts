/**
 * Private channels on the client (plan section 6, stage D).
 *
 * The wire is the one packages/realtime speaks: the join carries `private: true`, the first system
 * frame of a socket announces `features: ["private_channels"]`, and a refusal or a withdrawal is a
 * channel-scoped system error frame. The tests drive the client with those frames.
 */

import { describe, it, expect, afterEach } from "vitest"
import type { ChannelStatus } from "../src/realtime.js"
import { RealtimeChannelError, RealtimeError, SupatypeError } from "../src/errors.js"
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
