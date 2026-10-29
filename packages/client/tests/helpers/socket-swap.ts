import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { RealtimeClient } from "../../src/realtime.js"
import {
  createMockWebSocketClass,
  simulateServerMessage,
  subscribedChannels,
  type MockWebSocketInstance,
} from "./mock-websocket.js"

/**
 * A realtime client on a stand-in socket, with the sign-in that swaps that socket for a new one.
 *
 * Shared by the client's suite and by every framework binding's, because each binding must show
 * the same status sequence across the same swap. A copy per binding would let one of them drift
 * into testing a socket that no longer behaves like the client's.
 *
 * Not named `*.test.ts`, so vitest's default include does not collect it as a suite.
 */
export interface SocketSwapHarness {
  realtime: RealtimeClient
  /** Every socket opened so far, oldest first. */
  sockets: MockWebSocketInstance[]
  /** The newest socket. Fails the test when none has been opened. */
  socket(): MockWebSocketInstance
  /** Let queued connects and opens run. */
  settle(): Promise<void>
  /** The server acknowledges every join sent on the newest socket. */
  ackJoins(): void
  /** The server refuses a join on the newest socket. */
  refuseJoin(): void
  /** Change identity, which replaces the socket, and let the replacement open. */
  signIn(): Promise<void>
  /** Put the real WebSocket back. */
  restore(): void
}

function newestOf(sockets: MockWebSocketInstance[]): MockWebSocketInstance {
  const socket = sockets[sockets.length - 1]
  if (socket === undefined) throw new Error("no socket has been opened")
  return socket
}

export function createSocketSwapHarness(): SocketSwapHarness {
  const mock = createMockWebSocketClass()
  vi.stubGlobal("WebSocket", mock.MockWebSocket)
  let token = "anon"
  const realtime = new RealtimeClient("ws://localhost:4000/realtime", async () => ({ Authorization: `Bearer ${token}` }))
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))
  const reply = (status: "ok" | "error", message: string): void =>
    simulateServerMessage(newestOf(mock.instances), { type: "system", status, message })

  return {
    realtime,
    sockets: mock.instances,
    socket: () => newestOf(mock.instances),
    settle,
    ackJoins: () => {
      for (const channel of subscribedChannels(newestOf(mock.instances))) reply("ok", `subscribed to ${channel}`)
    },
    refuseJoin: () => reply("error", "permission denied"),
    signIn: async () => {
      token = "user"
      await realtime.reauthenticate()
      await settle()
    },
    restore: () => vi.unstubAllGlobals(),
  }
}

/**
 * The status a subscription shows at each point of a sign-in: subscribed, joined, swapped, and
 * then joined again on the new socket, or refused there.
 *
 * `read` is whatever the subject under test exposes, read as it stands at that moment.
 */
export async function statusesAcrossSwap(
  harness: SocketSwapHarness,
  read: () => string,
  { refuse = false }: { refuse?: boolean } = {},
): Promise<string[]> {
  const seen: string[] = []
  await harness.settle()
  seen.push(read())
  harness.ackJoins()
  seen.push(read())
  await harness.signIn()
  seen.push(read())
  if (refuse) harness.refuseJoin()
  else harness.ackJoins()
  seen.push(read())
  return seen
}

/** What a binding under test exposes, read as it stands. */
export interface StatusProbe {
  status(): string
  /** The error it exposes, when it exposes one. */
  error?(): unknown
}

/** What the Vue, Svelte and Solid bindings read at each point of `statusesAcrossSwap`. */
export const BINDING_STATES = {
  swap: ["connecting", "connected", "connecting", "connected"],
  refused: ["connecting", "connected", "connecting", "error"],
}

/**
 * The two cases every binding's suite asserts, written once.
 *
 * `mount` starts the subscription against the harness it is given. `unmount` runs the cleanup the
 * binding registered. The framework mocks stay in each suite, because `vi.mock` is hoisted per file.
 */
export function describeStatusAcrossSignIn(
  subject: string,
  mount: (harness: SocketSwapHarness) => StatusProbe,
  unmount: () => void,
  expected: { swap: string[]; refused: string[] } = BINDING_STATES,
): void {
  describe(`${subject} status across sign-in`, () => {
    let harness: SocketSwapHarness

    beforeEach(() => {
      harness = createSocketSwapHarness()
    })

    afterEach(() => {
      unmount()
      harness.restore()
    })

    it("reads connecting from the swap until the new socket acknowledges the join", async () => {
      const probe = mount(harness)
      expect(await statusesAcrossSwap(harness, probe.status)).toEqual(expected.swap)
    })

    it("reads error when the new socket refuses the join", async () => {
      const probe = mount(harness)
      expect(await statusesAcrossSwap(harness, probe.status, { refuse: true })).toEqual(expected.refused)
      if (probe.error) expect(probe.error()).not.toBeNull()
    })
  })
}
