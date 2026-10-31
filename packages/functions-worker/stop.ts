/**
 * The worker stops when it is told to. In its container it runs as PID 1, and PID 1 gets no default
 * action for SIGTERM or SIGINT: with no handler, `docker restart` and `docker stop` waited out the
 * whole stop timeout (10 s) before killing it, so every self-host deploy that restarted the worker
 * took more than ten seconds. The compose file also gives it an init (`init: true`).
 *
 * It does not exit mid-request: a deploy restarts the worker, and exiting at once cut off every
 * invocation in flight. It stops taking requests, lets those it has finish, then exits; bounded by
 * {@link DRAIN_GRACE_MS} so a request that never ends (a log tail) cannot hold it past the stop
 * timeout, where Docker would kill it anyway.
 */

/** How long in-flight requests get to finish: under Docker's 10 s stop timeout, with room to exit. */
export const DRAIN_GRACE_MS = 8_000

/** What stopping needs of Deno, replaceable in tests. */
export interface StopHooks {
  os: string
  addSignalListener(signal: "SIGTERM" | "SIGINT", handler: () => void): void
  exit(code: number): void
}

const DENO_HOOKS: StopHooks = {
  os: Deno.build.os,
  addSignalListener: (signal, handler) => Deno.addSignalListener(signal, handler),
  exit: (code) => Deno.exit(code),
}

/** `drain()`, or `graceMs`, whichever ends first; the timer is cleared either way. */
async function drainWithin(drain: () => Promise<void>, graceMs: number): Promise<void> {
  let timer: number | undefined
  const grace = new Promise<void>((done) => (timer = setTimeout(done, graceMs)))
  try {
    await Promise.race([drain().catch(() => undefined), grace])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * On SIGTERM or SIGINT, drains with `drain` (the server's `shutdown()`, which stops taking requests
 * and resolves once those in flight have finished) for at most `graceMs`, then exits 0. A second
 * signal while draining does not start another drain. Not on Windows, where Deno takes no SIGTERM
 * listener and a process is stopped some other way.
 */
export function exitOnStop(drain: () => Promise<void>, hooks: StopHooks = DENO_HOOKS, graceMs = DRAIN_GRACE_MS): void {
  if (hooks.os === "windows") return
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    void drainWithin(drain, graceMs).then(() => hooks.exit(0))
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) hooks.addSignalListener(signal, stop)
}
