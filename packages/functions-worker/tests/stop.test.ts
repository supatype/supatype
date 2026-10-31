import { expectEqual } from "./worker-harness.ts"
import { exitOnStop, type StopHooks } from "../stop.ts"

/**
 * The worker ran as PID 1 in its container with no handler for SIGTERM, which PID 1 does not get by
 * default, so `docker restart` waited out the whole 10 s stop timeout: every self-host deploy that
 * restarted it took more than ten seconds. It stops on SIGTERM and SIGINT, and (review B4) lets the
 * requests in flight finish first, for a bounded time, rather than cutting them off.
 */
function fakeHooks(os: string): { hooks: StopHooks; handlers: Map<string, () => void>; exits: number[] } {
  const handlers = new Map<string, () => void>()
  const exits: number[] = []
  return {
    handlers,
    exits,
    hooks: { os, addSignalListener: (signal, handler) => void handlers.set(signal, handler), exit: (code) => void exits.push(code) },
  }
}

/** A drain that ends when the test says, counting how often it was started. */
function heldDrain(): { drain: () => Promise<void>; finish: () => void; started: () => number } {
  let finish = (): void => {}
  let started = 0
  const drained = new Promise<void>((done) => (finish = done))
  return { drain: () => (started++, drained), finish: () => finish(), started: () => started }
}

const settle = (ms = 0): Promise<void> => new Promise((done) => setTimeout(done, ms))

Deno.test("exits on SIGTERM only once the requests in flight have finished", async () => {
  const { hooks, handlers, exits } = fakeHooks("linux")
  const held = heldDrain()
  exitOnStop(held.drain, hooks)
  handlers.get("SIGTERM")?.()
  await settle()
  expectEqual(exits.join(","), "", "the exits while a request is in flight")
  held.finish()
  await settle()
  expectEqual(exits.join(","), "0", "the exits once it finished")
})

Deno.test("exits after the grace period when a request never finishes", async () => {
  const { hooks, handlers, exits } = fakeHooks("linux")
  exitOnStop(() => new Promise(() => {}), hooks, 20)
  handlers.get("SIGINT")?.()
  await settle(60)
  expectEqual(exits.join(","), "0", "the exits")
})

Deno.test("drains once when told to stop twice", async () => {
  const { hooks, handlers, exits } = fakeHooks("linux")
  const held = heldDrain()
  exitOnStop(held.drain, hooks)
  handlers.get("SIGTERM")?.()
  handlers.get("SIGINT")?.()
  held.finish()
  await settle()
  expectEqual(held.started(), 1, "the drains started")
  expectEqual(exits.join(","), "0", "the exits")
})

Deno.test("listens for nothing on Windows, where Deno takes no SIGTERM listener", () => {
  const { hooks, handlers } = fakeHooks("windows")
  exitOnStop(() => Promise.resolve(), hooks)
  expectEqual(handlers.size, 0, "the listeners")
})
