import { expectEqual } from "./worker-harness.ts"
import { DRAIN_GRACE_MS, exitOnStop, type StopHooks } from "../stop.ts"
import { closeTails, tailResponse } from "../logging.ts"

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
  handlers.get("SIGTERM")?.()
  await settle(60)
  expectEqual(exits.join(","), "0", "the exits")
})

// Review: Ctrl+C in dev or `functions serve` sends SIGINT and must not wait on a drain, and a second
// signal must not be ignored while one runs.
Deno.test("exits at once on SIGINT, draining nothing", () => {
  const { hooks, handlers, exits } = fakeHooks("linux")
  const held = heldDrain()
  exitOnStop(held.drain, hooks)
  handlers.get("SIGINT")?.()
  expectEqual(held.started(), 0, "the drains started")
  expectEqual(exits.join(","), "0", "the exits")
})

Deno.test("exits at once on a second SIGTERM while draining", async () => {
  const { hooks, handlers, exits } = fakeHooks("linux")
  const held = heldDrain()
  exitOnStop(held.drain, hooks, 20)
  handlers.get("SIGTERM")?.()
  handlers.get("SIGTERM")?.()
  expectEqual(held.started(), 1, "the drains started")
  expectEqual(exits.join(","), "0", "the exits on the second signal")
  held.finish()
  await settle()
})

// The process manager kills a worker 5 s after its SIGTERM, Docker 10 s after: the drain ends first.
Deno.test("drains for less than the process manager waits before it kills", () => {
  expectEqual(DRAIN_GRACE_MS < 5_000, true, "the grace under 5 s")
})

Deno.test("listens for nothing on Windows, where Deno takes no SIGTERM listener", () => {
  const { hooks, handlers } = fakeHooks("windows")
  exitOnStop(() => Promise.resolve(), hooks)
  expectEqual(handlers.size, 0, "the listeners")
})

// A log tail never ends on its own, so it held every drain for the whole grace period.
Deno.test("closes an open log tail, which would otherwise hold the drain", async () => {
  const reader = tailResponse().body!.getReader()
  closeTails()
  let chunk = await reader.read()
  while (!chunk.done) chunk = await reader.read()
  expectEqual(chunk.done, true, "the tail ended")
})
