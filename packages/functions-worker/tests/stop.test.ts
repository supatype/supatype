import { expectEqual } from "./worker-harness.ts"
import { exitOnStop, type StopHooks } from "../stop.ts"

/**
 * The worker ran as PID 1 in its container with no handler for SIGTERM, which PID 1 does not get by
 * default, so `docker restart` waited out the whole 10 s stop timeout: every self-host deploy that
 * restarted it took more than ten seconds. It exits on SIGTERM and SIGINT.
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

Deno.test("exits at once on SIGTERM and SIGINT", () => {
  const { hooks, handlers, exits } = fakeHooks("linux")
  exitOnStop(hooks)
  handlers.get("SIGTERM")?.()
  handlers.get("SIGINT")?.()
  expectEqual(exits.join(","), "0,0", "the exits")
})

Deno.test("listens for nothing on Windows, where Deno takes no SIGTERM listener", () => {
  const { hooks, handlers } = fakeHooks("windows")
  exitOnStop(hooks)
  expectEqual(handlers.size, 0, "the listeners")
})
